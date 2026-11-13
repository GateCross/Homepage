// Package healthcheck 是二进制自带的存活探针模式：
// 容器镜像内不装 curl/wget，健康检查直接复用自身可执行文件。
package healthcheck

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

// timeout 是单次自检的上限，超过即判为不健康。
const timeout = 5 * time.Second

// Run 请求本机 /api/health，返回进程退出码：0 健康，1 不健康。
func Run(port string) int {
	url := fmt.Sprintf("http://127.0.0.1:%s/api/health", port)

	client := &http.Client{Timeout: timeout}
	response, err := client.Get(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "健康检查失败：%v\n", err)
		return 1
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "健康检查失败：HTTP %d\n", response.StatusCode)
		return 1
	}
	return 0
}
