package config

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// 配置写回的唯一入口：读原文 → 合并 → 序列化 → 临时目录整份校验 →
// 逐文件原子替换 → 正式目录再次整份校验 → 失败按快照回滚。
// 全程持写锁，读路径同一时刻拿不到读写中的半成品。

// 写回固定中文文案。
const (
	// 回滚后仍无法加载旧配置时的故障提示。
	configFaultedMessage = "配置处于故障状态，服务已暂停配置读写。请恢复磁盘上的配置五文件后重试"
	// 保存失败（已回滚或已判定中止）的提示。
	configSaveFailedMessage = "配置保存失败，已恢复为保存前状态。请检查后重试"
)

// 快照条目：记录写回前该文件是否存在以及完整字节。
type fileSnapshotEntry struct {
	exists  bool
	content []byte
}

// 五份文件的写回前快照，用于失败回滚。
type fiveFileSnapshot map[string]fileSnapshotEntry

// 临时目录中准备好的五份文件。
type preparedFiveFiles struct {
	tempDir string
	files   map[string]string
}

// 进程内配置故障闸门：回滚失败或回滚后旧配置仍加载失败时开启，
// 只有磁盘恢复且完整加载成功才解除。
type configFaultGate struct {
	mu      sync.Mutex
	faulted bool
	reason  string
}

func (g *configFaultGate) isFaulted() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.faulted
}

func (g *configFaultGate) faultReason() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reason == "" {
		return configFaultedMessage
	}
	return g.reason
}

func (g *configFaultGate) open(reason string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.faulted = true
	g.reason = reason
}

func (g *configFaultGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.faulted = false
	g.reason = ""
}

// 尝试通过完整加载解除闸门；失败保持开启。
func (g *configFaultGate) tryRecover(dir string) bool {
	if !g.isFaulted() {
		return true
	}
	if _, err := loadConfigUnlocked(dir); err != nil {
		return false
	}
	g.close()
	return true
}

var configGate = &configFaultGate{}

// 把写回载荷合并进 dir 下的五份配置并原子替换。
// 全程持写锁；成功后返回替换后重新加载的快照，供调用方直接换上新配置，不必再读一次盘。
// 返回的错误均为可外露的中文错误：校验失败是 CONFIG_INVALID，故障态是 CONFIG_FAULTED。
func WriteConfig(ctx context.Context, dir string, payload EditableConfigWrite) (*Snapshot, error) {
	configWriteLock.lockWrite()
	defer configWriteLock.unlockWrite()

	if configGate.isFaulted() && !configGate.tryRecover(dir) {
		return nil, faultedError(configGate.faultReason())
	}
	if err := ctx.Err(); err != nil {
		return nil, &EditableConfigError{Message: "配置保存已取消"}
	}

	sources, err := readSources(dir)
	if err != nil {
		return nil, err
	}
	merged, err := MergeEditableIntoSources(payload, sources)
	if err != nil {
		return nil, err
	}

	texts, err := SerializeFiveDocuments(merged)
	if err != nil {
		return nil, err
	}

	prepared, err := prepareAndValidate(texts)
	if err != nil {
		return nil, err
	}
	defer cleanupPrepared(prepared)

	snapshot, err := snapshotFiveFiles(dir)
	if err != nil {
		return nil, err
	}

	replaced, replaceErr := replaceFiveFiles(dir, prepared)
	if replaceErr != nil {
		if rollbackErr := rollbackAndVerify(dir, snapshot, replaced); rollbackErr != nil {
			return nil, rollbackErr
		}
		return nil, saveFailedError(replaceErr)
	}

	// 正式目录再完整加载一次：既是落盘后的校验，也直接产出要装进 Store 的快照
	loaded, loadErr := loadConfigUnlocked(dir)
	if loadErr != nil {
		if rollbackErr := rollbackAndVerify(dir, snapshot, replaced); rollbackErr != nil {
			return nil, rollbackErr
		}
		return nil, saveFailedError(loadErr)
	}

	return loaded, nil
}

// 读五份原始解析树；缺失文件按空文档处理。
func readSources(dir string) (map[string]any, error) {
	sources := make(map[string]any, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				sources[name] = nil
				continue
			}
			return nil, configFileReadError(name)
		}
		value, err := decodeYAML(content)
		if err != nil {
			return nil, configFileReadError(name)
		}
		sources[name] = value
	}
	return sources, nil
}

// 配置文件读取或解析失败的固定文案。
func configFileReadError(file string) *EditableConfigError {
	return &EditableConfigError{
		Message: "配置文件 " + file + " 无法读取，保存已中止",
		File:    file,
	}
}

