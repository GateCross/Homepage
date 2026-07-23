# 性能相关词汇（补充）

与 [CONTEXT.md](../CONTEXT.md) 领域词并列；本文件只记性能/传输层概念，避免污染配置领域模型。  
安全与信任模型术语见 CONTEXT（Config Root / Asset Root / Control Plane / LAN Trust Model A）与 [ADR 0002](./adr/0002-config-asset-roots-and-lan-trust.md)。

## Config Open Latency（配置打开延迟）

从用户点击「配置」到编辑器离开「正在加载配置」并呈现可编辑表单的时间。  
目标见 [ADR 0001](./adr/0001-config-open-latency-and-docker-fanout.md)：**< 1s**（现网同级规模、局域网）。

## Docker Fan-out（Docker 状态扇出）

前端为每个绑定了 `docker` 的服务条目单独请求状态/资源，导致请求数随容器数线性增长的模式。  
现网约 28 路，叠加每路 `stats` ~2s 与浏览器 HTTP/1.1 连接上限，是配置打开排队与 Docker 逐个冒出的主因。

## Connection Pool Starvation（连接池饿死）

浏览器对同一 origin 在 HTTP/1.1 下并行连接有限（约 6）。长耗时请求占满后，新请求（如 `GET /api/config/editable`）在客户端排队，DevTools 中表现为 Queueing/Stalled 很长，而服务端处理时间仍很短。

## Docker Stats Sampling Cost（Docker 统计采样成本）

对 running 容器调用 `GET /containers/<id>/stats?stream=0`（**不带** one-shot）时，Docker Engine 需在服务端等一个采样间隔才能返回 CPU 等指标，墙钟常达 ~1–2s。  
本项目改为 `?stream=0&one-shot=1` 即时快照，并在进程内保留上一拍 CPU 计数做差分：  
- **有上一拍**：单次 one-shot，毫秒级；  
- **冷启动无上一拍**：服务端连采两拍（间隔约 200ms）算出首包 `cpuPercent`，仍远快于 Engine 侧 ~1s 采样等待。  
批量接口另有短 TTL + stale-while-revalidate，避免 15s 轮询反复冷启动。  
与「配置 YAML 解析」无关。
