# 优化实施计划

- 日期：2026-11-13
- 依据：对 `apps/api`（Go，58 文件 / 15,547 行）与 `apps/web`（React，91 文件 / 13,869 行）的完整只读审计
- 关联：[go-migration-complete.md](./go-migration-complete.md)、[rewrite-plan.md](./rewrite-plan.md)

## 一、现状判定

**后端：迁移已完成，工程质量高于「迁移中」预期。** 依赖方向单向无环，`go build` / `go vet` / `go test` 全绿（457 个 Test、12,267 行测试），出站响应体全部 `defer Close`，未发现可触达的 panic 入口。主要债务不是正确性，是**三个巨型配置文件和适配器样板**。

**前端：25 项重构计划只落地约 1/6。** 实际完成的是契约层（计划 06/08），数据层、路由化、编辑器拆分、设计令牌四个阶段（14 项）零落地。计划里那套「先建测试网再动刀」的顺序是对的，但测试网只建了地基就停了。

### 前端计划落地对照

| 阶段 | 任务 | 状态 |
|---|---|---|
| 0 测试基座 | 01 vitest 覆盖 | ⚠️ 部分：仅 `*.test.ts`，`.test.tsx` 无法被发现，无 jsdom |
| | 02 校验逻辑测试 / 03 历法测试 / 04 展示工具 / 05 图标折叠 | ❌ 全未做（`validation.ts` 387 行、历法四文件 725 行，均 0 测试） |
| 1 契约层 | 06 抽 `lib/pure` | ✅ 5 模块 + 33 用例 |
| | 07 OpenAPI codegen | ➖ 改为手写 `lib/contracts`，取舍成立 |
| | 08 契约层切换 | ✅ 34 处导入全部替换，`@homepage/domain` 引用归零 |
| 2 数据层 | 09 Query / 10 Docker Query / 11 其余端点 | ❌ 未装依赖，手写轮询仍 5 处复制 |
| 3 路由化 | 12 Router / 13 仪表盘路由 / 14 编辑器路由 / 15 features 重排 | ❌ 全未做，仍是单页 + 弹窗 |
| 4 编辑器拆分 | 16–20 | ❌ 全未做，`ServicesEditor.tsx` 从 1,540 → 1,624 行 |
| 5 设计令牌 | 21 令牌 / 22 七态 / 23 状态语义 | ⚠️ 部分：`globals.css` 已定义 status 令牌，但 `DockerSlot.tsx` 仍有 13 处硬编码 palette |
| | 24 动效响应式 / 25 收尾 | ❌ 未做 |

原计划验收指标：测试 0 → ≥80、最大文件 1,540 → ≤450、主包 → ≤280 KB。当前实测：**测试 34**、**最大文件 1,624 行**、**主包 425,906 B（gzip 125.5 KB）**。前两项在朝反方向走，第三项需先澄清口径（见 P2-3）。

### 体检实测

| 项 | 结果 |
|---|---|
| `go build ./...` / `go vet ./...` / `go test ./...` | ✅ 全绿 |
| `pnpm typecheck` / `pnpm test` | ✅ 全绿（34 用例） |
| `pnpm lint` | ❌ **本地失败**：eslint 试图解析被 gitignore 的 `.scratch/repro-write.mts`（`eslint.config.js:7` 缺 `.scratch/**`）。CI 因干净检出不受影响，但本地必挂 |
| `apps/web/dist` | ⚠️ 构建于 2026-10-06，早于源码 38 天，体积数据不代表当前代码 |
| 根目录 `packages/` | ⚠️ 已无 git 跟踪（`git ls-files packages` = 0），但 `dist/` 与 `node_modules/`（含完整 zod）仍占磁盘 |
| `docs/adr/` | ⚠️ 未跟踪，三份 ADR 未入库 |

## 二、P0：先止血（已完成 2026-11-13）

这四项都是「不改行为、风险接近零、收益立现」，且是后续所有重构的前置。**状态：四项全部完成并通过验证。**

### P0-1 修 lint 本地必挂 + 清过期忽略项 ✅

- 位置：`eslint.config.js:7-20`
- 改法：忽略列表补 `.scratch/**`；删掉已随 `ee28f09` 删除的 `docs/demos/**` 条目；补 `**/*.test.tsx` 与 `**/vitest.config.ts` 的忽略，避免组件测试改动后 lint 与 typecheck 规则打架
- 结果：`pnpm lint` 退出码 0

