# Phase 4 实施计划（2026-10-16）

依据用户已明确指定的分层实施，不替换 RealtimeSession。继续保留 16 字节设备帧封装（元信息与 PCM 分开）、16k 输入/24k 输出；Server 接受原 session.start/requestId。

1. 新建独立 server/ Node 包，仅此包依赖 ws（需要自定义 Authorization、生产 WebSocketServer 的 bounded parser，不能用 loopback Mock parser）；保留 firmware/package-lock。集中模型注册表、两套协议模板、Provider 中立接口、流式 16k→24k 重采样及安全指标。
2. API易 adapter：WSS/环境 Key、session.created→首个 update→updated ready；增量事件归一化、response ID 隔离、output_item.done/5秒取消收口、闲置断线/重建、有限重试与工具白名单接口。
3. 设备 Server：upgrade 前 token 鉴权/轮换、session.start deviceId 绑定、身份与 Persona 由服务端配置决定；复用 v1 帧、VAD 结束只做设备 ack，不重复 upstream commit；输出分片限速，防设备小缓冲溢出。Provider 错误只发统一错误并清理；提供 TLS server 或严格 loopback 开发监听。
4. 设备仅增量支持统一 error/text delta 和 transport credentials；不导入 Provider。生产时间/双工 gate 保留。新增真实 Provider Simulator sidecar、WAV 输入/流式输出文件，不改变默认 Mock。
5. 先离线行为测试，再真实文本（无 Key 明确 SKIPPED）、短 WAV（用户指定文件）、显式 Simulator。记录真实与 Mock 指标的边界，不伪造 usage。
6. 回归 npm test / realtime:test / server:test / Simulator CLI / Biome / MOD build，校对保护文件哈希，更新 CODEBASE_DOC、REALTIME_PROTOCOL、APIYI_REALTIME。

源码调查：host SNTP 仅当旧日期时校时，且 SNTP 无认证，不能因此创建“可信时间”证明；不新增假的 time-runtime。RX/TX 仍共用 I2S1/BCK34/LR33，16k/24k 风险保留。
文档依据：https://docs.apiyi.com/en/api-capabilities/realtime/overview.md （官方2026-09-14更新）；ws 官方 README/doc，经 Context7 查询。API易 Key 当前未配置。
