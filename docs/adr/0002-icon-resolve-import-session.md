# ADR 0002：Icon Resolve / Import 两步会话与候选挑选

- **Status:** Accepted
- **Date:** 2026-07-20
- **Depends on:** [0001-site-icon-fetch-only-in-config](0001-site-icon-fetch-only-in-config.md)

## Context

在「仅配置时获取」前提下，从站点发现的图标经常不止一枚（多尺寸 `rel=icon`、apple-touch、favicon.ico 并存）。若服务端擅自选一张落盘，用户无法纠正；若把挑选做成「有时弹有时不弹」，行为难预期。

同时需要决定：预览字节谁提供、用户点选后落盘字节从哪来，以避免前端直连目标站（CORS/自签/混合内容）以及预览与落盘内容不一致（TOCTOU）。

## Decision Drivers

- 用户对最终写入 `icon` 的图像有最终决定权
- 预览与导入必须走服务端（内网、自签、与 ADR 0001 一致）
- 不在 `config/images` 留下未采用的垃圾文件
- 不信任浏览器回传的原始字节作为唯一真源
- API 表面清晰，便于编辑器实现「总是弹出挑选」

## Considered Options

1. **单接口直接落盘**  
   服务端按链选最优一张写入 `/images` 并返回路径。

2. **Resolve 返回远程 URL，前端 `<img>` 预览，Import 再下载**  
   预览不经本站。

3. **Resolve 先把全部候选写入临时目录，Import 转正**  
   落盘早，需清理任务。

4. **Resolve + Import + 短时内存会话（本决策）**  
   Resolve 拉取候选字节，响应内嵌预览，字节留在服务端短 TTL 会话；Import 凭候选 id 从会话取字节写入 `config/images`。

## Decision Outcome

选择 **选项 4**。

### API 语义（领域级，非路径字面承诺）

1. **Icon Resolve**  
   - 输入：Icon Source URL（来自条目 `href`）  
   - 行为：按 Site Icon Fallback Chain 发现并下载候选（受超时/大小/同 host 跳转/匿名/忽略证书等约束）  
   - 输出：有序 Icon Candidate 列表；每项含会话内 `candidateId`、内嵌预览数据、档位/类型等元数据  
   - 副作用：创建/刷新 **Icon Fetch Session**（候选 id → 字节，短 TTL）；不写 YAML、不写 `config/images`

2. **Icon Import**  
   - 输入：`candidateId`（及会话关联所需标识）  
   - 行为：会话命中则将字节写入 `config/images`（命名/校验可复用上传资产规则），返回 `/images/...`  
   - 会话未命中：失败，要求重新 Resolve  
   - 不写 YAML；由编辑器把返回路径写入表单 `icon`

3. **挑选 UX**  
   - 任意次成功 Resolve 后**总是**展示挑选 UI（含仅 1 枚候选）  
   - 已有 `icon` 时，进入覆盖流程前需确认

### Positive Consequences

- 预览与导入字节同源（会话缓存），避免「看到的和保存的不是同一张」
- 未采用的候选不污染 `config/images`
- 前端不必能访问内网目标站
- 单候选也确认，降低误导入成本（可取消）

### Negative Consequences

- 两次往返；会话过期需重来
- Resolve 响应体因内嵌预览可能较大（需限制候选数量与预览尺寸/转码——属实现约束，不进 glossary）
- 多实例/无粘滞部署时会话须集中或接受失败重试（实现时处理；若单进程部署则自然成立）

## Pros and Cons of the Options

### 选项 1：单接口直接落盘

- 好：一次点击  
- 坏：用户无法在多候选中选择；与「展示给用户选择」的产品决定冲突

### 选项 2：远程 URL 预览

- 好：响应小  
- 坏：自签/内网/CORS 下预览大量失败；与服务端代理原则不一致

### 选项 3：临时目录全量下载

- 好：Import 只做 rename  
- 坏：磁盘清理、并发与崩溃残留；与现有上传目录生命周期纠缠

### 选项 4：内存会话 + 内嵌预览

- 好：真源在服务端、无临时文件、预览可靠  
- 坏：内存与 TTL 运维；响应体积

## Notes

具体路由路径、预览编码格式、TTL 秒数、最大候选数属于实现规格，可在实现票中确定，不必再开 ADR，除非偏离「会话在服务端、Import 不信任前端字节、不写临时持久文件」本决策。
