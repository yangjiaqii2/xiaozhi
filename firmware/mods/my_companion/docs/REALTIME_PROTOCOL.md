# Realtime 协议 v1（设备只连接自有 AI Server）

本协议与 POST /api/chat 并行，核心客户端没有模型供应商依赖。生产路径仅允许 WSS；
Linux fixture 使用 ws://127.0.0.1:8787/api/realtime。Mock 不做 STT/TTS，不理解语音，不连接模型。

## 握手与格式

设备发送 session.start：

```json
{"type":"session.start","version":1,"requestId":"rt-1","deviceId":"robot-001","personaId":"persona-1","voiceId":"default","userId":"user-1"}
```

deviceId/requestId 必填；其余身份可省略。所有 ID 1–64 个 ASCII 字母、数字、下划线或连字符。
这些字段仅表示关联身份，不能作为鉴权凭据。真实服务器的设备认证/短期连接凭证仍须设计，不能信任设备自己声明的 userId。

服务器发送 session.ready，requestId 必须与当前握手一致：

```json
{"type":"session.ready","requestId":"rt-1","sessionId":"session-1","audio":{"input":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1},"output":{"encoding":"pcm_s16le","sampleRate":24000,"channels":1}}}
```

当前只接受上述精确音频格式，不含 WAV 头，不做客户端重采样。encoding 包含 16bit、小端、有符号 PCM。
CoreS3 manifest、Microphone 的 channels=1 与 SDK C 单声道 read、AudioOut 配置是本地约定依据；
SDK 的格式属性与真实 I2S 数据一致性仍待真机确认。适配器发现不符会停止输入并报告错误，不猜测转换。

## 持续输入与轮次

1. session.ready 后启动音频输入；每次回调立即分成有界 PCM chunk 发送，不累积完整录音。
2. 第一片输入前发送 `{"type":"input.begin","sessionId":"session-1","turnId":1}`。
3. 发送多个 input binary frame，sequence 从 1 递增，当前最大 1280 字节 PCM（40ms）。
4. PTT 或服务端 VAD 判定说话结束时，发送 `{"type":"audio.input.commit","sessionId":"session-1","turnId":1,"sequence":4}`。
5. 麦克风保持开启；下一片自动开始新 input turn，即使上一响应正在输出。输入不等于语音活动；静音不能直接触发打断。
6. 服务端发送 `input.speech.started`，携带当前 input turnId，触发对正在生成/播放响应的取消；发送 `input.speech.stopped` 触发当前输入提交。

服务端必须自行区分静音/回声/有效语音。当前客户端不实现 AEC 或客户端 VAD。
Mock fixture 仅为验证协议，第二轮的第一片合成 PCM 即发 activity hint，不能替代真实 VAD。
同时最多一个采集中 input turn 与一个 response turn；不保留聊天/音频历史。

## 二进制帧

WebSocket binary message = 16 字节头 + PCM，头中多字节整数为网络序（big endian），PCM 为 little endian。

| 偏移 | 字段 | 类型/值 |
|---|---|---|
| 0 | magic | uint16，0x5343（SC） |
| 2 | version | uint8，1 |
| 3 | direction | uint8，1=input / 2=output |
| 4 | turnId | uint32，1 起 |
| 8 | sequence | uint32，每 turn 从 1 起 |
| 12 | payloadBytes | uint32，与实际 PCM 字节数一致 |
| 16 | PCM | 非空、偶数字节；input ≤1280 / output ≤1920 |

没有 Base64。turnId 在连接内单调增加；新连接有新的 sessionId，旧 socket callback 由 epoch 拒绝。
服务端的 binary output turnId 必须等于已提交的 response turn。

## 实时输出与播放

服务器发送 response.begin，随后立即逐片输出，不等待完整生成：

```json
{"type":"response.begin","sessionId":"session-1","turnId":1}
```

首个有效 output binary frame 被校验、入有界队列后立即进入 SPEAKING；20ms jitter 延迟后开始写 speaker。
输出每片最多 1920 字节（40ms），环形队列最多 7680 字节/8 片，另有一片正在播放。
只有 native callback 完成后才消费下一片，防止隐式堆积 native queue。
音频到达快于消费且溢出时清空/断连并有限重连，不扩大内存。间隙时等待下一片，不整段缓存。

