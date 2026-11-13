# Go 迁移收尾记录

- 日期：2026-11-13
- 关联：[go-migration-slice1.md](./go-migration-slice1.md)
- 当前状态：**迁移已完成**。Go 后端接管全部端点，Node 后端与四个 workspace 包已删除，前端契约本地化，部署与 CI 改为 Go + 前端双构建。

## 一、本期完成的四件事

### 1.1 前端解耦（原阻塞项，已解除）

前端不再依赖 `@homepage/domain`。契约与纯函数搬进 `apps/web/src/lib/`：

| 新增路径 | 内容 |
|---|---|
| `src/lib/contracts/common.ts` | `PublicError`、`Metric`、`StatusRange`、`ErrorEnvelope` |
| `src/lib/contracts/http-status.ts` | `ApiHttpStatus`、`ApiErrorCode`、错误码到状态码的映射 |
| `src/lib/contracts/config.ts` | `NormalizedConfig` 及服务/书签/布局子类型 |
| `src/lib/contracts/docker.ts` | `DockerState`、`DockerStatusResponse`、容器摘要与批量响应 |
| `src/lib/contracts/editable.ts` | 可编辑配置、密钥三态 `SecretFieldWrite`、写回请求体 |
| `src/lib/contracts/info.ts` | 天气与资源组件响应 |
| `src/lib/contracts/probe.ts` | 探测状态判别联合 |
| `src/lib/contracts/widget.ts` | 组件结果与 Emby 会话 |
| `src/lib/contracts/api.ts` | `ApiRoutes`、`ApiSuccessResponses` 路由→响应类型表、浅校验 |
| `src/lib/pure/{grid,search,theme,title,url}.ts` | 与后端同算法的前端纯函数 |

关键取舍：

- **去掉 zod，只留 TS 类型**。服务端是唯一深度校验方；前端 `parseApiSuccess` 改为**浅校验**（顶层字段存在性与类型），`parseErrorEnvelope` 保留逐字段宽松解析。这样浏览器包不再为全局 schema 付费。
- `ApiSuccessSchemas`（zod 对象表）换成 `ApiSuccessResponses`（纯类型映射表），`requestAndParseSuccess` 的返回类型由该表推导，调用点无需改动。
- 契约里的可选属性统一写成 `T | undefined`，与项目开启的 `exactOptionalPropertyTypes` 对齐。
- 34 处 `@homepage/domain` 导入全部替换；`grep -r '@homepage/domain' apps/web/src` 为空。

### 1.2 Node 代码清理

- 删除 `packages/server`、`packages/config`、`packages/adapters`、`packages/domain`，`packages/` 目录一并移除。
- 根 `package.json` 脚本收敛为只服务 `apps/web` 与 Go 后端：

```json
"typecheck": "pnpm --filter @homepage/web typecheck",
"test": "vitest run",
"build": "pnpm --filter @homepage/web build",
"dev": "pnpm --filter @homepage/web dev",
"start": "cd apps/api && go run ./cmd/homepage-api"
```

- `pnpm-workspace.yaml` 只留 `apps/*`；`tsconfig.json`、`tsconfig.eslint.json`、`eslint.config.js`、`vitest.config.ts` 去掉 packages 项目引用与别名。
- 根 `vitest.config.ts` 只跑 `apps/web/src/**/*.test.ts`；`apps/web` 另有独立 `vitest.config.ts`（带 `@/` 别名）便于单包运行。

### 1.3 前端单测

新增 6 个测试文件 / 34 个用例，覆盖 `lib/pure` 五个模块与契约浅校验：

```
apps/web/src/lib/pure/grid.test.ts        列数计算、非法入参兜底
apps/web/src/lib/pure/search.test.ts      四路命中、去重、空查询
apps/web/src/lib/pure/theme.test.ts       三态解析与非法值回落
apps/web/src/lib/pure/title.test.ts       标题规范化与默认值
apps/web/src/lib/pure/url.test.ts         URL 规范化身份串一致性
apps/web/src/lib/contracts/api.test.ts    成功体浅校验、错误信封宽松解析
```

### 1.4 部署与 CI

- `docker/runtime.Dockerfile` 改为三阶段：`node:22-alpine` 出前端产物 → `golang:1.27-alpine` 嵌产物出静态二进制 → `alpine:3.22` 仅放二进制与 ca 证书。最终镜像无 Node / pnpm / Go 工具链。
- 新增 `apps/api/internal/healthcheck/`：容器健康检查复用二进制自身的 `-healthcheck` 标志，镜像内不需要 curl/wget。
- `.github/workflows/build-and-push.yml` 新增 `verify` 作业：Go `build` / `vet` / `test -race` 与前端 `typecheck` / `test` / `lint` 全绿才进入镜像构建；构建阶段用 `build-arg VERSION` 注入版本号。
- `docker/docker-compose.yml` 补上 `build` 段，支持从源码本地构建。
- `DEPLOY.md` 按新架构重写。

## 二、验收结果

用仓库真实 `config/` 目录启动 Go 二进制，逐项实测：

