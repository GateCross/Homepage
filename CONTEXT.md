# Domain Glossary

本文件只记录领域词汇与不变式，不含实现细节。

## Icon（图标标识）

书签或服务条目上可选的图标引用字符串。合法形态包括：

- `mdi-*` / `si-*` 图标集标识
- 绝对 `http(s)` URL
- 本站根相对资源路径 `/images/...` 或 `/icons/...`

未设置、为空、或资源加载失败时，**不**再使用 `abbr` 或名称首字母作为视觉回退；统一显示 **Generic Icon Placeholder**。

## Generic Icon Placeholder（通用图标占位）

当条目没有可用 Icon（未配置、配置无法解析、或图片加载失败）时，仪表盘与编辑器预览使用的统一中性占位图示。书签与服务行为一致。它**不是**从目标站自动抓取的结果，也不代表「正在获取」。

## Site Icon（站点图标）

从某条目的 **Icon Source URL** 所指向的网站，按 **Site Icon Fallback Chain** 解析得到的候选图像（尚未或已经导入为本地资产）。站点图标只有在用户于配置编辑器中显式发起 **Icon Resolve** / **Icon Import** 后才会进入系统；仪表盘展示路径**不会**为缺 Icon 的条目自动出网抓取。

## Icon Source URL（取图源地址）

用于解析站点图标的 URL。规则：

- 取该 **Bookmark** 或 **Service** 条目当前表单中的 `href`（完整 URL，含路径）
- 条目无 `href`（服务允许无链接）时，不存在 Icon Source URL，**不可**发起获取
- 解析时以该完整 URL 请求页面；静态回退路径则落在其 origin 上

## Site Icon Fallback Chain（站点图标回退链）

从 Icon Source URL 发现候选时的固定优先级（先档优先，同档内按文档出现序）：

1. `apple-touch-icon`（及 `apple-touch-icon-precomposed`）
2. `rel` 含 `icon` 的 `<link>`（含 `shortcut icon` 等），取声明中的候选
3. Origin 级静态路径：`/apple-touch-icon.png`，然后 `/favicon.ico`
4. 若仍无任何合法候选 → 获取失败（由 UI 提示；条目显示仍为 Generic Icon Placeholder）

不使用 Open Graph / Twitter 图。请求不携带 Cookie 或条目上的其它凭证（匿名）。HTML 不可用（如登录墙）时仍尝试第 3 步静态路径。

## Icon Candidate（图标候选）

一次 **Icon Resolve** 返回的、可供用户挑选的单张站点图标。带有：

- 稳定的候选标识（在短时会话内有效）
- 供预览的内嵌图像数据
- 来源档位（链上的哪一环）与可选的声明尺寸/类型元数据

候选字节仅存在于服务端短时会话缓存中，**不是**持久配置资产。

## Icon Resolve（解析图标）

配置编辑器中的显式操作：给定 Icon Source URL，由 **服务端** 出网按 Site Icon Fallback Chain 收集 Icon Candidate 列表，并在响应中内嵌预览。

不变式：

- 仅配置态可触发；仪表盘只读展示不得触发
- 总是进入挑选 UI（即使仅一枚候选，也需用户确认）
- 不修改 YAML，不写入 `config/images`
- 允许访问内网/localhost；TLS 证书错误在此路径上忽略
- 仅跟随与起始 URL **同 host** 的 HTTP 重定向
- 匿名请求；超时与体积采用面向内网的宽松上限

## Icon Import（导入图标）

用户在挑选 UI 中选中某 Icon Candidate 后的显式操作：服务端从 Resolve 会话缓存取出该候选字节，写入 `config/images`，返回本站路径 `/images/...`。

不变式：

- 只更新编辑器当前表单的 `icon` 字段为该路径；**不**立即写 YAML
- 用户仍须通过既有「保存配置」流程持久化
- 缓存未命中（过期）时失败，须重新 Resolve
- 若表单已有 Icon，须先经用户确认覆盖后再 Import
- 导入的本地文件不自动删除被覆盖的旧 `/images` 文件

## Icon Fetch Session（取图会话）

一次成功 Icon Resolve 在服务端创建的短时状态：候选标识 → 图像字节。供随后的 Icon Import 使用。过期后 Import 必须失败并要求重新 Resolve。会话不是领域配置的一部分，重启可丢弃。

## Bookmark（书签）

带有必填 `href` 的外链条目，可选 Icon、可选 `abbr`、可选描述等。`abbr` 仍可存在于配置模型中，但**不参与**图标显示回退。

## Service（服务）

首页上的服务条目；`href` 可选。无 `href` 时不能 Icon Resolve。可选 Icon、探针、Docker 引用、Widget 等。无可用 Icon 时与书签相同，显示 Generic Icon Placeholder。

## Manual Icon（手动图标）

用户通过手填标识、上传图片、或 Icon Import 写入表单/配置的 Icon。与「展示期自动抓取」相对——本产品不做后者。

## Config Root（配置根）

`CONFIG_DIR` 所在目录：配置五文件 YAML 的唯一持久化位置。  
**不得**通过 HTTP 静态映射直接读取 Config Root 下的任意文件。

## Asset Root（资产根）

Config Root 下仅用于可公开读取的静态资产子目录：

- `CONFIG_DIR/images` → URL 前缀 `/images/`
- `CONFIG_DIR/icons` → URL 前缀 `/icons/`

提供文件时 join 根必须是对应 Asset Root，而不是 Config Root。路径不变式见 [ADR 0002](./docs/adr/0002-config-asset-roots-and-lan-trust.md)。

## Control Plane（控制面）

会改配置、落盘资产或触发出站副作用的操作面，包括：写配置、资源上传、Icon Resolve / Import。  
与「只读仪表盘展示」（读安全配置视图、探针/组件/Docker 状态）相对。

## Caller Auth vs Target AllowList

- **Caller Auth**：鉴别「谁在调用 HTTP API」。当前产品信任模型为局域网可达即管理员，**不**做 Caller Auth（见 ADR 0002）。
- **Target AllowList**：鉴别「服务端被允许出站访问哪些目标」（probeId / widgetId / Docker server+container 等）。每请求由 `loadConfig()` 重建，不得跨请求缓存为鉴权真相。

## LAN Trust Model A（局域网管理员模型）

能访问本服务监听端口的设备视为完整管理员。控制面匿名可用；运维须保证端口不暴露给不可信网络。

## Solar Term（节气）

二十四节气中，给定时区下「当前所处」的那一个：最近一次交节（含交节当日）的名称。用于时间卡日期区与农历并排展示（如「大暑」）。它描述的是历法位置，不是倒计时。

## Statutory Holiday（法定节日当天）

中国大陆七类法定节日的**节日当天**（元旦、春节、清明、劳动节、端午、中秋、国庆），不含调休安排或补班日。用于时间卡底部倒计时锚点；日期由算法推算（固定公历 / 农历反推 / 清明取节气），不维护国务院放假通知年表。

## China AQI（国标空气质量指数）

按 HJ 633 中国环境空气质量指数解释的无量纲整数及六档等级（优 / 良 / 轻度 / 中度 / 重度 / 严重）。天气 Info 仅在数值可确认为国标口径时提供；不得用美标 AQI 数字填充或套用国标色档。缺失时整项不展示。
