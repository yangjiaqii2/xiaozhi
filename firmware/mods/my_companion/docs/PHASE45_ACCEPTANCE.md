# Phase 4.5 验收报告

日期：2026-10-18（Asia/Shanghai）。真实调用 API易 WSS，自有 Server + RealtimeSession + Linux WAV 模拟播放；未连接 CoreS3。

原始结果：[本轮目录](results/phase45-20261017T181841Z/summary.json)。Phase 4 历史数据原样保留。

## 1. 判定与边界

已修复 Server 无上游反馈导致的容量失败、Simulator 相对定时累积漂移，以及 Qwen 已收到旧完成 ACK 后的迟到取消竞态。20/40ms × 四模型各 10 次，80 次真实短回复成功，首包均在 response.done 之前转发。E2E P50 尚未达到 1000ms，不能宣称低延迟指标已达标。没有更换默认模型、VAD、20ms 分片或设备协议。

## 2. 根因、修复与压力对比

- `server/output-stream.js:push` 原来只有 192000B 容量拒绝，没有反向流控；Provider 生成快于 48000B/s 播放节奏，长回复持续积压。历史真实失败见 Phase 4 voice-interrupt-fixed.jsonl（190080B 峰值、OUTPUT_BACKPRESSURE）。本轮先保存旧代码哈希，再复现容量错误。
- `DeviceSession.send` 的 ws.send callback 表示本地写出，不是设备收到/播放 ACK。原本把临时 socket 积压直接归为故障，也没有反馈给上游。
- 新代码保持 192000B 上限，48000/24000B 高低水位暂停/恢复实际 Provider WebSocket；本地待发送阈值 49152B，控制消息仍有发送空间。暂时堵塞保留 PCM、sequence；持续 5 秒才 OUTPUT_CONSUMER_STALLED。不可容纳的 delta 明确 OUTPUT_CAPACITY_EXCEEDED、取消并释放，绝不静默丢当前有效 PCM。
- 取消/断网 clear 队列与 timer；连接实例、turnId、sequence、cancelled response IDs、客户端 playback epoch 继续隔离旧数据。close 最多 1 秒正常握手后 terminate；取消仍有 5 秒兜底。

| 压力证据 | 输出/消费 | 队列峰值 | 失败 |
|---|---|---:|---:|
| 修复前离线复现 | 产生184320B，仅发3840B即失败；生产约2.98MB/s、目标消费48kB/s | 181440B；失败时188片；峰值约3780ms | 1 |
| 修复后确定性压力 | 完整发送1536000B，100个快速大块；模拟31980ms | 60480B / 63片 / 1260ms | 0 |

上述前后压力是离线证据，不是两次同条件真实 Provider A/B。修复后真实长回复证据另列，不混用模拟时间。

追加根因：MockAudioOutput 原来每片“回调处理完再等完整20ms”，JS晚到/文件写入开销累积后比 Server 采样时钟慢，初次真实 Flash/Plus 长回复触发 BUFFER_OVERFLOW。现改为绝对单调采样 deadline，欠载/stop 重置，显式慢消费者 playbackMs 保留；100片、每次回调晚2ms+处理3ms的回归维持约2005ms，不扩大7680B客户端缓冲。

Qwen 自动打断的账本观察到旧 output_item.done → speech_started → speech_stopped → 新 response.created。旧实现仍发送无 response ID 的 cancel，可能取消已经启动的新回复。新实现旧 ACK 已知时只使旧 ID 失效、本地收口，不再发迟到无目标 cancel；活动生成仍发送真实 cancel。失败与修复日志分别保留。

## 3. 指标定义与不可观察时刻

全部测量使用同一 Linux 进程 performance.now()，同轮以 requestId + turnId 关联。不同进程的绝对数值不能相减。

