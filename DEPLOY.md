# 部署说明（运行进程 / 容器视角）

架构：**Go 单一二进制**提供 API 与前端静态资源，前端产物在构建期嵌入二进制。

```
apps/api   Go 后端（cmd/homepage-api）
apps/web   React 前端（构建产物由 go:embed 打进二进制）
```

## 本地开发调试

需要 Go ≥ 1.27、Node ≥ 20.19、pnpm ≥ 9。

```bash
# 终端 1：前端（Vite，5173）
pnpm install
pnpm dev

# 终端 2：后端（3000，不托管前端）
pnpm start
```

- 浏览器请打开 **Vite 地址** `http://127.0.0.1:5173`，`/api`、`/images`、`/icons` 已代理到 `http://127.0.0.1:3000`。
- 后端默认读仓库根下 `./config`，可用 `CONFIG_DIR` 覆盖。五文件全缺时返回空仪表盘，仍可调试 UI。
- 前端代理目标可用 `VITE_API_PROXY_TARGET` 覆盖（默认 `http://127.0.0.1:3000`）。

### 直接跑 Go 服务

```bash
cd apps/api
CONFIG_DIR=../../config PORT=3000 go run ./cmd/homepage-api
```

改完前端想让 Go 服务托管新产物时，先 `pnpm build` 再同步：

```bash
pnpm --filter @homepage/web build
cd apps/api && go generate ./internal/httpx
```

`go generate` 把 `apps/web/dist` 复制进 `internal/httpx/webdist/`，随后编译即嵌入。该目录是构建输出，不进入版本库。

## 构建与启动（生产）

```bash
pnpm install
pnpm build          # 前端 → apps/web/dist
cd apps/api
go generate ./internal/httpx
go build -trimpath -ldflags="-s -w -X github.com/gatecross/homepage/api/internal/httpapi.Version=0.1.1" \
  -o homepage-api ./cmd/homepage-api
./homepage-api
```

- 未执行 `go generate` 时二进制仍可编译，但所有静态请求返回 404（产物目录只有占位文件）。
- 版本号通过 `-ldflags -X` 注入，未注入时 `/api/version` 返回 `0.0.0`。

### 校验

```bash
pnpm typecheck && pnpm test && pnpm lint
cd apps/api && go build ./... && go vet ./... && go test ./...
```

`apps/api/scripts/` 下另有端点冒烟脚本：

```bash
cd apps/api
go run scripts/smoke.go          # 端点冒烟：临时配置目录 + 真实二进制
go run scripts/smoke-reload.go   # 热加载冒烟
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CONFIG_DIR` | `/app/config` | 五文件配置目录 |
| `PORT` | `3000` | HTTP 端口 |
| `HOST` | 空（全部网卡） | 监听地址 |

默认值面向容器；本地运行时请显式设置 `CONFIG_DIR` 与 `HOST`。

密钥类环境变量（qBittorrent 账号密码、Emby API key、Custom API headers 等）仅通过配置中的整值 `${ENV_VAR}` 插值注入服务端，**不会**出现在浏览器配置或公开 API 响应中。缺变量时该组件显示中文 error，不整卡报错。

## 静态托管与路由顺序