最后发送 `{"type":"response.done","sessionId":"session-1","turnId":1}`；客户端待队列和正在播放片均完成后进入 IDLE。
`response.done` 不代表 speaker 已播放完。每片播放回调有独立 2000ms watchdog，防止永远等不到 callback。

重复 sequence 安全丢弃；向前跳序取消当前响应（可靠 WebSocket 上不应出现帧乱序），避免缺音频后继续误播。
迟到的已取消 turn、已结束 turn、其他 session 控制包不恢复播放。非法控制 JSON 单次记录固定错误码，连续三次关闭连接；格式/大小非法音频立即关闭。

## 打断与取消

用户 activity hint / PTT / 模拟器 i 触发以下顺序：

1. 使旧播放 callback epoch 失效，停止/Flush/close speaker，清空 jitter queue。
2. 清除响应和播放超时，实时阶段 SPEAKING/THINKING → INTERRUPTED。
3. 发送 response.cancel 与 audio.output.clear，各带 sessionId 和被取消的 response turnId。
4. 转 LISTENING；输入流与当前 input turn 保持可用，不关闭麦克风。
5. 服务端必须停止对应 Provider generation，清除待发音频；已经在链路中的旧 PCM 按 turnId 丢弃。

```json
{"type":"response.cancel","sessionId":"session-1","turnId":1}
{"type":"audio.output.clear","sessionId":"session-1","turnId":1}
```

本地停止无需等待服务端确认；取消消息发送失败则断开/清理并重连。Mock 记录 cancelEvents/clearEvents，清理本轮所有输出 Timer。

## 情绪与动作

服务器可针对当前 response turn 发送 assistant.emotion / assistant.action。
字段分别为 emotion/action，最多 32 个小写字母或下划线。
协议只检验类型和边界；RealtimePresentation 使用已有 Face/Motion controller 安全映射。
未知情绪 NEUTRAL，未知动作忽略。目前白名单 look_away/look_around，不执行服务端代码/任意方法/任意角度。
系统 CONNECTING/RECONNECTING/ERROR 与情绪分开；INTERRUPTED 是 Realtime 阶段，映射现有 Companion LISTENING，不增加第 11 种 emotion 状态。

## 心跳、重连与清理

session.ping/session.pong 带 sessionId、sequence（正整数）；客户端每 10 秒发 ping，一次只等待一个 pong。
30 秒无匹配 pong 关闭连接；5 秒没有完成连接/ready 或响应 15 秒不再推进均失败。
退避 1/2/4/8/16/32/60/60 秒，最多 8 次重试（初始连接另算）。仅收到健康 pong 才重置退避计数，避免握手后立即断开的无限快速循环。
Wi-Fi 离线不高频建连；恢复事件可立即唤醒。断线不续播旧响应，重新 session.start；不重放用户音频。
start/stop/dispose 幂等，dispose 后不可重启；释放 socket、DNS、Timer、音频、队列及 Wi-Fi listener。

## 真实指标与边界

connectionTime：开始连接到有效 ready 的耗时。
firstInputAudioTime/firstServerResponseTime/firstOutputAudioTime：当前启动周期内的单调时钟读数（非 UTC），分别为首次发送 PCM、首次有效 response 控制/音频、首次有效 output PCM。
timeToFirstAudio：当前响应的第一个有效 output PCM 接收时间 − 对应 input turn 的最后一片已发送 PCM 时间；每轮更新，不是 speaker DAC 开始发声时间。
audioChunks/BytesSent、audioChunks/BytesReceived、droppedChunks、interruptionCount、reconnectCount、protocolErrors 为累计有界标量，不记录音频内容。
reconnectCount 统计实际安排的重连尝试，不代表 AP 或 TLS 已恢复成功。

测试的合成 PCM/localhost TTFA 不能证明真实模型、设备音频、WSS 或公网延迟。真实输入有效性必须由服务端 VAD/认证协议进一步确认。

## 生产音频适配的明确限制