### P0-2 打开 `.test.tsx` 的发现能力 ✅

- 位置：`vitest.config.ts`、`apps/web/vitest.config.ts`
- 改法：改用 `test.projects` 分两个 project——`node` 跑 `*.test.ts`、`dom` 跑 `*.test.tsx`（jsdom）。原计划的 `environmentMatchGlobs` 在 vitest 3.2.4 已标记弃用，故直接换成 project 分流
- 新增 devDependency：`jsdom@^26`（`jsdom@31` 要求 Node ≥ 22.22，本机 Node 25.2.1 反而被判不兼容，降大版本才装上）、`@testing-library/react`、`@testing-library/dom`
- 结果：`DateTimeWidget.test.tsx` 三个用例被正常发现并执行；单包运行 `cd apps/web && pnpm exec vitest run` 同样识别到 dom project

### P0-3 修 `DateTimeWidget` 的伪分桶（纯 bug）✅

- 位置：`apps/web/src/components/info/DateTimeWidget.tsx:251-297`
- 问题：四个 `useMemo` 的注释写「仅在本地日历日变化时重算（故意不把 now 列入依赖）」，但依赖数组实际是 `[localDateKey, now, parsed.timezone]`，**含 `now`**。`now` 每秒由 `TICK_INTERVAL_MS = 1_000` 更换引用，于是 `lunarFromDate` / `currentSolarTerm` / `nextSolarTerm` / `nextStatutoryHolidayCountdown` 每秒各重算一次，`shichenFromDate` 同理。四处 `void localDateKey;` / `void hourBucket;` 是绕 lint 的痕迹，注释与代码相反
- 改法：依赖数组只保留分桶键，用 ref 把最新 `now` 带进 memo。四个 `useMemo` 合并为一个 `calendar`，消费点从 `lunar` / `solarTerm` 等改为解构后的同名变量，调用点无需改动。这样既保证语义（日界/时辰切换时取到当下时刻），又让同一天内不再重算
- 为何不删 `now` 依赖了事：`lunarFromDate` 等函数签名就是收 `Date`，直接删依赖会让 memo 永远返回首次渲染那一刻的结果，日界切换时农历/节气不刷新。用 ref 是唯一同时满足「不重算」与「日界准确」的形态
- 结果：新增 `DateTimeWidget.test.tsx` 三个用例锁定行为——同日每秒走时四个历法函数各调 1 次（修复前每秒各 +1）；跨整点桶只重算时辰（1 → 2），按日历法的函数不动；跨日界时按日历法恰好 +1

### P0-4 收敛 4 组前端重复实现 ✅

| 重复项 | 原副本位置 | 处理结果 |
|---|---|---|
| `formatPercent` / `formatBytes` | `services/DockerSlot.tsx:140-164` 与 `info/ResourcesWidget.tsx:114-138` 逐字相同 | 收进 `lib/format.ts`，两份定义归零 |
| `resolveErrorMessage` | 5 份副本，仅 fallback 文案不同 | 收进 `lib/format-error.ts` 并把 fallback 提为必填参数，调用点显式传 `messages.error.*` |
| `valueClass` / `barClass` | `DockerSlot.tsx` 用 `text-rose-600/amber-700`，`ResourcesWidget.tsx` 用 `text-status-danger/warning`，同一语义两种色值 | 统一为 `usageToneClass` / `usageBarClass`，走 `globals.css` 的 status 令牌。**`DockerSlot` 是偏离实现，已改回令牌** |
| `summarizeHref` / `groupHasItemErrors` / `itemHasErrors` | `ServicesEditor.tsx` 与 `BookmarksEditor.tsx` 逐字相同（仅路径前缀不同） | 收进 `lib/editor-paths.ts`，前缀提为 `root` 参数 |

- 结果：八类重复函数在 `apps/web/src` 下各只剩一处定义（复检确认 `function formatPercent` 等计数均为 1，`barClass` 为 0）
- `ServicesEditor.tsx` 1,624 → 1,517 行，`OpenMeteoWidget.tsx` 976 → 899 行；`apps/web/src` 非测试代码 13,869 → 13,781 行
- 验收：`pnpm typecheck && pnpm lint && pnpm test` 全绿，37 个用例通过
- 遗留：`DockerSlot` 的 `valueClass` 现在只是 `usageToneClass` 的一行转发，保留是给该文件内部两个调用点减少噪音；若后续该文件继续瘦身可直接内联
- 收益：净删约 120 行，并消除「同一个百分比阈值两种颜色」的既有漂移