1. 全部 `/api/*` 路由（含 API JSON 404）优先于 SPA。
2. 配置目录下的本地图标：`CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 分别映射为 `/images/*`、`/icons/*`。编辑器中「选择本地图片」上传到 `CONFIG_DIR/images/`，返回 `/images/<filename>` 写入配置。
3. 存在的前端静态资源按正确 Content-Type 返回；带内容哈希的文件用 `immutable` 长缓存，`index.html` 用 `no-cache`。
4. 其余非 API 路径回退到内嵌的 `index.html`（SPA fallback）。

gzip 在中间件层统一协商，小于 512 字节不压缩；NDJSON 与 SSE 端点跳过压缩。

**安全边界**：`/images/` 前缀下不存在的文件返回 404 而不是回落到 `index.html`；`..` 路径穿越与编码变形一律 404，配置文件本身无法通过这些 URL 读到。

## resources 资源监控语义

`resources` 采集的是 **Go 进程或容器可见** 的 CPU、内存与磁盘路径，**不承诺**直接读取宿主机全局资源。

- **CPU**：对两次采样做差分，得到真实使用率。
- **内存 / 磁盘**：读取容器可见的 `/proc/meminfo` 与 `statfs(path)`。
- 非 Linux 平台（如开发机的 macOS）走降级分支，返回 `unavailable` 与中文说明，不影响其它组件。

若需监控宿主机磁盘，请由部署者以只读方式把宿主机目录挂载到容器内路径，并在 `widgets.yaml` 中配置对应容器内路径：

```yaml
# docker-compose 示例片段
volumes:
  - /:/host:ro
```

```yaml
# widgets.yaml 中 resources 磁盘路径使用容器内可见路径
- resources:
    disk: /host
```

## Docker 端点

- Unix socket：`unix:///var/run/docker.sock`（仅在需要容器状态时只读挂载）。
- Plain TCP：`tcp://host:port`（如 `tcp://192.168.1.10:2375`）——**必须带端口**，缺端口不会登记，相关条目返回 403。
- TLS：`https://host:port`（如 `https://192.168.1.10:2376`）；跳过证书校验以兼容内网自签。
- 只读：容器 list / inspect / stats；**不支持** start/stop/remove/exec 等写操作，客户端对非白名单路径在拨号前即拒绝。
- 批量状态默认返回 JSON 数组；请求头含 `application/x-ndjson` 时改为流式逐条推送（带 `X-Accel-Buffering: no`）。

## 局域网访问与威胁模型

默认监听全部网卡，可通过 `http://<主机局域网IP>:3000/` 访问。

**信任模型**：凡能访问该 HTTP 端口的设备，均视为管理员——可读写配置、上传图片、触发 Icon 出站（含内网与忽略 TLS）、列出已配置 Docker 端点上的容器。服务**不**提供登录或共享 token。

部署约束：

- **不要**把端口映射到公网，或挂到不可信访客 Wi‑Fi / 未隔离网段。
- 若仅本机使用，可将 `HOST` 设为 `127.0.0.1` 并经受信反向代理暴露。
- 密钥优先用环境变量 + 配置中的 `${ENV_VAR}` 插值；避免把真实密钥写入示例文件或提交进 git。

### 配置资产路径

- 仅 `CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 映射为 `/images/*`、`/icons/*`。
- 配置五文件（YAML）**不能**通过上述 URL 读取。
- `.svg` 资产响应带 `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`，降低「在浏览器中当文档打开并执行脚本」的风险。

## Docker 部署

镜像发布到 Docker Hub：[`sereindusk/homepage`](https://hub.docker.com/repository/docker/sereindusk/homepage)。

`main` 推送或打 `v*` 标签后，GitHub Actions（`.github/workflows/build-and-push.yml`）先跑 `go build/vet/test -race` 与前端 `typecheck/test/lint`，再构建 `linux/amd64` + `linux/arm64` 并推送。

镜像采用三阶段构建：

| 阶段 | 基础镜像 | 作用 |
|---|---|---|
| `web` | `node:22-alpine` | 装前端依赖并 `vite build` |
| `api` | `golang:1.27-alpine` | 同步产物、`go generate`、静态编译 |
| `runtime` | `alpine:3.22` | 仅放二进制 + ca 证书，非 root 运行 |

最终镜像不含 Node、pnpm 与 Go 工具链。健康检查复用二进制自身的 `-healthcheck` 模式，镜像内无需 curl/wget。

### 快速启动

将 `docker/docker-compose.yml` 复制到服务器目录，并准备好同级的 `config/`（五文件 + 可选 `images/`、`icons/`），然后：

```bash
docker compose pull
docker compose up -d
```

默认访问：`http://localhost:3000`

### compose 要点

- 镜像：`sereindusk/homepage:latest`；`docker compose build` 可从源码本地构建
- 端口：`3000:3000`
- 必挂：`./config:/app/config`（`CONFIG_DIR` 默认为 `/app/config`）
- 可选：只读挂载 `/var/run/docker.sock` 查询容器状态；只读挂载宿主机根分区到 `/host` 供 `resources` 磁盘监控
- 密钥环境变量（如 `QBIT_PASSWORD`、`EMBY_API_KEY`）在 compose `environment` 中注入，配置 YAML 用 `${ENV_VAR}` 引用

### 配置目录写权限（图标导入 / 图片上传）

容器以非 root 用户 `homepage` 运行。挂载宿主机 `./config` 后，镜像内的 `chown` 会被覆盖，若宿主机目录属主是 root 且权限过严，会出现：

- `保存图标失败`（`POST /api/icons/import`）
- `上传图片失败`（`POST /api/assets/upload`）

在**宿主机**上对挂载目录授权即可（任选其一）：

```bash
# 方式 A：放宽写权限（简单）
mkdir -p ./config/images ./config/icons
chmod -R a+rwX ./config

# 方式 B：改属主为容器内 homepage 用户（更稳妥）
# 先查 UID：docker compose exec app id homepage
sudo chown -R 100:100 ./config
```

改完权限后无需重建镜像，刷新页面重试导入即可。

### 本地构建镜像（可选）

```bash
docker build -f docker/runtime.Dockerfile -t sereindusk/homepage:local .
```

### CI 密钥

仓库需配置 GitHub Secrets：

| Secret | 说明 |
|--------|------|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名（如 `sereindusk`） |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token |

可选 Variables：`DOCKERHUB_IMAGE_NAME`（默认 `homepage`）。
