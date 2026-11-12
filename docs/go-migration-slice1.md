# Go 迁移切片 1：读路径与 Docker 批量下发

- 日期：2026-11-12
- 目录：`apps/api`
- 模块：`github.com/gatecross/homepage/api`
- 定位：Node/Hono 后端向 Go 迁移的**第一条垂直切片**，只覆盖性能最关键的读路径，不追求功能完整对等。

## 一、本切片实现了什么

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 进程存活探针，返回 `{ok, service}` |
| GET | `/api/version` | 本地版本号，`updateAvailable` 恒为 `false` |
| GET | `/api/config` | 规范化配置（`ConfigJSON`） |
| GET | `/api/config/editable` | 可编辑视图，密钥字段只给 `configured`/`unset` |
| GET | `/api/docker/status` | 批量状态，**NDJSON 流式**逐条推送 |
| GET | `/api/docker/status.json` | 批量状态，一次性数组（不支持流式的客户端回退） |

### 包结构

```
apps/api/
├── cmd/homepage-api/        进程入口：装配路由、监听、优雅退出
├── internal/domain/         JSON 契约与稳定 ID
├── internal/config/         五文件加载、允许列表、快照、可编辑投影、密钥扫描
├── internal/docker/         Engine 客户端、缓存、批量扇出、NDJSON 下发
├── internal/httpapi/        中间件、错误信封、路由组装
├── internal/httpx/          前端静态产物托管与 SPA 回退
└── scripts/                 冒烟脚本
```

## 二、本切片没有实现什么

按「先把读路径跑通」的取舍，以下能力**明确缺失**，调用方需知晓：

1. **配置写回**：无 `PUT /api/config`，无 YAML 序列化回写。`Snapshot.Raw` 已保留五份文件的解析原文，为下一片写回预留。
2. **单容器查询**：`GET /api/docker/:server/:container` 与 `/containers` 均返回 JSON 404。本切片只做批量。
3. **其它数据端点**：`/api/probe`、`/api/widgets`、`/api/info`、`/api/assets/upload`、`/api/icons/*` 全部缺失。
4. **远端版本检查**：`/api/version` 不发起任何出网请求，`latestVersion`/`releaseUrl` 不返回。
5. **配置故障闸门**：TS 版 `configFaultGate` 的故障态与恢复语义未移植；加载失败时保留上一份快照并记日志。
6. **静态资产的 `CONFIG_DIR/images`、`icons` 映射**：TS 版会把配置目录下的本地图标映射成 `/images/*`，Go 版尚未接入，这些路径目前回落到 SPA 入口。
7. **按扩展名的静态 gzip 预压缩**：改为在中间件层统一协商 gzip，不缓存压缩结果。

## 三、关键设计

### 3.1 内存快照 + fsnotify

配置只在两处产生快照：启动时 `Store.Load`，以及监听触发的重新加载。

- 快照是**不可变**的：`Snapshot()` 返回指针，调用方不得修改；重新加载成功后整体原子替换，读路径用 `RWMutex` 读锁。
- 所有读端点**不读盘**：`/api/config`、`/api/config/editable` 直接投影当前快照，Docker 允许列表也按请求取自快照。
- 监听只关心五份配置文件：`settings.yaml`、`services.yaml`、`bookmarks.yaml`、`widgets.yaml`、`docker.yaml`，其它文件事件忽略。
- 去抖 200ms，合并编辑器一次保存产生的多个事件。
- **重新加载失败保留旧快照**，只记日志，不清空——避免编辑到一半的语法错误把线上配置打空。
- 首次加载失败不阻断启动：以空快照提供服务，等配置目录修好后自动恢复。

热加载已用 `scripts/smoke-reload.go` 实测：改写 `settings.yaml` 后 `/api/config` 的标题自动从「改前」变为「改后」。

### 3.2 NDJSON 流式

`/api/docker/status` 先刷出响应头，随后**每就绪一条写一行 JSON 并立即 flush**。

- 内容类型 `application/x-ndjson`，附 `X-Accel-Buffering: no` 关闭反向代理缓冲，否则流式会退化成一次性返回。
- 前端不必等全部容器查完才开始渲染，首屏徽章随到随出。
- 并发上限 12（`DefaultConcurrency`），`stats` 采样慢，设得比纯 inspect 高。
- 客户端断开（编码失败或 `ctx` 取消）立即停止后续查询，不继续打 Docker。
- 同一分桶、同一容器、同一服务名的并发查询做**去重**：后到者等前者的结果，不重复打 Engine。