CoreS3 RX/TX 同为 I2S1、BCK34/LR33，当前输入 16k、输出 24k 请求不同共享时钟。
所以本协议声明的是网络格式，不能直接推导现有两个原生实例可全双工。
createAudioRuntime 默认 AUDIO_DUPLEX_UNVERIFIED；默认生产 MOD 不启动它。
待验证统一硬件采样率/双工资源协调，必要的重采样应只放 AudioRuntime，不改本协议和 Session。
无设备时不将 duplexValidated=true 当作功能实现；共享时钟的实测与可能需要的最小原生协调方案见 CODEBASE_DOC.md。

## Phase 4 生产Server增量（兼容v1）

继续使用16字节元信息头+PCM，头不属于PCM；不改成无sequence的裸流。session.start/version/requestId与原ready保持一致。

鉴权在WebSocket upgrade前：X-Device-Id与Authorization Bearer opaque设备Token。401拒绝时不创建Provider；session.start.deviceId再次绑定认证身份。
设备可提供personaId/voiceId/userId提示，但服务器使用自己的认证记录，不允许这些字段越权。Provider API Key仅在Server环境，不能给设备。
生产ESP32只允许WSS；Linux明文仅127.0.0.1开发回环。服务器外部绑定必须TLS证书。TIME_UNVERIFIED与AUDIO_DUPLEX_UNVERIFIED均保留。

增加归一化文本增量（不将第三方事件名透传）：

```json
{"type":"response.text.delta","sessionId":"session-1","turnId":1,"delta":"你好"}
```

设备验证turn/文本类型与长度，onTextDelta回调不累积完整文本；对现有无回调应用不改变行为。
response.begin/response.done继续作为响应流边界，不另起一套response.audio.start/end。SPEAKING仍只在有效binary PCM首片到达时进入。

错误：

```json
{"type":"error","sessionId":"session-1","code":"PROVIDER_UNAVAILABLE"}
```

error可在ready前出现，设备清理音频/连接回IDLE并有限重连；DEVICE_UNAUTHORIZED为终止错误，不重试。
不传原始Provider错误体/Key/上下文。Provider响应ID→Server turnId→设备sequence三层隔离，取消后迟到数据被丢弃。

自动VAD时：Provider speech_stopped让Server记录该turn已被上游提交，再通知设备原input.speech.stopped；设备audio.input.commit在Server仅确认本地turn边界。
Server不能再次上游commit/create，否则会重复生成。设备持续麦克风可立即开始下一个input turn；旧turn最后在途帧在ack前仍按原sequence校验和上传。
manual仅显式配置，才上游commit+create；默认semantic_vad不使用manual，Qwen Flash转写限制见APIYI_REALTIME.md。

Server先解码Provider delta，再每20ms发≤960字节PCM，队列最多192000字节；没有等待完整response，限速是为保护设备的7680字节缓冲。
发送完并收到Provider done后发送设备response.done；设备再等待自己的播放队列耗尽。Provider cancel等output_item.done或5秒超时，不能等待不存在的Qwen response.done。
Server侧E2E TTFA从当前turn首输入到首片可播放PCM发出；Provider TTFA从response.created到首audio delta；设备原TTFA仍从最后一片输入到首片输出。三种指标口径不能混用。

详细部署、认证、协议族、指标和分级测试见 [APIYI_REALTIME.md](./APIYI_REALTIME.md)。真实API与CoreS3验证状态分别记录，不以Mock或编译替代。


## 2026-10-17 Linux真实联调口径

设备v1格式和16k输入/24k输出未改变。20ms为默认，Server测试可在v1上限内比较40ms输出；60ms输出超限，禁止用于设备帧。
Server→API易可独立测试20/40/60ms聚合，不更改设备序号、turn或采样率；GPT所需24k重采样只发生在Provider。

新增验收脚本独立记录T0最后一片原WAV数据发送、T1 Server收该帧、T4首片解码PCM、T5首次发送、T6 Simulator收帧、T7调用模拟AudioOutput.write。
T2远端实际确认与T3远端实际生成不可精确观测，记录null；本地收到committed是代理时间，不等同远端时钟。
E2E TTFA=T7−T0，和既有Session的最后“已提交帧”(可能为补零静音)到收帧指标不同；原指标保留，不能混用。
Provider response.created与audio delta可能批量交付，观察TTFA不等同模型内部处理耗时，更不等同物理speaker延迟。

