# ADR 0001：配置打开延迟与 Docker 状态扇出

- 状态：Accepted
- 日期：2026-07-21
- 决策者：产品（用户）+ 实现方
- 关联症状：打开配置编辑器「正在加载配置」常 ≥5s；仪表盘 Docker 状态逐个出现且周期性刷新仍慢

## 背景

用户在实例 `http://192.168.50.10:9999` 上观察到：

1. 点击「配置」后，对话框长时间停留在「正在加载配置」；
2. 首页 Docker 信息一个一个加载，体感慢。

讨论中曾提出三条方向：优化现有后端、改用数据库、后端由 Node 换成 Go。  
线上配置规模约 **37 服务 / 29 书签 / 28 个 Docker 绑定 / 17 个 HTTP 探测**，属于单机自托管仪表盘，不是多租户配置中心。

## 实测事实（2026-07-21）

| 测法 | `GET /api/config/editable` |
|------|------------------------------|
| 空闲 `curl`（无页面占用连接） | **~40–50ms**，body ~10KB |
| 服务端同时 20 路并行 Docker 查询时 `curl` | 仍 **~30ms** |
| Chromium 打开配置（页面已加载、视觉上 Docker 已出齐） | 「正在加载配置」**~3.2s** |
| 同上且撞上 Docker 15s 轮询波 | **~7.9s** |
| 浏览器 6 连接池模拟（与仪表盘风暴并发） | 用户等待 **~7.6s**，其中 **排队 ~7.5s**，服务端处理 ~65ms |

Docker 单卡：

- `GET /api/docker/:server/:container` 典型 **~2.0s**（对 running 容器额外请求 Docker `stats?stream=0` 采样）；
- 前端 [`DockerSlot`](../../apps/web/src/components/services/DockerSlot.tsx) **每卡片独立请求**，并对 running 容器 **每 15s 全量轮询**；
- 生产静态托管为 **HTTP/1.1**，无 gzip；浏览器同域并行连接约 **6** 条。

粗算：28 容器 × ~2s ÷ 6 连接 ≈ **每 15s 中约 10s** 连接池被 Docker 轮询占满。UI「看起来已安静」时，连接层仍经常繁忙——这解释了用户选择「等 Docker 出齐再点配置仍然慢」（时序 D）。

附带实现问题（次要，非 5s 主因）：

- [`getEditableConfig`](../../packages/config/src/editable/build-editable.ts) 对五文件 **读盘+解析两遍**；
- 静态资源未压缩（JS ~556KB raw，gzip 约 168KB）。

## 决策

### 采用

1. **保持 YAML 五文件为配置唯一持久化真相**（与现有 live-config-editing 一致）。不引入数据库作为配置存储。
2. **保持 Node/Hono TypeScript 后端**。不为本症状重写成 Go。
3. **产品语义选 C**：仪表盘默认仍展示每个 Docker 绑定的 **状态 + CPU/内存**（信息量与现网一致），允许通过批量、缓存、传输层与调度优化达到体感目标，而不是删掉资源指标。
4. **配置打开目标选 2**：**从点击「配置」到可编辑表单就绪 < 1s**（在常规局域网、配置规模与现网同级的前提下）。
5. **根因按「Docker 扇出 + HTTP/1.1 连接争用」治理**，而不是按「配置加载/存储引擎慢」治理。

### 明确拒绝（针对本症状）

| 方案 | 拒绝理由 |
|------|----------|
| 配置改存 SQLite/Postgres 等数据库 | editable 空闲已 40ms；DB 不减少 Docker `stats` 成本，也不解除浏览器连接池排队 |
| 为提速将后端整体换 Go | 语言不会消除「28×stats + 6 连接」模型；迁移成本与收益不匹配 |
| 用跨请求缓存 **规范化配置 / AllowList** 当作鉴权真相 | 与安全模型冲突；且不是实测瓶颈。配置仍可每请求 `loadConfig()` |
| 仅做 `getEditableConfig` 去重双读或加 YAML 缓存作为主修复 | 正确但预期体感收益 ≪ 1s，不能单独达成目标 |

