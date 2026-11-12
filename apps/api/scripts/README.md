# 冒烟脚本

两个脚本都用 `//go:build ignore` 隔离，不参与 `go build ./...` 与 `go test ./...`，需显式 `go run` 执行。

两个脚本都会自行构建被测二进制，并在退出时清理临时目录，因此**不依赖**先手工 `go build`。

## smoke.go

端到端请求全部已实现端点，断言响应形态。

```powershell
cd apps/api
go run scripts/smoke.go
```

它会在临时目录里生成一套最小配置，把 `docker.yaml` 指向 `tcp://127.0.0.1:1`（必然拒绝连接），用来模拟**没有 Docker 的环境**。此时两个批量端点都应返回 `unavailable`，而不是崩溃或 500。

覆盖内容：

- `/api/health`、`/api/version` 的 200 与字段
- `/api/config`、`/api/config/editable` 的顶层字段，并断言**不下发 Docker 连接串**
- `/api/docker/status` 逐行 JSON 合法、行数等于登记容器数、全部降级为 `unavailable`
- `/api/docker/status.json` 的数组形态与稳定排序
- `/api/docker/status?stats=0` 的轻量路径
- 未知 API 路径返回 JSON 404 而非 SPA 的 HTML

任一断言失败即非零退出，并打印服务端日志。

## smoke-reload.go

验证 fsnotify 热加载：改写 `settings.yaml` 后，`/api/config` 返回的标题应在超时内自动变化。

```powershell
cd apps/api
go run scripts/smoke-reload.go
```

## 已知限制

`go test -race` 在 Windows 下需要 cgo 与 gcc，本机未安装 gcc，因此未纳入这两个脚本。