## 三、P1：结构性优化，1–2 周

### P1-1 抽 `usePolledResource`，先不引 TanStack Query

- 现状：`DashboardPage` / `WidgetSlot` / `ProbeSlot` / `ResourcesWidget` / `OpenMeteoWidget` 五份 90% 相同的骨架，紧相关代码约 289 行，每份都手写 `hasSuccessRef`、`AbortError` 双重 instanceof、`silent && hasSuccess` 短路
- 判断：计划 09 的 Query 方案要动 `App.tsx` + 5 个槽位 + `DashboardPage` 竞态，约 1.5 周；而先抽一个共享 hook 成本 < 1 天，能吃掉 80% 的重复。**Query 留到契约层补测之后再评估**
- 改法：新建 `lib/hooks/use-polled-resource.ts`，统一 `{ load, silent, epoch, visibilitychange, interval, abort }`。`docker-status-store.tsx:70-117` 的 `mergeDockerMaps` 原样搬进 `lib/pure/docker-merge.ts`（纯函数，补 3 个用例：lite 保留 metrics、full 失败不抹徽章、`GLOBAL_ERROR_KEY` 清除）
- 验收：五个消费点行数合计下降 ≥ 30%，`mergeDockerMaps` 有测试

### P1-2 补上缺 AbortController 的两处异步

- `config-editor/ServicesEditor.tsx:1095-1123`（`DockerImportDialog.scan`）与 `config-editor/ImageAssetField.tsx:157-223`（站点图标解析 / 导入）**完全没有 signal**，60 秒超时窗口内关闭弹窗后仍会 `setState`
- 改法：接入 P1-1 的 hook 或独立 `AbortController`；组件卸载时 abort
- 验收：卸载后不再有 `setState` 警告

### P1-3 拆 `DockerImportDialog` 出 `ServicesEditor`

- 位置：`ServicesEditor.tsx:1053-1310`（258 行）整体移到 `components/config-editor/DockerImportDialog.tsx`
- 理由：这一步不动 `ServiceItemForm`（646-1051），风险最低、单文件收益最大，且顺带修掉 P1-2 的一处泄漏
- 后续（分开提交，每段独立验证）：
  1. `47-154` 纯函数与常量 → `service-model.ts`（计划 16）
  2. `184-644` 四个 Widget 表单 → `widget-forms/`，其中三处「多选字段网格」`240-259` / `333-359` / `388-414` 抽 `<CheckboxFieldGrid>`（计划 17）
  3. `646-1051` `ServiceItemForm` 按 5 个 section 拆（计划 18）
- 验收：每步后 `ServicesEditor.tsx` 行数单调下降，最终 ≤ 450

### P1-4 后端统一响应层

- 现状：三套信封并存——标准 `httpapi/errors.go:97-115`、`docker/handler.go:309-323` 手写 `writeEnvelope`（错误码是裸字符串，无 `Content-Length`）、`routes/routes.go:294` 与 `config/handler.go:154` 各包一层
- 另有一处更贵的：`routes/routes.go:280` 先 `json.Marshal` 做密钥扫描，再由 `httpapi.WriteJSON` 二次 Marshal，**每个探针/组件/天气响应都序列化两遍**（config 侧已用预序列化规避，两条路径不一致）
- 改法：`docker` 改走 `httpapi.WriteJSON`，`writeEnvelope` 并入 `errors.go`；`routes` 改为「Marshal 一次 → 扫描 → 直接写字节」
- 验收：错误码字面量从 3 处收敛到 1 处；docker 批量响应序列化次数 2 → 1

### P1-5 后端收敛 adapters 出站与错误映射

- 现状（均为逐字同构）：
  - 「GET + Header + Do + 状态检查 + 读 JSON」五份：`emby.go:230-249`、`immich.go:159-178`、`caddy.go:160-183`、`customapi.go:446-477`、`qbittorrent.go:189-200`
  - 非负数包装五份：`qbittorrent.go:251`、`transmission.go:257`、`immich.go:322`、`emby.go:466`、`caddy.go:148`
  - 字段列表四份：`emby.go:95-119` 与 `immich.go:64-88` **逐字相同**，`caddy.go:71-85` 是变体，`config/loader.go:773-785` 是第五份
  - 计数指标两份逐字相同：`qbittorrent.go:280` vs `transmission.go:281`