// 在临时目录写入五份文件并完整加载一次：语法与规范化问题在替换磁盘前暴露。
func prepareAndValidate(texts map[string]string) (*preparedFiveFiles, error) {
	tempDir, err := os.MkdirTemp("", "homepage-cfg-")
	if err != nil {
		return nil, &EditableConfigError{Message: "无法创建临时配置目录，保存已中止"}
	}

	files := make(map[string]string, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		path := filepath.Join(tempDir, name)
		if err := os.WriteFile(path, []byte(texts[name]), 0o600); err != nil {
			_ = os.RemoveAll(tempDir)
			return nil, &EditableConfigError{Message: "无法写入临时配置文件，保存已中止", File: name}
		}
		files[name] = path
	}

	if _, err := loadConfigUnlocked(tempDir); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, &EditableConfigError{Message: "配置校验失败，保存已中止"}
	}

	return &preparedFiveFiles{tempDir: tempDir, files: files}, nil
}

// 清理临时目录；清理失败不影响写回结果。
func cleanupPrepared(prepared *preparedFiveFiles) {
	if prepared == nil {
		return
	}
	_ = os.RemoveAll(prepared.tempDir)
}

// 写回前快照：记录存在状态与完整字节，回滚按此恢复。
func snapshotFiveFiles(dir string) (fiveFileSnapshot, error) {
	snapshot := make(fiveFileSnapshot, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				snapshot[name] = fileSnapshotEntry{exists: false}
				continue
			}
			return nil, &EditableConfigError{Message: "无法读取配置文件快照，保存已中止", File: name}
		}
		snapshot[name] = fileSnapshotEntry{exists: true, content: content}
	}
	return snapshot, nil
}

// 逐文件替换：先在同目录写临时文件，再原子改名覆盖目标。
// 返回已替换的文件列表，中途失败时调用方据此回滚混版。
func replaceFiveFiles(dir string, prepared *preparedFiveFiles) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, &EditableConfigError{Message: "无法创建配置目录，保存已中止"}
	}

	replaced := make([]string, 0, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(prepared.files[name])
		if err != nil {
			return replaced, &EditableConfigError{Message: "无法读取待写入的配置内容", File: name}
		}

		target := filepath.Join(dir, name)
		tempTarget := filepath.Join(dir, replaceTempName(name))
		if err := writeFileSynced(tempTarget, content); err != nil {
			removeIfExists(tempTarget)
			return replaced, &EditableConfigError{Message: "无法写入配置文件，保存已中止", File: name}
		}
		if err := os.Rename(tempTarget, target); err != nil {
			removeIfExists(tempTarget)
			return replaced, &EditableConfigError{Message: "无法替换配置文件，保存已中止", File: name}
		}
		replaced = append(replaced, name)
	}
	return replaced, nil
}

// 同目录临时文件名：带上进程号与文件名，避免并发或残留互相覆盖。
func replaceTempName(name string) string {
	return fmt.Sprintf(".%s.%d.tmp", name, os.Getpid())
}

// 写入并尽量落盘；同步失败不阻断写回。
func writeFileSynced(path string, content []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	_ = file.Sync()
	return file.Close()
}

// 清理临时文件；不存在或清理失败都可忽略。
func removeIfExists(path string) {
	_ = os.Remove(path)
}

// 回滚已替换文件：原存在的按快照字节写回，原先不存在的删除。
// 回滚失败或回滚后旧配置仍加载失败时开启故障闸门，要求人工恢复五文件。
func rollbackAndVerify(dir string, snapshot fiveFileSnapshot, replaced []string) error {
	if err := rollbackReplacedFiles(dir, snapshot, replaced); err != nil {
		configGate.open(configFaultedMessage)
		return faultedError(configFaultedMessage)
	}
	if _, err := loadConfigUnlocked(dir); err != nil {
		configGate.open("配置回滚后验证失败，已进入故障状态。请手动恢复配置五文件")
		return faultedError(configGate.faultReason())
	}
	return nil
}

// 按快照恢复；恢复失败直接上抛，由上方开启故障闸门。
func rollbackReplacedFiles(dir string, snapshot fiveFileSnapshot, replaced []string) error {
	for _, name := range replaced {
		target := filepath.Join(dir, name)
		entry := snapshot[name]

		if !entry.exists {
			// 原先不存在的文件：删除即可，本就不存在不算失败
			if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			continue
		}

		tempTarget := filepath.Join(dir, rollbackTempName(name))
		if err := writeFileSynced(tempTarget, entry.content); err != nil {
			removeIfExists(tempTarget)
			return err
		}
		if err := os.Rename(tempTarget, target); err != nil {
			removeIfExists(tempTarget)
			return err
		}
	}
	return nil
}

// 回滚用的同目录临时文件名。
func rollbackTempName(name string) string {
	return fmt.Sprintf(".%s.%d.rollback.tmp", name, os.Getpid())
}

// 保存失败的对外错误：带上出错文件便于定位。
func saveFailedError(cause error) *EditableConfigError {
	apiErr := &EditableConfigError{Message: configSaveFailedMessage}
	var configErr *EditableConfigError
	if errors.As(cause, &configErr) && configErr.File != "" {
		apiErr.File = configErr.File
	}
	return apiErr
}

// 故障态错误。
func faultedError(message string) *EditableConfigError {
	return &EditableConfigError{Message: message, Code: codeConfigFaulted}
}