| 项 | 结果 |
|---|---|
| `GET /api/health` | ✅ `{"ok":true,"service":"@homepage/api"}` |
| `GET /api/version?check=0` | ✅ 返回注入的 `0.1.1` |
| `GET /api/config` | ✅ 真实配置全量规范化输出 |
| `GET /api/config/editable` | ✅ 密钥只有 `configured`/`unset` |
| `PUT /api/config` 改标题 | ✅ 200，磁盘 YAML 同步，读回一致，已还原 |
| 热加载（改 settings.yaml 不重启） | ✅ 标题立即变化 |
| 写回非法载荷 | ✅ 422 + 字段路径，磁盘配置不受影响 |
| 并发 8 次写回 | ✅ 全部 200，串行化，终态一致 |
| Docker 连接串含 userinfo | ✅ 422 + `DOCKER_CONNECTION_SENSITIVE`，不回显原串 |
| `/images/` 真实图片 | ✅ 200 + 正确 MIME |
| `/images/` 不存在文件 | ✅ 404，不回落到 index.html |
| `/images/../../settings.yaml` | ✅ 404（含编码变形） |
| `POST /api/assets/upload` | ✅ 返回 `/images/...`，随后可正常访问 |
| `POST /api/icons/resolve` + `import` | ✅ 真实站点抓取图标并落盘 |
| `GET /api/probe/{probeId}` | ✅ 真实内网目标 `reachable` + 延迟 |
| `GET /api/info/{infoId}`（天气） | ✅ 真实数据含 AQI、日出日落、逐小时/逐日 |
| `GET /api/info/{infoId}`（资源） | ✅ macOS 上按契约返回 `unavailable` 说明 |
| `GET /api/docker/{server}/containers` | ✅ 假 Engine 下单容器摘要正确映射 |
| `GET /api/docker/status.json` | ✅ 数组形态，含 CPU/内存百分比 |
| `GET /api/docker/status` + NDJSON | ✅ `application/x-ndjson` + `X-Accel-Buffering: no` |
| `GET /api/docker/{server}/{container}` | ✅ 单容器 + 资源统计 |
| `GET /api/widgets/{widgetId}` | ✅ customapi 从真实 JSON 取值成功 |
| `GET /api/icons/iconify/{prefix}/{name}` | ✅ mdi/si 两个集合 200 + `image/svg+xml`，越权集合 404、非法名 422 |
| 密钥不泄漏 | ✅ 公开配置、组件失败文案均无明文 |
| `-healthcheck` 自检 | ✅ 健康返回 0，端口不通返回 1 |
| 前端 `typecheck` / `test` / `build` | ✅ 全绿 |
| Go `build` / `vet` / `test` | ✅ 全绿 |

## 三、验收中发现并修复的三处真实缺陷

### 3.1 Docker 容器列表被只读白名单误拒

`list.go` 请求 `/containers/json?all=true`，而 `isAllowedReadPath` 只放行不带查询的 `/containers/json`，导致 `GET /api/docker/{server}/containers` 恒返回 `EXTERNAL_FAILURE: Docker 客户端拒绝白名单外的路径`。

修复：白名单显式加入 `listAllPath`，同时补两个反向用例（`?all=false`、`?all=true&size=1` 仍必须拒绝），避免放宽成任意查询。

### 3.2 Iconify 代理整体缺失（mdi-* / si-* 图标全部不显示）

TS 版有 `GET /api/icons/iconify/:prefix/:name` 代理，前端 `ResolvedIconView` 会把 `mdi-*` / `si-*` 图标转成 `/api/icons/iconify/{mdi|simple-icons}/{name}.svg`，但 Go 版**从未实现这个路由**——请求落到 `/api` 兜底 404，浏览器拿不到 SVG，所有用图标集写法的条目退化为灰色占位。

修复：新增 `apps/api/internal/icons/iconify.go`，按 TS 语义实现——只放行 `mdi` 与 `simple-icons` 两个集合，图标名限 `[a-zA-Z0-9][a-zA-Z0-9-]*`，上游 404 映射 404、超时 504、其余 502，体积上限 256 KiB，成功响应带 `max-age=86400` 与 `nosniff` + `attachment`。因 `httpapi` 与 `icons` 存在包依赖方向（icons 引用 httpapi 的错误构造），改为通过 `Mounts.Iconify` 注入，避免 import cycle。

验证：`mdi/home.svg`、`mdi/docker.svg`、`simple-icons/qi.svg` 均返回 200 + `image/svg+xml`；`tabler/*` 404、`../` 变形 422、上游不存在 404。冒烟脚本已加 4 条断言防回归。

### 3.3 Custom API 的 mappings 类型不匹配

配置加载产出 `[]map[string]any`，而适配器 `parseCustomAPIMappings` 只接受 `[]any`，类型断言失败 → 整卡返回「mappings 必须为数组」，所有带映射的 customapi 组件全部不可用。

修复：同时接受 `[]any` 与 `[]map[string]any`（与 caddy/emby 的 `caddyStringList`/`embyFieldList` 双形态处理保持一致），并补 loader 形态的单元测试与端到端取值测试。

## 四、迁移后的死代码清理

