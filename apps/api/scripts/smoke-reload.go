//go:build ignore

// 热加载冒烟：在临时配置目录里改写 settings.yaml，确认快照被自动替换。
// 运行方式（在 apps/api 下）：go run scripts/smoke-reload.go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const reloadWait = 15 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Printf("热加载冒烟失败：%v\n", err)
		os.Exit(1)
	}
	fmt.Println("热加载冒烟通过")
}

func run() error {
	moduleDir, err := moduleRoot()
	if err != nil {
		return err
	}
	tempDir, err := os.MkdirTemp("", "homepage-reload-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	configDir := filepath.Join(tempDir, "config")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	settingsPath := filepath.Join(configDir, "settings.yaml")
	if err := os.WriteFile(settingsPath, []byte("title: 改前\n"), 0o644); err != nil {
		return err
	}

	binaryPath := filepath.Join(tempDir, "homepage-api")
	if runtime.GOOS == "windows" {
		binaryPath += ".exe"
	}
	build := exec.Command("go", "build", "-o", binaryPath, "./cmd/homepage-api")
	build.Dir = moduleDir
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		return err
	}

	port, err := freePort()
	if err != nil {
		return err
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	logPath := filepath.Join(tempDir, "server.log")
	logHandle, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer func() { _ = logHandle.Close() }()

	process := exec.Command(binaryPath)
	process.Dir = moduleDir
	process.Env = append(os.Environ(),
		"CONFIG_DIR="+configDir,
		fmt.Sprintf("PORT=%d", port),
		"HOST=127.0.0.1",
	)
	process.Stdout = logHandle
	process.Stderr = logHandle
	if err := process.Start(); err != nil {
		return err
	}
	defer func() {
		if process.Process != nil {
			_ = process.Process.Kill()
		}
		_ = process.Wait()
	}()

	if err := waitHealthy(baseURL); err != nil {
		return err
	}

	title, err := fetchTitle(baseURL)
	if err != nil {
		return err
	}
	if title != "改前" {
		return fmt.Errorf("初始标题应为「改前」，实得 %q", title)
	}
	fmt.Printf("初始标题 %q\n", title)

	if err := os.WriteFile(settingsPath, []byte("title: 改后\n"), 0o644); err != nil {
		return err
	}

	deadline := time.Now().Add(reloadWait)
	for time.Now().Before(deadline) {
		current, err := fetchTitle(baseURL)
		if err == nil && current == "改后" {
			fmt.Printf("改写后标题 %q\n", current)
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("配置目录改写后 %s 内未观察到快照更新", reloadWait)
}

func moduleRoot() (string, error) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("无法定位脚本路径")
	}
	return filepath.Dir(filepath.Dir(sourceFile)), nil
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func waitHealthy(baseURL string) error {
	deadline := time.Now().Add(30 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	var lastErr error
	for time.Now().Before(deadline) {
		response, err := client.Get(baseURL + "/api/health")
		if err == nil {
			status := response.StatusCode
			_ = response.Body.Close()
			if status == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("健康检查返回 %d", status)
		} else {
			lastErr = err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return lastErr
}

func fetchTitle(baseURL string) (string, error) {
	response, err := http.Get(baseURL + "/api/config")
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Settings struct {
			Title string `json:"title"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	return parsed.Settings.Title, nil
}