| 事件/指标 | 定义 |
|---|---|
| input_first_chunk / input_last_chunk | WAV 第一/最后一片文件 PCM 的客户端发送前时刻；最后一片不含附加VAD静音；不声称是人工声学停止时刻 |
| transport_input_last_chunk | 包括附加静音在内的最后传输片；保留该字段以免隐藏VAD等待 |
| input_commit | RealtimeSession.commitInput 调用；自动VAD仍由 Provider 决定断句 |
| provider_response_created | Adapter 收到并归一化 response.created |
| provider_first_audio_delta / server_first_audio_received | 本地收到首个合法 Provider PCM 增量；不是远端模型内部生成时刻 |
| server_first_audio_sent | OutputStream 立即发送首帧的调用时刻，不是网络送达确认 |
| simulator_first_audio_received | 客户端 runtime 收到第一片binary帧 |
| simulator_playback_scheduled / started | jitter timer 被安排 / 模拟 AudioOutput.write 被调用；不是声卡或扬声器发声 |
| response_done | 本地 Adapter 收到合法最终完成事件；节流可推迟该事件抵达 |
| output_playback_completed | finishPlayback 确认当前轮 done 且无待播放片 |
| Provider TTFA | provider_first_audio_delta - provider_response_created |
| Server转发 | server_first_audio_sent - server_first_audio_received |
| Simulator调度 | simulator_playback_started - simulator_first_audio_received |
| E2E TTFA | simulator_playback_started - input_last_chunk |
| 完整响应 / 播放完成延迟 | response_done / output_playback_completed - input_last_chunk |

远端 Provider 收到/确认的内部时刻、真实声学起止均为 null/UNVERIFIED；不会拿 input_audio_buffer.committed 的本地接收时刻假装远端生成时间。voice-interrupt 多响应场景 timeline 为 null，保留有界事件账本，不把旧/新 response 的首包与 done 混算。

measurement_version 缺省的早期样本播放结束字段是轮询观测上界，排除新口径精确播放完成统计；45.2起记录完成回调。45.3为模拟采样时钟修复，45.4包含旧ACK取消保护。80条短回复的首包测量均不受之后长回复播放时钟修正影响，保留原始版本而不覆盖。

## 4. 真实短回复对比（毫秒）

四模型各两组10次，来自每组2个WSS会话、每会话连续5轮；nearest-rank P50/P95，n=10时P95就是最大值。顺序执行、共享开发机与公网环境，不是随机化独立大样本。Qwen使用server_vad，GPT使用semantic_vad，不能据此推断单纯模型效应。

| 模型 | chunk | 成功/尝试 | Provider P50/P95 | E2E P50/P95 | Server转发P50 | Simulator调度P50 | 完整响应P50 | 队列峰值B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Qwen Flash | 20ms | 10/10 | 272.31/421.87 | 1737.23/2593.34 | 0.04 | 20.06 | 2460.71 | 60480 |
| Qwen Flash | 40ms | 10/10 | 286.38/556.38 | 1707.42/2025.94 | 0.04 | 19.84 | 2685.24 | 59520 |
| Qwen Plus | 20ms | 10/10 | 393.20/622.14 | 1816.51/2316.11 | 0.05 | 20.04 | 3694.73 | 58560 |
| Qwen Plus | 40ms | 10/10 | 397.24/602.94 | 1956.64/2234.12 | 0.03 | 19.79 | 3433.11 | 61440 |
| GPT Mini | 20ms | 10/10 | 818.03/1212.62 | 2023.90/2646.56 | 0.04 | 20.29 | 3076.18 | 62400 |
| GPT Mini | 40ms | 10/10 | 797.03/1209.64 | 2264.81/4307.34 | 0.03 | 20.00 | 3685.07 | 63360 |
| GPT 2.1 | 20ms | 10/10 | 691.89/1317.98 | 1906.34/2705.44 | 0.04 | 20.13 | 3631.16 | 62400 |
| GPT 2.1 | 40ms | 10/10 | 751.55/3143.83 | 1835.86/4551.01 | 0.03 | 20.12 | 3295.51 | 61440 |

八组永久背压失败均为0，所有成功样本 first_audio_before_done=true。临时水位触发不算故障，原始 queue.pressureCount 是每个 WS 会话累计值，不能把每轮重复累加。CPU user/system 微秒和整轮时长在原始数据中；这是Linux进程CPU，不是ESP32 CPU。音频内容没有做听感连续性/自然度人工评估，不能以零错误率替代声学评价。

保持20ms：40ms对不同模型的结果不一致，GPT Mini/Plus更慢；Flash略有改善不足以证明替代配置稳定胜出。60ms输出将超过既有1920B设备帧上限，未为测试修改协议。

