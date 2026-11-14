# 部署说明（运行进程 / 容器视角）

架构：**单镜像部署**。同一容器内 Go 服务仅监听内部回环 `127.0.0.1:8080`，提供 `/api` 与 `/images`、`/icons` 配置资产根；nginx 同源托管前端构建产物，并把 `/api`、`/images`、`/icons` 反代到该 Go 服务；compose 仅对外暴露 `3000 → 80`。

```
apps/api   Go 后端（cmd/homepage-api），镜像内仅含 Go 静态二进制
apps/web   React 前端，构建产物由镜像内 nginx 托管（不进 Go 二进制）
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

后端不再托管前端：直接访问 Go 端口只会得到 API 与配置资产响应，没有 UI 页面。要看 UI，请在 `apps/web` 启动 Vite dev server（5173），`/api`、`/images`、`/icons` 已由 dev 代理转发到上例的 `127.0.0.1:3000`。

## 构建与启动（生产）

生产形态为单镜像 + compose 编排：同一容器内 nginx 托管前端产物，并把 `/api`、`/images`、`/icons` 反代到同容器的 Go 服务（仅监听容器内回环 `127.0.0.1:8080`）。

```bash
# 单镜像本地构建（也可直接 docker compose build）
docker build -f docker/Dockerfile -t sereindusk/homepage:latest .