真实结果见[PHASE4_ACCEPTANCE.md](./PHASE4_ACCEPTANCE.md)。四模型真实取消都按output_item.done收口；Qwen没有response.done，5秒fallback保持。
成功的入口打断试验不代表人声VAD自动barge-in/AEC已验收。真实CoreS3全部仍UNVERIFIED，TIME_UNVERIFIED/AUDIO_DUPLEX_UNVERIFIED保持。


### 2026-10-17补充：真实Qwen VAD打断事件次序

通过真实中文WAV barge-in发现output_item.done先于cancel时PROVIDER_OVERLAP；仅在Provider Adapter有限保留32个已收口response ID，cancel可复用已有ACK并继续新响应。
ack-before-cancel的耗时不冒充RTT，interruption_latency保持null；5秒fallback与旧response隔离保持。新增先失败后通过的离线事件顺序测试。
真实复测“北京介绍→停一下→新回应”完成：WAV首片→模拟停播942.81ms，收到hint→stop 0.034ms，旧音频写入0；其他模型仅已完成入口触发取消，不能扩大为四模型自动语音打断全通过。
不改设备协议、RealtimeSession或硬件。详见PHASE4_ACCEPTANCE.md及voice-interrupt-final.jsonl；回归npm test540、server:test41。

## Phase 4.5 兼容说明

设备 v1 控制消息、binary header、turnId/sequence、16k mono S16LE 输入和 24k mono S16LE 输出均保持不变。Server 增加 `OUTPUT_CAPACITY_EXCEEDED`（安全容量无法容纳）、`OUTPUT_CONSUMER_STALLED`（本地 socket 持续无法发送）错误码；走原有 error 消息，不增加 wire 字段。

Server 队列上限仍 192000B，高/低水位暂停/恢复 Provider WSS 接收。临时本地发送积压不推进 sequence、不丢队首 PCM；持续 5 秒无法发送才取消本轮并关闭故障会话。取消/断连 clear 队列及计时器，新轮重新开始 sequence，Provider 的取消集合、连接实例检查及客户端 playback epoch 继续阻止旧音频。

注意：WS send callback 不是设备播放 ACK；当前协议无消费 credit。Provider 的音频、VAD、控制消息共用 WSS，TCP pause 会产生队首阻塞，不能声称已经保证服务端 VAD 的即时性。没有真机前也不能验证物理扬声器是否以目标速率消费。

验收 timeline 的值为同一 Linux 进程 performance.now()，以 requestId + turnId 关联；远端 Provider 内部时刻和真实声学起止均为 null/UNVERIFIED。E2E 从测试 WAV 最后一片文件 PCM 发出算至模拟 AudioOutput.write 被调用，保留 VAD 尾静音等待；这不等于真实用户声学停止到扬声器出声。完整定义见 Phase 4.5 验收报告。

自动 VAD 已确认旧 output_item.done 的情况，只需清理旧轮次；Provider Adapter 不发送迟到的无目标取消，以免影响新 response。客户端仍立即 stop/clear/invalidate playback epoch，设备协议无需改变。Simulator 采样时钟修正仅消除 JS 相对定时器和文件写入的累积误差，不代表已测得硬件 DAC 或声学延迟。

## Phase 4.6 输入活动适配（wire v1不变）

可显式注入ActivityInput：原AudioInput → 16k PCM活动提示 → 既有RealtimeSession.interrupt → 原PCM继续上传。只在有效SPEAKING轮次采样；不停止输入来实现打断，不等待Provider VAD或取消ACK。本地取消仍使用原response.cancel/audio.output.clear，Server语义VAD仍负责输入结束；无需新增设备控制消息。

PCM活动提示只确认输入能量/动态范围，不能确认人声或消除回声；默认生产关闭，真实阈值/回声/双工验证仍UNVERIFIED。Linux显式启用的结果不能当作CoreS3默认行为或声学停止延迟。

Phase4.6最终结果与逐轮事件定义见[PHASE46_ACCEPTANCE.md](PHASE46_ACCEPTANCE.md)。设备控制/binary帧格式没有改变；PCM活动hint仅复用现有interrupt，不引入服务端任意指令。新验收将最后WAV与其输入轮关联；若该轮被明确取消，可接受同session后继完整响应，所有原始turn/request/session仍独立记录，禁止用旧回复done充当新回复完成。Linux首音频/stop函数时刻不能替代实体扬声器测量。