迁移完成后按「只保留当前架构需要的」做了一轮清理，删除前均经 TypeScript 编译器（`createProgram` + 符号引用计数）与 grep 双重确认零引用。

### 4.1 前端删除

| 路径 | 行数 | 判定依据 |
|---|---|---|
| `components/config-editor/services/`（3 个组件 + barrel） | 393 | `ServicesEditor.tsx`（1624 行）已内联全部逻辑，三个子表单零引用 |
| `components/ui/index.ts` | 33 | 全仓库无 `from "@/components/ui"`，组件均按文件直接导入 |
| `components/ui/status-indicator.tsx` | 60 | 仅被上述 barrel 导出，无实际消费方 |
| `components/ui/glass-card.tsx` | 54 | 同上 |
| `components/ui/textarea.tsx` | 20 | 同上 |
| `hooks/docker-status-store.tsx` 的 `useDockerStatusStore` | 9 | 外部只用 `useOptionalDockerStatusStore` 与 `useDockerStatusEntry` |

CSS 产物由 71.37 kB 降到 69.84 kB，证实删除的组件确实进了打包。

### 4.2 前端收窄导出

以下符号只在定义文件内部使用，去掉多余的 `export`（功能不变）：`PROBE_POLL_INTERVAL_MS`、`IconImage`、`GenericIconPlaceholder`、`dockerTargetKey`、`DOCKER_BATCH_POLL_INTERVAL_MS`、`normalizeDiskDraft`、`DOCKER_USERINFO_CLIENT_MESSAGE`、`statutoryHolidaysForYear`、`resolveIconIdentifier`、`ganZhiYear`、`zodiacAnimal`、`probeUnreachableReasonText`、`isSafeLinkTarget`、`SAFE_LINK_TARGETS`、`solarTermInstantMs`、`TERM_NAMES`（并删除文件末尾的重复导出）、`IconActionButton`、`DragHandle`、`EditorKeywordTags`、`windDirectionText`。

保留 `buttonVariants` / `DialogOverlay` / `DialogPortal` 三个导出：它们是 shadcn/ui 组件的标准 API 面，删掉会让下次改 UI 又得加回来。

### 4.3 Go 删除

- `adapters.DefaultRegistry()`：无任何调用，内部各处直接用 `defaultRegistry`。

Go 侧经完整符号扫描（含私有函数）未发现其它死代码。

### 4.4 依赖与配置

| 项 | 处理 |
|---|---|
| `concurrently` | 移除。Node 后端三进程并发启动用，Go 版无此需要 |
| `tsx` | 移除。TS 后端热重载用，Go 版用 `go run` |
| `.nvmrc` | `20` → `20.19`。原值与 `engines: >=20.19.0` 及 CI 的 Node 22 不一致 |
| `.gitignore` | 补 `apps/api/homepage-api`、`*.exe`、`*.test`。原先 `go build` 的默认产物会误入版本库 |
| `.dockerignore` | 补 Go 构建产物与 `webdist`（镜像内由 `go generate` 重新同步，不该从宿主机带进去） |

### 4.5 明确保留的

- `docs/rewrite-plan.md`、`docs/demos/`：未跟踪的本地草稿，内容与当前架构无关但属于作者产物，不擅自删除。
- `docs/go-migration-slice1.md`：历史切片记录，已在文首标注「全部端点已在 go-migration-complete.md 收尾」。
- `httpx.NewStaticForTest`：测试专用构造函数，是正规的测试接缝。
- `adapters.WidgetTypes()`：只被测试使用，但它是校验「契约类型集合」的公开事实来源，保留。

## 五、仍存在的已知差异

1. `/api/health` 的 `service` 字段为 `@homepage/api`，TS 版为 `@homepage/server`。
2. 静态 gzip 改为中间件统一协商，不缓存压缩结果；流式与 SSE 端点跳过压缩。
3. **已移植**配置写回故障闸门：写回失败→回滚→回滚后旧配置仍加载失败时，`configGate` 进入故障态，后续写回返回 `CONFIG_FAULTED` 并拒绝继续改盘。与 TS 的差异仅在**读路径**：加载失败时保留上一份快照继续服务，不像 TS 那样让特定端点整体返回 `CONFIG_FAULTED`。
4. `/api/docker/status` 默认返回数组 JSON（与 TS 一致）；仅当 `Accept` 含 `application/x-ndjson` 时走流式。
5. 无 lite→full 缓存预热：TS 版在 `stats=0` 响应后后台预热 full 缓存，Go 版未做。
6. `docker.yaml` 中 `tcp://host` 缺端口不登记（与 TS 版一致）；配置成这种写法会得到 403 而不是「端点不可达」。
7. 资源采集在非 Linux 平台降级为 `unavailable`，容器内无此问题。

## 六、后续可选项（非阻塞）

- 让读路径也能表达配置损坏：当前只在写回时返回 `CONFIG_FAULTED`，读端点始终返回上一份快照或空配置，前端无法区分「空配置」与「配置坏了」。
- `stats=0` 后预热 full 缓存，抹平首屏到指标条的二次延迟。
- 在 CI 之外补一次真容器 e2e（当前验收为手动 + 假 Engine）。
