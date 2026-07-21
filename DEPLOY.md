# 部署说明（运行进程 / 容器视角）

## 本地开发调试

```bash
pnpm install
pnpm dev
```

- `pnpm dev` 会先构建 `domain` / `config` / `adapters`，再并行：
  1. `tsc -b --watch` 监听上述库包变更并重编到 `dist`
  2. API 开发服务（`tsx watch`，默认 `http://127.0.0.1:3000`，**不**挂载前端静态资源）
  3. Vite 前端（默认 `http://127.0.0.1:5173`，将 `/api` 代理到 API）
- 浏览器请打开 **Vite 地址**（`http://127.0.0.1:5173`），不要直接用 3000 看页面。
- 配置目录默认仓库根下 `./config`（可用环境变量 `CONFIG_DIR` 覆盖）。五文件全缺时返回空仪表盘，仍可调试 UI。
- 可选环境变量：`PORT`、`HOST`、`CONFIG_DIR`；Vite 代理目标可用 `VITE_API_PROXY_TARGET`（默认 `http://127.0.0.1:3000`）。
- 单独启动：`pnpm dev:server` / `pnpm dev:web` / `pnpm dev:packages`。

## 构建与启动（生产）

```bash
pnpm install
pnpm build
pnpm start
```

- `pnpm build` 按工作区拓扑构建 `domain` → `config` → `adapters` → `server` → `web`，前端产物输出到 `apps/web/dist`。
- `pnpm start` 仅启动已构建的 Node 生产服务（`@homepage/server`），不依赖 Vite 或其他开发服务器。
- 若 `apps/web/dist` 或其中的 `index.html` 缺失，生产启动会立即失败并输出中文错误。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CONFIG_DIR` | `./config` | 五文件配置目录（相对进程 cwd） |
| `PORT` | `3000` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址；默认允许局域网访问 |

密钥类环境变量（qBittorrent 账号密码、Emby API key、Custom API headers 等）仅通过配置中的整值 `${ENV_VAR}` 插值注入服务端，**不会**出现在浏览器配置或公开 API 响应中。

## 静态托管与路由顺序

1. 全部 `/api/*` 路由（含 API JSON 404）优先于 SPA。
2. 配置目录下的本地图标：`CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 分别映射为 `/images/*`、`/icons/*`（兼容上游 Homepage 配置写法）。配置编辑器中「选择本地图片」会上传到 `CONFIG_DIR/images/`，并返回 `/images/<filename>` 路径写入配置。
3. 存在的前端静态资源（JS/CSS/图片等）按正确 Content-Type 返回。
4. 其余非 API 路径回退到 `apps/web/dist/index.html`（SPA fallback）。

开发态（`pnpm dev`）下 Vite 会把 `/api`、`/images`、`/icons` 代理到 API 服务，因此图标文件请放在 `config/images/`（或 `config/icons/`）；浏览器上传同样走 `POST /api/assets/upload`。

## resources 资源监控语义

首期 `resources` 采集的是 **Node 运行进程或容器可见** 的 CPU、内存与磁盘路径，**不承诺**直接读取宿主机全局资源。

若需监控宿主机磁盘，请由部署者以只读方式把宿主机目录挂载到容器内路径，并在 `widgets.yaml` 中配置对应容器内路径，例如：

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
- TCP：`tcp://host:port`（如 `tcp://192.168.1.10:2375`）。
- 第一阶段仅支持容器 inspect/status 只读查询；**不支持** Docker stats，也不支持 start/stop/remove/exec 等写操作。

## 局域网访问与威胁模型

默认 `HOST=0.0.0.0`，构建启动后可通过 `http://<主机局域网IP>:3000/` 访问。

**信任模型（ADR 0002）**：凡能访问该 HTTP 端口的设备，均视为管理员——可读写配置、上传图片、触发 Icon 出站（含内网与忽略 TLS）、列出已配置 Docker 端点上的容器。服务**不**提供登录或共享 token。

部署约束：

- **不要**把端口映射到公网，或挂到不可信访客 Wi‑Fi / 未隔离网段。
- 若仅本机使用，可将 `HOST` 设为 `127.0.0.1` 并经受信反向代理暴露。
- 密钥优先用环境变量 + 配置中的 `${ENV_VAR}` 插值；避免把真实密钥写入示例文件或提交进 git。

### 配置资产路径

- 仅 `CONFIG_DIR/images/*`、`CONFIG_DIR/icons/*` 映射为 `/images/*`、`/icons/*`。
- 配置五文件（YAML）**不能**通过上述 URL 读取。
- `.svg` 资产响应带 `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`，降低「在浏览器中当文档打开并执行脚本」的风险；仪表盘仍以 `<img>` 等方式引用。

## Docker 部署

镜像发布到 Docker Hub：[`sereindusk/homepage`](https://hub.docker.com/repository/docker/sereindusk/homepage)。  
`main` 推送或打 `v*` 标签后，GitHub Actions（`.github/workflows/build-and-push.yml`）会构建 `linux/amd64` + `linux/arm64` 并推送。

### 快速启动

将 `docker/docker-compose.yml` 复制到服务器目录，并准备好同级的 `config/`（五文件 + 可选 `images/`、`icons/`），然后：

```bash
docker compose pull
docker compose up -d
```

默认访问：`http://localhost:3000`

### compose 要点

- 镜像：`sereindusk/homepage:latest`
- 端口：`3000:3000`
- 必挂：`./config:/app/config`（`CONFIG_DIR` 默认为 `/app/config`）
- 可选：只读挂载 `/var/run/docker.sock` 以查询容器状态；只读挂载宿主机根分区到 `/host` 供 `resources` 磁盘监控
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
# 常见为 100 或 1000
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
