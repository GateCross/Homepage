# Go 迁移未完成项

- 日期：2026-11-13
- 关联：[go-migration-slice1.md](./go-migration-slice1.md)
- 当前状态：后端阶段 1–4 全部落地并通过测试；前端解耦与 Node 代码清理未开始。

## 一、已完成

Go 后端 `apps/api` 共 105 个文件 / 27,476 行，`go build`、`go vet`、`go test` 全绿。

| 包 | 文件 | 行数 | 测试 | 内容 |
|---|---|---|---|---|
| adapters | 21 | 6,232 | 10 | 六个组件适配器：qBittorrent、Transmission、Emby、Immich、Caddy、CustomAPI |
| config | 27 | 7,696 | 14 | 五文件加载、写回、合并、序列化、快照、图标会话之外的全部配置能力 |
| docker | 11 | 2,977 | 6 | Engine 客户端、缓存分桶、流式扇出、单容器与列表端点 |
| domain | 3 | 345 | 1 | JSON 契约与稳定 ID |
| httpapi | 10 | 2,601 | 6 | 中间件、错误信封、路由装配、版本检查 |
| httpx | 2 | 616 | 1 | 静态托管、SPA 回退、资产映射 |
| icons | 9 | 2,142 | 5 | 站点图标抓取、会话、导入 |
| probe | 2 | 474 | 1 | HTTP 探针 |
| providers | 11 | 2,085 | 4 | Open-Meteo 天气、系统资源 |
| assets | 2 | 598 | 1 | 资产上传 |
| routes | 3 | 691 | 1 | 数据端点装配 |

已注册端点：

```
GET  /api/health
GET  /api/version
GET  /api/config
GET  /api/config/editable
PUT  /api/config
POST /api/assets/upload
POST /api/icons/resolve
POST /api/icons/import
GET  /api/probe/{probeId}
GET  /api/widgets/{widgetId}
GET  /api/info/{infoId}
GET  /api/docker/status
GET  /api/docker/status.json
GET  /api/docker/{server}/containers
GET  /api/docker/{server}/{container}
```

## 二、未完成

### 2.1 前端解耦（阻塞项）

前端仍在 5 处引用 `@homepage/domain`，而该包的前端依赖尚未本地化。一旦删除 `packages/domain`，前端构建会失败。

待办：

- [ ] 建 `apps/web/src/lib/contracts/`：按域拆 `config.ts`、`editable.ts`、`api.ts`、`docker.ts`、`info.ts`、`probe.ts`，类型从 `packages/domain/src/contracts/*.ts` 逐字搬运，去掉 zod 只留 TS 类型
- [ ] 建 `apps/web/src/lib/pure/`：`grid.ts`（`resolveColumns` 与两个最小宽度常量）、`search.ts`（`matchSearch`）、`theme.ts`（`parseThemeMode`）、`url.ts`（`normalizeAbsoluteHttpUrl`、`isAbsoluteHttpUrl`）、`title.ts`（`DEFAULT_DASHBOARD_TITLE`、`normalizeTitle`）
- [ ] `ApiRoutes` 手写到 `apps/web/src/lib/api/routes.ts`；`parseApiSuccess` 改浅校验，保留 `parseErrorEnvelope`
- [ ] 替换全部 34 处类型导入，直到 `grep -r '@homepage/domain' apps/web/src` 为空
- [ ] `apps/web/package.json` 移除 `@homepage/domain`；tsconfig 去掉对应 paths
- [ ] 让根 vitest 能跑前端：新增 `apps/web/vitest.config.ts` 或在根配置加 projects
- [ ] 给 `lib/pure/` 五个模块补测试

阻塞原因：`packages/domain` 是前端唯一契约来源，必须先本地化再删包。

### 2.2 Node 代码清理（依赖 2.1）

- [ ] 删除 `packages/server/`、`packages/config/`、`packages/adapters/`、`packages/domain/`，删除后 `packages/` 为空则一并删除
- [ ] 根 `package.json`：去掉 packages 相关脚本，`dev`/`build`/`test` 只服务 `apps/web`
- [ ] `pnpm-workspace.yaml`：只留 `apps/web`
- [ ] `tsconfig.json`、`tsconfig.base.json`、`eslint.config.js`：去掉 packages 项目引用
- [ ] `vitest.config.ts`：只保留前端

### 2.3 部署与 CI（依赖 2.2）

- [ ] `.github/workflows/build-and-push.yml`：改为 Go 构建 + 前端构建
- [ ] `docker/runtime.Dockerfile`：多阶段，Go 出静态二进制、前端出 dist 后由 Go embed，最终镜像尽量小，需带 ca 证书与 `/config` 挂载点
- [ ] `docker/docker-compose.yml`：端口与卷同步
- [ ] `DEPLOY.md`、`CONTEXT.md`：按新架构更新

### 2.4 端到端验收（依赖全部）

- [ ] 用仓库真实 `config/` 启动 Go 服务，逐端点验证
- [ ] `PUT /api/config` 改标题再读回，确认持久化并还原
- [ ] 热加载：改 `settings.yaml` 不重启，`GET /api/config` 立刻反映
- [ ] `/images/` 下真实图标返回图片而不是 index.html
- [ ] `/images/../../settings.yaml` 必须 404
- [ ] 前端 `pnpm typecheck && pnpm test && pnpm build` 全绿

## 三、当前可验证的完成度

| 项 | 状态 |
|---|---|
| Go 后端功能 | ✅ 全部端点已实现 |
| Go 测试 | ✅ 全绿（约 50 个测试文件） |
| 前端构建 | ✅ 通过（仍依赖 `packages/domain`） |
| 前端独立于 Node 包 | ❌ 未完成 |
| Node 代码清理 | ❌ 未开始 |
| 部署改造 | ❌ 未开始 |
| 端到端验收 | ❌ 未开始 |

## 四、后续执行顺序

严格串行，因为每一步都依赖上一步：

```
2.1 前端解耦
  ↓
2.2 删除 Node 包
  ↓
2.3 部署与 CI
  ↓
2.4 端到端验收
```

跳过 2.1 直接删包会导致前端无法构建，这是当前唯一的硬阻塞。

## 五、已知行为差异

相对 TS 版本，Go 实现有以下差异，验收时需确认可接受：

1. `/api/docker/status` 默认返回数组 JSON（与 TS 一致）；仅当 `Accept` 含 `application/x-ndjson` 时走流式。
2. 静态 gzip 改为中间件统一协商，不缓存压缩结果；流式与 SSE 端点跳过压缩。
3. 配置加载失败时保留上一份快照继续服务，未移植 TS 的故障闸门状态机。
4. `/api/health` 的 `service` 字段为 `@homepage/api`，TS 版为 `@homepage/server`。
5. `go test -race` 未执行：Windows 需 cgo + gcc，本机无 gcc。未绕过，仍用系统默认 GOCACHE。