## Phase4.8：设备鉴权生命周期与无音频配置通道

设备音频v1/binary头、turn/sequence、16k输入/24k输出、旧取消事件保持。新增两条只用于已鉴权设备初始化的控制消息，不要求RealtimeSession认识它们：

```json
{"type":"device.config.get","requestId":"setup-1"}
```

```json
{"type":"device.config","requestId":"setup-1","config":{"deviceId":"robot-001","persona":{},"features":{"voiceChat":true,"vision":false}}}
```

每条连接在session.start前最多一次；Server校验requestId并基于鉴权身份返回既有DeviceConfig白名单，不接受客户端persona/user/权限指令。配置探测不发session.start，不创建上游Provider。设备端openDeviceChannel校验关联/消息大小、Bootstrap校验config.deviceId一致并关闭探测连接；开启语音仍是单独显式操作。此增量绕开旧HTTP adapter的HTTPS_UNAVAILABLE缺口，未将HTTPS/WSS降为明文；原HTTP API继续保留。

### 严格凭证记录与连接防重放

Server DEVICE_CREDENTIALS_JSON由进程环境提供，不提交凭证。新记录使用`deviceId`、`credentials:[{tokenHash,notBefore,expiresAt}]`（均epoch毫秒，最多4个）和`requireNonce:true`；也可由安全环境提供token后立即hash。strict记录拒绝无有效期的tokens/tokenHashes。旧格式仅为显式兼容模式，其无限期/无nonce风险未伪装为严格认证。userId/personaId/voiceId/instructions仅来自Server记录。

设备WSS upgrade头：X-Device-Id、Authorization Bearer，以及严格模式X-Device-Nonce（32～128字符ASCII字母/数字/_/-）、X-Device-Issued-At（epoch毫秒）。Server允许±30秒时差，单设备保存最多128个nonce约60秒；满时拒绝，不通过淘汰未到期nonce放行重放。nonce跨运行时轮换保留，重连必须新nonce；active重复连接仍409。同进程可调用AIServer.updateDevices原子替换记录，旧token立即拒绝，旧活动会话关闭，过期会话有有界计时器主动关闭；不会继续创建Provider。没有公开远程管理员轮换/自动注册端点。

nonce仅防同一握手在当前Server进程/时间窗口重放，不替代TLS，不抵御拿到token的攻击者重写nonce；去重内存不跨Server重启。高保证部署还需持久去重/短期单次票据或绑定公钥机制，当前未实现。HTTP GET鉴权检查有效期但未消耗连接nonce；业务非幂等HTTP防重放不在本轮实现范围。

设备DeviceIdentity仅RAM，私有token不进入JSON/诊断/日志；到期/鉴权拒绝/轮换/退出清理引用，JS字符串不能保证安全擦除。configureDevice仅为受控本地provisioning接口，不是完整配对产品，也不意味着现有xsbug提供某条虚构命令。默认无凭证/可信时间证明/设备nonce来源，不自动注册或联网建语音会话。Server上游API易Key永不下发。

### 时间与Bootstrap边界

TrustedTime分别记录系统时间可读、SNTP已同步和认证证据可信。time-runtime使用本机SNTP.time/error、close、Time.set、Time.ticks/delta、Timer；有Wi-Fi前置、超时、取消和晚回调隔离。普通SNTP同步成功返回TIME_UNVERIFIED。acceptEvidence需要本地安装的真实验证器确认签名/来源/新鲜性（仅boolean字段无效），最多1小时有效且检查单调时间与wall clock偏移。生产入口没有该验证器或认证证据，不会解除TIME_UNVERIFIED。

Bootstrap手动CHECK只尝试网络/时间/凭证/安全WSS/配置，各阶段有有界超时、状态和固定错误码，单任务复用；STOP/换凭证/断网/退出取消并释放。重复检查复用当前结果，STOP后可重新检查；鉴权拒绝必须重新显式provision。配置成功只返回configurationReady，音频仍AUDIO_DUPLEX_UNVERIFIED，不自动录音上传。无WS自动降级、无关闭证书验证。