docker compose up -d
```

- 前端依赖安装与 `vite build`、Go 编译均在镜像构建阶段内完成，宿主机无需 Node / pnpm / Go 环境。
- 版本号通过 `VERSION` build-arg 注入（compose 与 CI 均取自根 package.json），未注入时 `/api/version` 返回 `0.0.0`。

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
| `PORT` | `8080` | Go 服务在容器内监听的端口（仅回环，由 nginx 同容器反代）；对外端口由 `ports` 映射（`3000:80`） |
| `HOST` | `127.0.0.1` | Go 服务监听地址；镜像默认仅回环，由 nginx 反代，无需对外暴露 |

默认值面向容器；本地运行时请显式设置 `CONFIG_DIR` 与 `HOST`。

密钥类环境变量（qBittorrent 账号密码、Emby API key、Custom API headers 等）仅通过配置中的整值 `${ENV_VAR}` 插值注入服务端，**不会**出现在浏览器配置或公开 API 响应中。缺变量时该组件显示中文 error，不整卡报错。

## 静态托管与路由顺序

静态托管分两层：nginx 托管前端产物，Go 服务 `/api` 与 `/images`、`/icons` 配置资产根；两者同容器，`/api`、`/images`、`/icons` 三个前缀由 nginx 反代到 `127.0.0.1:8080`（反代规则位于所有静态扩展名规则之前，且 `proxy_buffering off`，NDJSON/SSE 逐条推送不被缓冲）。

nginx 层职责（`docker/nginx.conf`）：

1. 前端静态资源按正确 Content-Type 返回；`/assets/` 下带内容哈希的产物用 `immutable` 长缓存，`index.html` 用 `no-cache`。
2. gzip 统一协商（对齐原 Go 中间件参数），小于 512 字节不压缩；流式类型（NDJSON/SSE）不进压缩列表。
3. 其余非反代路径回退到 `index.html`（SPA fallback）。
4. 上传与图标导入入口放宽 `client_max_body_size` 为 20m。

Go 侧语义与安全不变式保留：

1. 全部 `/api/*` 路由（含 API JSON 404）优先于静态回退。
2. 配置目录下的本地图标：`CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 分别映射为 `/images/*`、`/icons/*`。编辑器中「选择本地图片」上传到 `CONFIG_DIR/images/`，返回 `/images/<filename>` 写入配置。
3. `.svg` 响应带 `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`，由 Go 资产服务保证；nginx 对 `/assets` 与自有静态文件同样带 nosniff，`.svg`（如 `favicon.svg`）按附件处理。

**安全边界**：`/images/` 前缀下不存在的文件返回 404 而不是回落到 `index.html`；`..` 路径穿越与编码变形一律 404，配置文件本身无法通过这些 URL 读到。

## resources 资源监控语义

`resources` 采集的是 **Go 进程或容器可见** 的 CPU、内存与磁盘路径，**不承诺**直接读取宿主机全局资源。

- **CPU**：对两次采样做差分，得到真实使用率。
- **内存 / 磁盘**：读取容器可见的 `/proc/meminfo` 与 `statfs(path)`。
- 非 Linux 平台（如开发机的 macOS）走降级分支，返回 `unavailable` 与中文说明，不影响其它组件。

若需监控宿主机磁盘，请由部署者以只读方式把宿主机目录挂载到 **homepage 服务**（`resources` 由 Go 进程采集），并在 `widgets.yaml` 中配置对应容器内路径：

```yaml
# docker-compose 示例片段（挂载加在 homepage 服务下）
homepage:
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
- 若仅本机使用，可将端口映射为 `127.0.0.1:3000:80`。
- 密钥优先用环境变量 + 配置中的 `${ENV_VAR}` 插值；避免把真实密钥写入示例文件或提交进 git。

### 配置资产路径

- 仅 `CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 映射为 `/images/*`、`/icons/*`。
- 配置五文件（YAML）**不能**通过上述 URL 读取。
- `.svg` 资产响应带 `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`，降低「在浏览器中当文档打开并执行脚本」的风险。

## Docker 部署

镜像发布到 Docker Hub：[`sereindusk/homepage`](https://hub.docker.com/repository/docker/sereindusk/homepage)。

`main` 推送或打 `v*` 标签后，GitHub Actions（`.github/workflows/build-and-push.yml`）并行跑 Go（`go build/vet/test -race`）与前端（`typecheck/test/lint`）两路校验，随后 `linux/amd64` + `linux/arm64` 两个 job 并行构建单镜像并推送。package.json 版本号未变时跳过打 tag 与 Release，仅更新 `latest`。

镜像内部分三个构建阶段，运行时职责单一：

| 阶段 | 基础镜像 | 作用 |
|---|---|---|
| web 构建 | `node:22-alpine` | 装前端依赖并 `vite build` |
| api 构建 | `golang:1.27-alpine` | 静态编译 Go 二进制（`VERSION` build-arg 注入版本号） |
| 运行时 | `nginx:1.30-alpine` | nginx 托管前端产物并反代同容器 Go 二进制（以非 root 用户 `homepage` 运行）+ ca 证书 |

运行时镜像不含 Node、pnpm 与 Go 工具链。健康检查：用 `nginx:alpine` 自带的 busybox wget 经 nginx 全链路探测 `/api/version`。

### 快速启动

将 `docker/docker-compose.yml` 复制到服务器目录，并准备好同级的 `config/`（五文件 + 可选 `images/`、`icons/`），然后：

```bash
docker compose pull
docker compose up -d
```

默认访问：`http://localhost:3000`

### 部署机首次验证清单

`docker compose up -d` 后在部署机上逐条确认（端口按实际映射替换）：

```bash
# 1. 健康检查：返回 JSON，含 "ok":true
curl -s http://localhost:3000/api/health

# 2. 入口页：200 且 Content-Type 为 text/html
curl -I http://localhost:3000/

# 3. SPA 回退：任意未匹配路径返回 index.html 内容（200）
curl -s http://localhost:3000/some/deep/route

# 4. Docker 批量状态：NDJSON 流式逐条推送
curl -s -H "Accept: application/x-ndjson" http://localhost:3000/api/docker/status

# 5. 上传体积限制：大于 20m 的文件应被 413 拒绝
curl -F file=@bigfile.bin http://localhost:3000/api/assets/upload

# 6. 带哈希产物：immutable 长缓存 + gzip（需显式带 Accept-Encoding）
curl -sI -H "Accept-Encoding: gzip" http://localhost:3000/assets/<构建产物 js 文件名>

# 7. 入口 HTML：no-cache
curl -I http://localhost:3000/index.html

# 8. SVG 按附件下载
curl -I http://localhost:3000/favicon.svg
```

### compose 要点

- 镜像：`sereindusk/homepage`；`docker compose build` 可从源码本地构建
- 对外端口：`3000:80`；Go 服务只绑容器内 `127.0.0.1:8080`，由同容器 nginx 反代，不额外暴露端口
- 必挂：`./config:/app/config`（`CONFIG_DIR` 默认为 `/app/config`）
- 可选：只读挂载 `/var/run/docker.sock` 查询容器状态；只读挂载宿主机根分区到 `/host` 供 `resources` 磁盘监控
- 容器内双进程：nginx 前台 + Go 后台（`homepage` 用户），任一退出即整体退出；健康检查经 nginx 全链路探测 `/api/version`
- 密钥环境变量（如 `QBIT_PASSWORD`、`EMBY_API_KEY`）在服务 `environment` 中注入，配置 YAML 用 `${ENV_VAR}` 引用

### 从双镜像版迁移

- 镜像名变化：旧双镜像 `homepage-api` 与 `homepage-web` 冻结不再更新；现统一为 `sereindusk/homepage`（CI 中由 `DOCKERHUB_IMAGE_NAME` 派生），旧镜像仓库可在 Docker Hub 手动删除。
- compose 结构变化：原 `api` + `web` 双服务合并为单服务 `homepage`，请改用仓库内新版 `docker/docker-compose.yml`。
- 配置数据无需迁移：`./config` 挂载方式与容器内路径（`/app/config`）不变，原有五文件与 `images/`、`icons/` 原样可用。

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
# 先查 UID：docker compose exec homepage id homepage
sudo chown -R 100:100 ./config
```

改完权限后无需重建镜像，刷新页面重试导入即可。

### 本地构建镜像（可选）

见上文「构建与启动（生产）」：`docker build -f docker/Dockerfile` 产出单镜像。

### CI 密钥

仓库需配置 GitHub Secrets：

| Secret | 说明 |
|--------|------|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名（如 `sereindusk`） |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token |

可选 Variables：`DOCKERHUB_IMAGE_NAME`（默认 `homepage`），CI 据此推送 `<IMAGE_NAME>` 单镜像。