- 根因之一：`config.AllowList.WidgetTargets.Options` 是 `any`（`config/allowlist.go:36-41`），类型不确定被下推给每个适配器，导致 `caddy` / `emby` / `immich` 各自兜了一遍 `[]any` 与 `[]map[string]any` 双形态
- 改法：`adapters/http.go:106` 旁加 `getJSON`；`format.go:82` 附近并掉非负包装与字段列表；**优先在 config 侧把 Options 定型**，而不是让六个适配器继续防御
- 验收：净删 250–300 行，适配器测试全绿

## 四、P2：需要决策或成本较高

### P2-1 配置写回的「进程被杀即混版」缺口

- 现状：`replaceFiveFiles`（`config/write.go:237`）逐文件 rename，非事务；失败靠 `replaced` 列表回滚。**若进程在 rename 第 3 个文件时被 SIGKILL，磁盘混版且回滚代码不执行**。另 `.yaml.<pid>.tmp` 崩溃残留无人清理
- 改法：把 `docker.yaml` 排到替换顺序末尾（`loader.go:169-171` 要求端点先登记，混版仍可通过复载校验）；启动时清理残留临时文件；在替换与复载之间加 ctx 检查点（当前 `write.go:101` 只在开头查一次，持锁阻塞期间不可取消）
- 成本：中。属于可靠性加固，不是功能缺陷，可排在 P1 之后

### P2-2 `config` 包职责过宽

- `config` 目前吞了「YAML 解析 + 允许列表 + 可编辑投影 + 写回 + **HTTP handler**」，因而反向 import `httpapi`（`config/handler.go:10`）
- 改法：两个 handler 移到 httpapi 或独立 `confighttp`；`loader.go`(1,309) / `payload.go`(1,008) / `merge.go`(1,005) 按「读取规范化 / 写回载荷 / 合并」三分
- 收益：消除包方向上的别扭，写回与读取语义不再各自漂移（同一份 cityId 校验目前有四份：`loader.go:1227`、`editable.go:591`、`routes/routes.go:252`、`openmeteo.go:202`）
- 成本：中高。**建议等 P1-4 响应层收敛后再动**

### P2-3 主包体积口径先澄清再优化

- 实测：`index.js` 425,906 B / gzip 125.5 KB；`vendor-radix` 108,945 / 35.2 KB；CSS 83,489 / 12.9 KB。计划写的「415.9 KB → 280 KB」是**未压缩值**，拿 gzip 125 KB 去对 280 KB 是错的口径
- 三处真实可削点：
  1. `weather-cities.json`（20.9 KB，360 城）同时打进 `index.js` 与 `ConfigEditorShell.js` 两个 chunk（实测城市码 `101020100` 在两者中分别出现 1 次与 2 次）——单列 `vendor-data` chunk 或改按需 fetch
  2. `manualChunks` 只拆不懒加载：`vendor-radix` 是**静态 import**，`theme-toggle.tsx:9-14` 的 dropdown 完全可以懒加载
  3. `cmdk` 进主 chunk（`index.js` 含 28 处），仅 `SearchDialog` 与 `WeatherCityPicker` 使用，`SearchDialog` 可 `React.lazy` + Ctrl+K 触发
- 另有 `fetchDocker`（`lib/api/client.ts:262`）与 `http-status.ts` 整套常量（`ApiErrorCode` 9 个码 + 映射表）**全项目零引用**，仅由 barrel 转出，可删
- 建议：先重跑 `pnpm build` 拿到当前产物再定目标，口径统一用 gzip

### P2-4 组件渲染性能

- `memo` 全项目 **0 处**：`ServiceCard`、`BookmarkItem`、`InfoSection` 在每次全量重渲时无条件重跑
- Context 粒度粗：`docker-status-store.tsx:314-334` 的 `get` 依赖 `map`，每轮轮询换引用 → 所有 `DockerSlot` 消费方全量重渲，`useMemo` 完全失效
- `DashboardPage.tsx:258` 依赖 `[state]` 而非具体字段，每次 silent 刷新都重跑 `applyDocumentFavicon`（每次 `querySelectorAll` + 重建 2 个 `<link>`）
- 判断：在本项目规模（十余服务卡片）下收益有限，**排在 P1 之后**；先做依赖数组修正（零风险），`memo` 与 Context 拆分按实测决定

