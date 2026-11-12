// Command syncdist 把 apps/web/dist 同步到嵌入目录，供 go generate 调用。
//
// 嵌入目录必须在仓库内且由 git 跟踪，否则干净工作区无法编译；
// 前端产物本身是构建输出不入库，同步后仍按产物处理。
package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// 模块根以下的固定位置：同步目标在本模块内，产物来源在仓库根下。
const (
	targetPath = "internal/httpx/webdist"
	sourcePath = "../../apps/web/dist"
	// 占位文件：产物缺失时保证嵌入目录非空，构建照常通过
	keepFile = "placeholder.go"
	keepBody = `// Package webdist 是前端产物的嵌入目录。
// 真实产物由 go generate 从 apps/web/dist 同步而来；未同步时本包只保留占位文件，
// 服务运行期对静态请求一律返回 404。
package webdist
`
	// 忽略规则：同步产物是构建输出不入库，只留占位文件
	ignoreFile = ".gitignore"
	ignoreBody = `# 前端产物：由 go generate 从 apps/web/dist 同步，构建输出不入库，
# 目录内只保留占位文件以保证干净工作区可编译。
*
!.gitignore
!placeholder.go
`
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "同步前端产物失败：%v\n", err)
		os.Exit(1)
	}
}

// 清空同步目标后整体复制产物来源；来源不存在时只留下占位文件。
func run() error {
	root, err := findModuleRoot()
	if err != nil {
		return err
	}
	target := filepath.Join(root, filepath.FromSlash(targetPath))
	if err := resetTarget(target); err != nil {
		return err
	}

	// 产物来源相对仓库根，不在模块内
	source := filepath.Clean(filepath.Join(root, filepath.FromSlash(sourcePath)))
	if info, statErr := os.Stat(source); statErr != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "前端产物目录不存在，已跳过同步：%s\n", source)
		return writeKeepFiles(target)
	}
	if err := copyTree(source, target); err != nil {
		return err
	}
	// 忽略规则与占位文件不来自产物，同步后补写
	if err := writeKeepFiles(target); err != nil {
		return err
	}
	fmt.Printf("已同步前端产物：%s -> %s\n", source, target)
	return nil
}

// 自工作目录向上查找 go.mod，使生成命令不依赖调用时的目录。
func findModuleRoot() (string, error) {
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(current, "go.mod")); statErr == nil {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", errors.New("未找到 go.mod，无法确定模块根目录")
		}
		current = parent
	}
}

// 清空目标目录内容，只保留目录本身。
func resetTarget(target string) error {
	entries, err := os.ReadDir(target)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return os.MkdirAll(target, 0o755)
		}
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(target, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// 递归复制目录，权限与修改时间不保留。
func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		return copyFile(current, destination)
	})
}

func copyFile(source, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.Create(destination)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// 补写占位文件与忽略规则，二者缺一都会让干净工作区无法编译或把产物带进版本库。
func writeKeepFiles(target string) error {
	if err := os.WriteFile(filepath.Join(target, keepFile), []byte(keepBody), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(target, ignoreFile), []byte(ignoreBody), 0o644)
}
