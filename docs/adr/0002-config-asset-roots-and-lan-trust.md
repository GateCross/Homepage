# ADR 0002：配置资产根、内网信任模型与资源上限

- 状态：Accepted
- 日期：2026-07-21
- 决策者：产品（用户）+ 实现方
- 关联：code review（内网威胁模型重评）；[ADR 0001](./0001-config-open-latency-and-docker-fanout.md)

## 背景

单机自托管仪表盘，默认 `HOST=0.0.0.0`，局域网访问（如 `http://192.168.50.10:9999`）。  
控制面（改配置、上传、Icon Resolve/Import）**无 Caller Auth**；出站目标由每请求 `loadConfig()` 得到的 **Target AllowList** 约束。

审查中确认：

1. `tryServeConfigAsset` 将整个 **Config Root** 当作 `/images/*`、`/icons/*` 的 join 根，存在路径穿越可读 YAML 的缺陷；
2. Probe 的 `nodeTimedRequest` 全量缓冲响应体，无 `maxBytes`；
3. `CONFIG_WRITE_IN_PROGRESS` 在路由层被误映射为 `CONFIG_INVALID`（400），domain 契约已是 409；
4. SVG 上传后以 `image/svg+xml` 同源提供，直接导航打开时可执行脚本；
5. Docker 容器列表 API 返回端点上全量容器名，供「从 Docker 导入」扫描未绑定容器。

## 决策

### 1. 信任模型：LAN = 管理员（模型 A）

- 凡能访问本服务 HTTP 端口的局域网设备，视为具备完整管理能力（读仪表盘、写配置、上传、Icon 出站含内网与忽略 TLS、Docker 列表）。
- **不**引入 `HOMEPAGE_AUTH_TOKEN` 或其它 Caller Auth（本 ADR 范围内）。
- Icon Resolve 维持 CONTEXT 已有不变式：配置态、匿名、允许内网、忽略 TLS。
- 部署约束：勿将端口暴露到公网或不可信访客网；DEPLOY 须写明本威胁模型。

### 2. Config Root vs Asset Root

| 概念 | 含义 | HTTP |
|------|------|------|
| **Config Root** | `CONFIG_DIR`：五文件 YAML 及配置态数据 | **不得**经静态映射直接读 |
| **Asset Root（images）** | `CONFIG_DIR/images` | 仅 `/images/*` |
| **Asset Root（icons）** | `CONFIG_DIR/icons` | 仅 `/icons/*` |

不变式：

- `/images/<rel>` 的 join 根必须是 **images 子目录**，相对路径为去掉前缀后的 `<rel>`；`/icons/` 同理。
- `decodeURIComponent` 失败 → 不提供文件（404/null）。
- 解码后路径段不得含 `..`；`path.resolve` 后仍须落在对应 Asset Root 内。
- 上传落盘已限制在 `images/`；提供路径须与上传一致，不得回退到 Config Root。

### 3. Probe / 出站 body 上限

- 经 `nodeTimedRequest`（含 `insecureTls` 探测）读取响应体时必须有 **maxBytes**（实现默认 **1 MiB**）。
- 超限：销毁连接，不保留全量 body，向上游返回局部网络/失败语义。
- Icon 路径已有独立上限，本决策对齐「不可无限缓冲」原则，不改变 Icon 既有常量 unless 实现复用工具函数。

### 4. 配置写冲突状态码

- `CONFIG_WRITE_IN_PROGRESS` **必须**映射为 HTTP **409** + 对应 `ApiErrorCode`（使用 `createApiError`，禁止再包成 `CONFIG_INVALID`）。

### 5. SVG 策略（S2）

- **允许** 上传与 Icon Import 的 SVG。
- 经配置资产静态提供 **且** 扩展名为 `.svg` 时，响应须包含：
  - `Content-Disposition: attachment`（降低「当文档导航执行脚本」）
  - `X-Content-Type-Options: nosniff`
- `<img src>` 嵌入仍为主要展示路径；不保证所有 UA 对 attachment SVG 的 `<img>` 行为一致，若遇兼容问题可另开 ADR。

### 6. Docker 容器列表（D3）

- `GET /api/docker/:server/containers` **保持全量列表**（端点须在配置中登记）。
- 理由：配置编辑器「从 Docker 导入」依赖扫描**尚未绑定**的容器；过滤为已绑定会破坏该产品路径。
- 在模型 A 下标为 **Accepted Risk**（能进站即能看该 Docker 端点容器名）。

### 明确拒绝（本 ADR）

| 方案 | 理由 |
|------|------|
| 控制面共享密钥 / 登录（模型 B） | 产品选择 A；若未来改 B 须新 ADR 并修订 CONTEXT「匿名 Resolve」 |
| 列表 API 永久只返回已绑定容器 | 破坏「从 Docker 导入」 |
| 禁止 SVG（S1） | 产品选 S2 |
| 缓存 AllowList 跨请求作鉴权真相 | 与 ADR 0001 及现有安全模型冲突 |

## 后果

- 实现须修复 Asset Root 隔离、probe body 上限、409 映射、SVG 响应头；DEPLOY / CONTEXT 补充术语与威胁模型。
- 前端正确性项（ServiceCard 点击、Secret 初始态、safe-link 规范化、读 API 超时、Background 路径守卫）与本 ADR 正交，可同批交付但不改变本决策。
- 模型 A 下未做 Caller Auth：内网失陷或误暴露端口时攻击面仍大；缓解依赖网络边界与运维纪律。