## 五、测试补强（与上述并行）

后端测试厚度足够（12,267 行），缺的是边界；前端是反过来的。

**后端缺口（grep 确认零覆盖）**：`mergeWidgetHeaders`(merge.go:444)、`applyLayout`(:144)、`applyBackground`(:121)、`mergeDockerSource`(:931)、`extractDiskWidget`(:974)、`pickGroupOccurrence`(:584)。其中 **`layout` 非空的合并语义完全没测**——`write_handler_test.go` 与 `write_test.go` 全部是 `"layout":[]`，唯一带值的用例是 `maxColumns:0` 的负例。`icons/iconify.go:120-134` 的上游 404 / 超时 / 超限三分类也无测试。

**前端最该补（按风险排序）**：

1. `lib/config-editor/validation.ts` 387 行 0 测试 —— `validateEditableDraft`、`prepareDraftForSave`、`dockerConnectionHasUserInfo`、`normalizeDiskDraft`。这是拆 `ServicesEditor` 时最容易被改坏的地方（计划 02）
2. `lib/{lunar,holidays,solar-terms,shichen}.ts` 合计 725 行 0 测试（计划 03）—— P0-3 那个 bug 正是无测试掩盖的
3. `lib/pure/docker-merge.ts`（P1-1 抽出后）
4. `lib/safe-link.ts:3` 的 `SAFE_LINK_TARGETS = ["_blank","_self"]` 与 `contracts/editable.ts:14` 的 `LinkTarget`（4 值）、后端 `config/values.go:160` 的 `safeTargets`（4 值）**三处不一致**：配成 `_parent` / `_top` 的条目后端接受、前端 `resolveSafeHref` 判 `unsafe_target` 变成不可点击。需要先定契约再补回归测试
5. `SHALLOW_SHAPES`（`contracts/api.ts:141-187`）其余 11 条路由 —— 目前只测了 config / version 两条。`info: { fields: {} }` 是**零校验**，而 `InfoSuccessResponse` 是两类型联合，实际靠 widget 内部的 `asOpenMeteoInfo` / `asResourcesInfo` 各自兜底

## 六、建议批次

| 批次 | 内容 | 预估 | 前置 | 完成判定 |
|---|---|---|---|---|
| 1 | P0-1 ~ P0-4（lint、vitest include、DateTimeWidget、4 组重复） | 1 天 | — | `pnpm lint` 退出码 0；新增 `.test.tsx` 可被执行；`now` 跨秒时历法不重算；五处 `formatBytes` 等重复归零 |
| 2 | 测试补强 1–2 项（validation + 历法） | 2 天 | 批次 1 | `validation.ts` 与历法四文件均有测试且覆盖 P0-3 的回归 |
| 3 | P1-1、P1-2（usePolledResource + Abort） | 2 天 | 批次 1 | 五个消费点合计行数降 ≥ 30%；卸载后无 `setState` 警告；**当日复检 7.1 触发条件** |
| 4 | P1-3 拆 `ServicesEditor`（分 4 次提交） | 4–5 天 | 批次 2、3 | `ServicesEditor.tsx` ≤ 450 行，每段有测试 |
| 5 | P1-4、P1-5（后端响应层 + adapters 收敛） | 3 天 | 可并行 | 信封实现收敛为 1 套；适配器净删 ≥ 250 行且测试全绿 |
| 6 | P2-1 写回加固、P2-3 体积口径与懒加载 | 2 天 | 批次 5 | 重跑 build 后按 gzip 重标定基线；残留临时文件可清理 |
| 7 | P2-2 config 三分（视批次 5 结果决定是否做） | 5 天 | 批次 5 | 包依赖方向无反向 import |

## 七、延后项的引入条件

「延后」指当前规模下不划算，不是不做。每项写明什么事实出现时就该改主意。

**TanStack Query** —— P1-1 抽完 `usePolledResource` 后若出现下列任一情况，说明手写层已到能力边界：同一端点被两处以上组件各自轮询；写操作后需要手动 `refresh()` 强制重拉的位置超过两处；任一槽位要求重试退避或离线队列；五个消费点合计行数降幅不足 30%（即 P1-1 本身没做成功）。这些都是代码里能数出来的事实，不需要开会决定。

**React Router** —— 出现在第二个需要独立 URL 的页面时（典型是计划 14 把配置编辑器迁出弹窗）。届时 12/13/14 三项一起做，没有路由壳时单独做任何一项都是白工。