### 允许的缓存边界

- **可以**缓存：Docker inspect/stats **查询结果**（短 TTL）、批量聚合响应、静态资源压缩与 HTTP 缓存头（已有 hash 资产）。
- **不可以**缓存为真相：跨请求的 AllowList、含密钥插值后的安全视图替代当次 `loadConfig()`（除非未来单独 ADR 重新定义安全模型）。

## 目标架构方向（实现约束，非本 ADR 的详细设计）

达成 C + `<1s` 的必要方向（可分阶段，顺序建议如下）：

1. **Docker 协议改为批量优先**  
   - 一次（或按 server 分片）返回本配置已登记容器的状态与资源，避免 28 条独立 HTTP 占用浏览器连接池。  
   - 服务端可对 Docker Engine 并发查询，但必须带 **并发上限 + 超时 + 短 TTL 缓存**，避免打爆 engine。

2. **stats 成本与刷新策略**  
   - 在语义 C 下仍提供 CPU/内存，但须消除「每个容器每次都同步等一轮 `stats?stream=0`」的朴素实现。  
   - 可接受手段：服务端聚合采样、短 TTL 复用、错峰刷新、首包带缓存值等。  
   - **不可接受**：为提速默认去掉 CPU/内存（那是 A，已否决）。

3. **配置请求不得被仪表盘后台饿死**  
   - 前端：打开编辑器时降低/暂停 Docker 轮询优先级，或限制后台轮询并发；editable 请求优先发出。  
   - 传输：评估 HTTP/2 或至少确保关键 API 不被长耗时请求长期占满（批量 API 是正本清源）。

4. **次要优化（锦上添花）**  
   - `getEditableConfig` 单次读盘；  
   - 静态 JS/CSS gzip/br；  
   - 编辑器路由/组件 code-split（对「已在仪表盘内点配置」帮助有限，对冷启动有用）。

## 后果

### 正面

- 修复对准真实瓶颈，避免半年级的存储/语言重写。
- 保留 YAML 手改共存、密钥不出浏览器、每请求配置鉴权等既有不变式。
- Docker 与配置打开两个症状同一套改造一起消失。

### 负面 / 成本

- 需要新的批量 Docker API 与前端槽位协议，旧的「一槽一请求」路径要兼容或迁移。
- 服务端短 TTL 缓存会使资源数字有数秒级陈旧（C 允许工程优化，产品需接受「非每瞬间实时」）。
- HTTP/2 或反代变更可能影响部署文档与镜像。

### 风险

- 若用户环境存在 **反向代理/额外鉴权** 导致空闲 `curl` 也 >1s，则本 ADR 的根因不完整，需另开网络路径调查。当前对 `192.168.50.10:9999` 的直连实测不支持该假设。

## 验收标准（与 C+2 对齐）

1. 仪表盘在默认视图下，对配置了 `docker` 的服务，仍展示运行状态及 CPU/内存（有数据时）。  
2. 在现网同级规模、局域网访问下，点击「配置」后 **1s 内** 离开「正在加载配置」并出现可编辑表单（P95 目标；允许首次冷加载 JS 另计）。  
3. 空闲时 `curl /api/config/editable` 保持亚 100ms 量级（回归：不得把慢逻辑做进该接口）。  
4. 打开配置过程中，Network 中 `editable` 的 **Queueing/Stalled** 不再稳定达到数秒。

## 参考代码

- 编辑器加载：`apps/web/src/components/config-editor/ConfigEditorShell.tsx`
- Docker 槽位与 15s 轮询：`apps/web/src/components/services/DockerSlot.tsx`
- Docker 路由（每请求 loadConfig + 单容器查询）：`packages/server/src/routes/docker.ts`
- stats 超时与路径：`packages/server/src/docker/client.ts`（`DOCKER_STATS_TIMEOUT_MS`、`stats?stream=0`）
- 可编辑配置双读：`packages/config/src/editable/build-editable.ts`（`getEditableConfig`）
- 静态无压缩：`packages/server/src/static.ts`