一次性 `/api/docker/status.json` 复用同一条流，读完后按**服务名、容器名排序**输出，保证数组顺序稳定，便于前端复用与测试。

### 3.3 缓存分桶 + SWR

两个分桶，互不污染：

- `lite`：只有状态与健康，供 `?stats=0` 使用；
- `full`：含 CPU/内存占用。

窗口与 TS 版一致：**新鲜 12s，陈旧 45s**。

- 命中新鲜：直接返回，不打 Docker；
- 命中陈旧：**先返回旧值**，后台异步刷新（stale-while-revalidate），避免 15s 轮询反复冷启动；
- 未命中：实时查询。

`full` 查询可复用**新鲜**的 `lite` 结果，只补 `stats`，省掉一次 `inspect`。注意只有 fresh 的 lite 可复用——stale 的 lite 不可信，容器可能已经停了，此时必须重新 inspect。

`stats` 失败时降级为「无指标的 running」并且**不写缓存**，避免把降级结果当成真实的完整状态续期。

## 四、与 TS 版本的已知行为差异

1. **批量端点默认是流式**：TS 版 `/api/docker/status` 返回单个 JSON 数组；Go 版该路径返回 NDJSON，数组形态改在 `/api/docker/status.json`。前端若直接复用旧的 `fetchDockerBatch` 到 `/api/docker/status` 会解析失败，需要按内容类型分支或改指向 `.json`。
2. **无 lite→full 预热**：TS 版在 `stats=0` 响应后主动后台预热 full 缓存；Go 版未做，前端第二阶段请求可能未命中缓存。
3. **无配置故障闸门**：TS 版配置加载失败后进入故障态，特定端点返回 `CONFIG_FAULTED`；Go 版继续用旧快照正常服务。
4. **无出站探测与组件适配器**：`/api/probe`、`/api/widgets`、`/api/info` 缺失，对应前端区域会拿到 404。
5. **本地图标不托管**：`CONFIG_DIR/images/*` 与 `icons/*` 未映射，配置里写 `/images/xxx.png` 的条目会 404 或回落到 SPA。
6. **静态 gzip 策略不同**：TS 版对静态文件按扩展名预压缩并缓存；Go 版在中间件统一协商，小于 512 字节不压缩，NDJSON 整类跳过。
7. **`/api/health` 的 `service` 字段**：Go 版返回 `@homepage/api`，TS 版是 `@homepage/server`。
8. **单容器端点缺失**：`/api/docker/:server/:container` 返回 404，而非查询单个容器。

## 五、验证方式

```powershell
cd apps/api
go build ./...
go vet ./...
go test ./...
go run scripts/smoke.go          # 端点冒烟：临时配置目录 + 真实二进制
go run scripts/smoke-reload.go   # 热加载冒烟
```

冒烟脚本自建临时配置目录，把 Docker 端点指向必然拒绝连接的本机端口，用来模拟**无 Docker 环境**：此时两个批量端点都应返回 `unavailable` 而不是崩溃或 500。

## 六、下一步切片建议

按收益与依赖顺序：

1. **配置写回（`PUT /api/config`）**：`Snapshot.Raw` 已就绪，需补 YAML 序列化、字段校验、原子落盘与写入互斥。这是编辑器可用的前提，优先级最高。
2. **单容器读取端点**：补齐 `/api/docker/:server/:container` 与 `/containers`。授权函数 `AuthorizeLookup` 已实现且已测，缺的只是路由与响应组装。
3. **本地静态资产映射**：把 `CONFIG_DIR/images`、`icons` 接到 `/images/*`、`/icons/*`，否则大量现有配置的图标会失效。
4. **配置故障闸门**：补齐 `CONFIG_FAULTED` 语义，让配置彻底损坏时的失败可被前端区分。
5. **探测与组件适配器**：`/api/probe`、`/api/widgets`、`/api/info`，涉及出站 HTTP 与密钥使用，需要单独评估授权边界。
6. **补齐 lite→full 预热**：把与 TS 的差异 2 抹平。
7. **前端切换**：把 `fetchDockerBatch` 指向 `.json` 或增加 NDJSON 分支，然后灰度切流。

### 需要注意的取舍

- 本切片**不引入**除 `gopkg.in/yaml.v3` 与 `github.com/fsnotify/fsnotify` 外的任何依赖。
- 缓存与连接池都是进程内单例，多副本部署时各副本独立；这与 TS 版行为一致，本阶段不打算引入外部缓存。
- 竞态检测（`go test -race`）在 Windows 下需要 cgo 与 gcc，当前环境未安装，未纳入验证；跨平台 CI 上应补上。