Server首帧转发通常远低于1ms，Simulator jitter约20ms；移除它最多解释约20ms，解释不了当前1.7～2.0秒的E2E。输入结束到自动断句/response.created的等待占主要部分。没有通过缩短VAD静音掩盖打断问题，没有证明某个代码优化造成Provider TTFA改善；相比Phase4的差值只作观察，不能当因果A/B。

## 5. 真实长回复与完整性

| 模型 | 完成 | Provider/Device/Playback字节数 | 队列峰值B | 客户端峰值B | 临时水位次数 |
|---|---|---|---:|---:|---:|
| Qwen Flash | PASS | 1248000/1248000/1248000 | 54720 | 1920 | 39 |
| Qwen Plus | PASS | 1520640/1520640/1520640 | 54720 | 1920 | 48 |
| GPT Mini | PASS | 880800/880800/880800 | 72960 | 1922 | 22 |
| GPT 2.1 | PASS | 1142400/1142400/1142400 | 72960 | 1922 | 29 |

另作Flash增量SHA256完整性校验：输出 441600B；Provider/device/playback 摘要相同：True。原始JSON保存摘要，无需缓存整段音频。其他没有摘要的样本只能证明字节数相等，不能声称逐字节内容相等。

初次测试保留的25秒工具超时不是自动判为Provider故障：部分长回复超过预算；复验显式设60秒（工具上限），生产timeout、播放timeout、VAD均没放宽。若超时仍明确保留FAIL，不追加无限重试。

## 6. 真实自动打断、显式取消与重连

| 模型 | 自动打断后续聊 | 本地stop调用延迟ms | 旧音频泄漏B | 收口 | 显式wire取消/ACK | 强制断连恢复ms | 模拟WiFi恢复ms |
|---|---|---:|---:|---|---|---:|---:|
| Qwen Flash | PASS | 0.05 | 0 | output_item.done_before_cancel | PASS / output_item.done | 2848.27 | 2116.45 |
| Qwen Plus | PASS | 0.08 | 0 | output_item.done_before_cancel | PASS / output_item.done | 2838.04 | 1798.89 |
| GPT Mini | PASS | 0.07 | 0 | output_item.done | PASS / output_item.done | 2730.77 | 1983.99 |
| GPT 2.1 | PASS | 0.04 | 0 | output_item.done | PASS / output_item.done | 2639.31 | 1991.64 |

本地stop调用延迟不等于声学停止；从注入第二段用户PCM到Provider VAD检测，可能还包含网络、服务端判断及TCP队首阻塞。详细 user_barge_input_start / interrupt_detected / speaker_stop / response_cancel_wire / output_item_done / cancel_ack / events 在各 JSON 中。已确认旧ACK的自动取消分支不发无目标wire cancel，RTT为null；显式主动打断仍真正发cancel。新response创建可能先于本地interrupt回调，此时旧 new_turn_started 字段可能null，可查事件账本，不能填造的时刻。

强制断连与模拟网络断开均检查 session_changed、session_reconfigured；新实例重放 voice/VAD/audio session.update。原有 Server 最多2次重试、指数250/500ms退避；Simulator连接重试最多2次、1～2秒退避；生产配置保持原值。真实API 5xx无法主动制造，本地拒绝/连接超时/有限重试/旧连接迟到事件隔离属于离线回归，不冒充真实API错误注入。真实迟到包若未出现，不能声称观察到了它；离线测试实际注入旧包验证丢弃。

## 7. 调用、usage与成本

保存的真实音频试验：短回复 80 次 + 专项 30 次 = 110 次；专项失败 9 次（保留初次溢出、工具超时和诊断失败，复验另存）。这不是账单API计费请求数：一次打断试验可能产生两次 response，连接还可能重试。早期样本没有完整连接尝试计数，不能凭成功次数反推费用；后续 provider_connection_attempts 记录当前试验进程的实际 socketFactory 调用累计数。

| 模型（20ms组，10次usage求和） | Audio In | Audio Out | Text In | Text Out | Cached |
|---|---:|---:|---:|---:|---:|
| Qwen Flash | 560 | 172 | 5240 | 90 | null |
| Qwen Plus | 560 | 300 | 5300 | 120 | null |
| GPT Mini | 708 | 348 | 692 | 560 | 768 |
| GPT 2.1 | 708 | 460 | 716 | 445 | 512 |