**Zustand** —— 编辑器按 16–18 拆完后，若 draft 态仍需手动往下传超过两层，或两个面板要同步同一草稿。全局状态库这条底线不变。

**虚拟化** —— 服务分组超过 10 个或书签超过 200 条（当前远未触及）。届时优先试 CSS `content-visibility`，多数情况够用且零依赖。

**不做**：`docs/rewrite-plan.md` 与 `docs/go-migration-slice1.md` 不动——前者是历史草稿且架构设想已与实现脱节（已随 c698fe6 入库，仅作存档），后者是历史切片记录。

## 八、完工判定

整体算做完需同时满足六条，任一条不满足不得宣称优化完成：

1. `pnpm lint` / `typecheck` / `test` 与 `go build` / `vet` / `test` 在本地与 CI 双端全绿
2. 前端测试数 ≥ 80（计划原始指标），且 `validation.ts` 与历法四文件各有测试
3. `ServicesEditor.tsx` ≤ 450 行（计划原始指标），拆出的每段有对应测试
4. 后端 `layout` 非空合并语义、`iconify` 上游失败三分类有测试
5. 响应层只剩一套信封实现，`routes` 的响应序列化次数为 1
6. 主包体积以重跑 `pnpm build` 后的 gzip 实测值重新标定，不沿用 425 KB 未压缩口径

批次验收只要求该批次自身条目通过；上述六条是整体口径，用于判断何时停止本计划。

## 九、完工复核（2026-11-14）

批次 1–6 已全部落地（批次 2–5 随 c698fe6 提交，批次 6 本日补齐），按第八节六条逐项复核：

| # | 判定项 | 结果 |
|---|---|---|
| 1 | 双端 lint / typecheck / test + build / vet / test | ✅ 全绿，前端 153 用例 |
| 2 | 前端测试 ≥ 80，validation 与历法四文件有测试 | ✅ 153 用例；validation 31 例，历法四文件 46 例 |
| 3 | `ServicesEditor.tsx` ≤ 450 行 | ✅ 364 行 |
| 4 | layout 非空合并语义、iconify 上游失败三分类有测试 | ✅ `merge_test.go` 3 例；`iconify_test.go` 覆盖上游 404 / 超时 / 超限 / 异常状态 |
| 5 | 单套信封实现，routes 序列化 1 次 | ✅ `writeEnvelope` 已并入 `errors.go`，routes Marshal 一次后走 `WriteJSONBytes` |
| 6 | 主包 gzip 口径重标定 | ✅ 321 KB / **gzip 99.84 KB**（基线 425.9 KB / 125.5 KB） |

本日（批次 6）改动：

- **P0 回归修复**：`@testing-library/react` / `@testing-library/dom` 移入 `apps/web` devDependencies——此前只装在根 package.json，pnpm 依赖隔离下 `tsc` 与 eslint projectService 在 `apps/web` 内解析不到，typecheck / lint 双挂（测试从根跑所以未暴露）
- **P2-1 写回加固**：`WriteConfig` 在替换磁盘前增加第二个 ctx 取消点（此后取消只能靠回滚）；新增 `CleanupStaleTempFiles` 于启动时清理崩溃残留的 `.<file>.<pid>.tmp` / `.rollback.tmp`，含测试。`ConfigFileNames` 中 docker.yaml 本就排末位，替换顺序无需改动
- **P2-3 体积**：重跑 build 实测——weather-cities.json 已不再双打（编辑器拆分后仅存于懒加载的 ConfigEditorShell chunk；主包中的 `101020100` 只是 validation 报错文案里的示例城市码）；SearchDialog 改为首次打开才懒加载（cmdk 移出主包：raw −18.3 KB / gzip −6 KB）；vendor-radix 是弹窗、tooltip 等多组件共享的 vendor chunk，按组件拆懒加载收益有限，跳过
- **P2-4 零风险部分**：`DashboardPage` favicon effect 依赖数组由 `[state]` 改为具体字段，silent 刷新不再每次重建 `<link>`；`memo` 与 Context 拆分按计划留待实测需要
- **测试补强 4**：safe-link 窗口目标对齐后端四值契约（`_parent` / `_top` 不再判 `unsafe_target`），新增 3 例回归测试

批次 7（P2-2 config 三分）按计划保留为条件项：六条整体口径已全部满足，本计划到此完成；包方向重构待实际需要时再做。