仅汇总Provider实际返回字段；缺失cached仍null，不换算为0，不推算人民币/美元费用。完整80条usage及专项可得usage留在JSON，取消没有最终usage时保留null。真实模型只使用上述四个，未fallback Mock；合成中文WAV来自已有espeak测试文件，不是人工麦克风录音。

## 8. 验证与产物

| 检查 | 结果 |
|---|---|
| npm test | 552通过：404 unit + 99 simulator + 49 server |
| npm run realtime:test | 37通过 |
| npm run server:test | 49通过 |
| npm run simulator | s/q 手动输入启动、显示状态、正常释放并退出 |
| Biome check companion / npm run lint / npm run format | PASS；lint保留原有host空constructor提示（info） |
| git diff --check | PASS |
| 受保护文件 | 见hash-check.json；host、原package-lock/package、Phase4历史、Companion及设备流协议等与开始时SHA256一致 |
| 密钥扫描 | 见key-scan.json；Git可见文件与MOD产物不包含已配置实际Key；只输出命中路径/行号，不输出内容 |
| MOD | BUILD SUCCESS，退出0 |

产物：`dist/bin/esp32/debug/my_companion/my_companion.xsa`；68493B；SHA256 `19d8f37c26da84cc4509651549c918f47954846a2a03fe1f3ce4cb6b2306bee1`。编译不等同真机通过。测试/构建/红绿日志保存在本轮结果目录。

## 9. 修改文件

| 文件 | 原因 |
|---|---|
| server/output-stream.js | 有界反馈、临时背压等待、超时、统计和采样期限 |
| server/device-session.js | 反馈绑定、数字日志、明确取消清理 |
| server/providers/apiyi/apiyi-realtime-provider.js | 接收节流、正常close兜底、旧ACK取消竞态 |
| server/acceptance.js | 单调事件、按轮追踪、实际wire cancel、60秒受限验收预算、增量hash |
| server/tools/benchmark-phase45.py、summarize-phase45.py（新增） | 显式真实调用与可复算汇总 |
| server/tests/flow-control.test.js、flow-wire.test.js（新增） | 有界流控与真实本地WS压力 |
| server/tests/relay.test.js、provider.test.js | 容量/慢消费者清理、压力断网新会话、旧ACK取消回归 |
| simulator/mock-audio-output.js | 消除模拟相对时钟累积漂移；保留慢消费者配置 |
| simulator/tests/audio-clock.test.js（新增） | 单调播放时钟与慢消费回归 |
| hardware/diagnostics.js、simulator/tests/diagnostics.test.js（新增） | 只读、无音频任务诊断 |
| mod.js、manifest.json | 注册诊断模块及Drawer手动入口 |
| CODEBASE_DOC.md、APIYI_REALTIME.md、REALTIME_PROTOCOL.md、本报告与新results | 同步边界、证据和实测 |

没有修改host、SDK、ESP-IDF、原始AudioIn/AudioOut C、Companion、真实audio adapter、设备协议或默认分片/模型/VAD，也没有提交、reset、checkout或覆盖原package-lock修改。起始Git状态与保护哈希见 git-status.txt / baseline-hashes.json。

## 10. 剩余缺口与CoreS3操作步骤

可以开始“带安全门控的只读真机诊断准备”，不能视作全双工实时语音已经具备硬件验收条件。

- CoreS3 Microphone / Speaker / I2S Full Duplex / Real Wi-Fi / TLS/CA / Device Clock / Real CoreS3 E2E 全部 UNVERIFIED。
- TLS Node真实API连接成功只证明Linux CA/时间链路。生产TIME_UNVERIFIED与AUDIO_DUPLEX_UNVERIFIED均未解除。
- 只读Drawer诊断报告源码版本与预期板型，不假装探测出实体板；WiFi读取真实WiFiController状态，麦克风读取host真实recording，空闲不能证明初始化成功。Speaker未运行返回UNKNOWN，Realtime未注入返回UNKNOWN。
- SDK/板级配置仍为RX/TX同I2S1、BCK34/LR33，输入16k、输出24k；独立native RX/TX创建与共享时钟兼容性没有证明。不得凭编译通过直接设duplexValidated=true。
- TCP pause会延迟同连接VAD/控制消息，不能保证自动打断的网络检测时间；实际设备消费credit不在现有协议中，任意慢DAC只靠socket水位不能证明安全。维持客户端有界缓冲与失败隔离。

设备到手后按顺序：

1. 刷入已编译MOD，手动打开Companion: diagnostics，保存版本/目标/真实网络状态；不自动启麦克风。
2. 验证实际AP连接、断网/重连、负载下UI响应，日志不得输出凭证。
3. 独立验证时间来源、CA与证书校验、错误时间/过期证书拒绝；未获可信时间证据不放开WSS门控。
4. 用户显式触发分别初始化Mic和Speaker，检查资源错误、JS mono格式、16k输入/24k输出；短录/短播及stop/flush需独立验证。
5. 验证I2S1双工同时运行、时钟/采样率、引脚、资源占用和回声。若冲突，仅评估受支持AudioRuntime重采样/适配；不能证明时保持门控，不改host/native/SDK硬凑。
6. 双工验证后才显式开放运行，连接自有WSS Server；Provider Key始终只在Server。
7. 用外部声学采集测“用户说完→真实第一声音”“打断→真实静音”，同时关联requestId/turnId；Simulator T7与stop调用时间不能替代它们。
8. 长回复、连续多轮、低带宽、AP切换、取消与Provider重连，检查内存/队列/旧音频/资源释放，再决定是否解除生产验收门槛。

官方API依据：[API易 Realtime](https://docs.apiyi.com/api-capabilities/realtime/overview.md)；ws.pause/resume/send语义已核对当前安装源码及Context7的ws官方文档。

## 11. 不能视为通过的验收项

四个模型各有自动打断、显式取消及两种重连成功记录，不等于所有专项试验都通过。尤其Plus在“所有回复强制80字”的原始取消后续答场景中，60秒后仍在接收/播放音频、没有最终完成；该场景继续FAIL，原始数据保留。之后Plus在自然的“停下→再次问候”三段输入及较短Server测试指令下成功；这证明链路可继续工作，不能用它抹去原长续答超时。测试指令和输入变化属于测试条件，不修改生产默认Persona/VAD。

所有真实音频试验共110次：80次短回复比较 + 30次专项/诊断/复验。其中9次失败记录保留，101次满足对应成功条件。主动断连时旧会话报告PROVIDER_UNAVAILABLE是预期注入事件；只要新会话恢复并重新配置，不把这个预期错误再算一次试验失败。不能将“80/80短回复成功”扩展为“所有真实调用全部验收通过”。

自动打断的用户PCM开始注入→客户端收到Provider speech_started的实测耗时如下；该时刻包括Provider检测与网络，并受到Provider整连接TCP节流的队首阻塞影响。本轮没有低延迟自动VAD打断达标的证据。

| 模型 | VAD检测链路延迟ms | 检测后本地stop调用ms | 声学停止延迟 |
|---|---:|---:|---|
| Qwen Flash | 2652.55 | 0.05 | UNVERIFIED |
| Qwen Plus | 3298.84 | 0.08 | UNVERIFIED |
| GPT Mini | 2258.98 | 0.07 | UNVERIFIED |
| GPT 2.1 | 4458.04 | 0.04 | UNVERIFIED |

Provider首包与输入结束后等待的拆分（20ms组）：

| 模型 | 输入文件末片→response.created P50 ms | Provider首音频P50 ms |
|---|---:|---:|
| Qwen Flash | 1376.61 | 272.31 |
| Qwen Plus | 1402.86 | 393.20 |
| GPT Mini | 1182.92 | 818.03 |
| GPT 2.1 | 1075.94 | 691.89 |

这些分项的P50不能相加冒充同一轮的P50。真实上游模型生成速率不可直接观测，已标记UNVERIFIED；Adapter接收速率包含pause时间，不能当成模型内部生产速率。没有为追求指标删除边界或修改设备协议。进一步解决VAD/音频同WSS队首阻塞，需要有证据的Provider级流控或经正式评审的设备消费反馈；当前边界内未验证安全方案，不擅自加新wire消息或扩大队列。

最终回答：容量背压与模拟播放漂移已有离线和真实长回复改善数据；未证明代码优化使E2E降到1000ms；真实API专项并非全部通过；恢复连接的8个真实案例成功；自动打断的检测延迟仍达数秒，原Plus长续答超时仍未验收。可开始只读CoreS3联调准备，尚不能解除音频双工/可信时间门控或宣称硬件实时陪伴体验已达标。
