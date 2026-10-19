# Phase 4：自有 AI Server 与 API易 Realtime

## 验证状态

当前实现了可显式运行的 Server/Provider/WAV/Simulator 链路。离线测试包括真实 localhost WebSocket socket 与生产 API易 adapter，**上游是离线协议 fixture，不是真实 API易**。
2026-10-16～17 已完成四模型各5次真实文本与各5次真实音频基线、四模型真实取消、两次真实上游重连；也保留握手/重连/VAD失败记录。
最新真实TTFA、E2E、usage与限制见 [PHASE4_ACCEPTANCE.md](./PHASE4_ACCEPTANCE.md)。E2E中位数约1.81～2.51秒，<1000ms低延迟目标尚未通过；不能把Provider观察首包或Mock数据当作E2E。
CoreS3 未到手，真实 Mic/Speaker/Wi-Fi/AP/WSS/共享 I2S 双工均未验证。

协议依据：2026-10-16 阅读 [API易官方 Realtime 文档](https://docs.apiyi.com/en/api-capabilities/realtime/overview.md)，页面标注 2026-09-14 更新。
模型注册表、两套字段与事件转换由该页及官方 ws 文档确认；真实网关行为仍须冒烟复核。

## 架构与文件

```text
CoreS3 / Linux RealtimeSession
  → RealtimeClient
  → WSS Runtime / Node Device Runtime
  → 自有 AIServer（设备鉴权、会话、turn、限流、输出分片限速）
  → RealtimeProvider 接口
  → ApiYiRealtimeProvider（Omni / GA adapter）
  → wss://api.apiyi.com/v1/realtime?model=...
```

设备协议复用 REALTIME_PROTOCOL.md 的 v1，不换帧格式。Provider 只在 server/ 内，Node/ws/Provider 不进入 MOD manifest。
现有 HTTP Client、Wi-Fi、Face/Motion、Companion 与入口未重写；原 /api/chat 模块保留。独立 Server 当前只提供 Realtime、GET 配置与 health，未实现真实 HTTP LLM /api/chat。

| 文件（server/ 下） | 职责 |
|---|---|
| package.json/package-lock.json | 独立 Node >=22 包，唯一外部依赖 ws 8.22.0；根 lock 保留 |
| server.js / index.js | HTTP(S)/WebSocket 监听、upgrade 前鉴权、容量/连接限流、启动/退出 |
| auth.js | token SHA256 常量时间比较、身份绑定、轮换窗口 |
| config.js | 环境配置、认证设备记录 → Provider 工厂 |
| device-session.js | 原设备协议、VAD ack、turn/response 关联、故障恢复、生命周期 |
| output-stream.js | 立即发送首片，随后每20ms一片；有界192000字节队列 |
| audio.js | 固定状态的16k→24k线性插值，不整段缓存；原采样率直通 |
| metrics.js | 指标及只包含数值的 usage 过滤 |
| provider/realtime-provider.js | connect/configure/sendAudio/sendText/commit/create/cancel/close 契约 |
| providers/apiyi/model-config.js | 四模型注册表、协议族、默认采样率/voice |
| providers/apiyi/apiyi-{omni,ga}-protocol.js | 分离的 session.update 模板与 delta 事件名 |
| providers/apiyi/apiyi-realtime-provider.js | API易 WSS、握手、音频转换、归一化事件、取消/超时 |
| node-runtime.js | 设备到自有 Server 的认证 WebSocket adapter，不知道上游 Key |
| wav.js | WAV 格式预校验、逐20ms读取/上传、边消费边写输出WAV |
| tools.js | 显式注册的 Server tool，参数/结果预算、AbortSignal、超时 |
| smoke.js | 显式付费文本/短WAV冒烟及可选打断/重连测量 |
| tests/ | 不联网、不收费的行为测试及双WebSocket离线闭环 |

新增 simulator/apiyi-simulator.js 仅在 REALTIME_PROVIDER=apiyi 时动态加载；默认 Mock 不导入 ws 包。

## 安装与配置

从 firmware/ 执行一次：

```bash
npm ci --prefix mods/my_companion/server --cache /tmp/companion-npm-cache
```

这只安装 Server 独立依赖；不改变 firmware/package-lock、SDK 或 ESP-IDF。CI 运行 npm test 前也需要此安装步骤。

APIYI_API_KEY 可通过服务器环境变量或本机服务器配置设置。不要把密钥作为命令行参数、写进 MOD、发到日志或提交 Git。

本机代码配置：编辑 `server/local-config.js` 的 `APIYI_API_KEY` 字符串。此文件已被 Git 忽略；新检出可复制 `server/local-config.example.js` 为 `server/local-config.js` 后填写。Server、真实 Simulator、文本/音频冒烟入口自动读取；环境变量优先，显式空环境变量可禁用本地 Key（离线测试使用）。默认 Simulator 仍为 Mock，不自动调用付费 API。配置语法错误仅输出通用错误，不打印可能包含 Key 的源码行。
可交互隐藏输入（不把实际 Key 写入 shell history）：

```bash
read -rs APIYI_API_KEY
export APIYI_API_KEY
```

Provider 配置：

```text
AI_REALTIME_PROVIDER=apiyi
AI_REALTIME_MODEL=qwen3.5-omni-flash-realtime
AI_REALTIME_VOICE=Tina
AI_REALTIME_VAD=semantic_vad
# Qwen本轮成功基线使用server_vad；可选静音时长仅在server_vad有效
# AI_REALTIME_VAD_SILENCE_MS=800
AI_REALTIME_INSTRUCTIONS=<服务端人格/上下文说明>
```

模型别名兼容 APIYI_REALTIME_MODEL / REALTIME_MODEL，优先级 AI_REALTIME_MODEL > APIYI_REALTIME_MODEL > REALTIME_MODEL。
voice 未设置时按模型族选默认值；切换到 GA 时不要继续强行设置 Tina。
Server 不接受设备通过 session.start 改写 userId/personaId/voiceId 的归属，使用鉴权记录中的字段。
上下文默认由同一 Provider session 保存；重连重放服务端 instructions，**不自动重放历史音频或历史对话**。长期上下文存储/恢复与 fallback policy 通过工厂留接口，本阶段未实现数据库或第二 Provider。

## 设备鉴权与 TLS

独立 Server 读取 DEVICE_CREDENTIALS_JSON，结构为数组。每条包含：

```json
[{"deviceId":"robot-001","tokenHashes":["<SHA256_HEX_64>"],"personaId":"persona-1","userId":"user-1","voiceId":"Tina","instructions":"<服务端人格说明>"}]
```

部署时必须替换占位符。支持 tokens（环境传入的32–256字符 opaque token，字母/数字/_/-）或 tokenHashes；每设备最多4个，用于新旧 token 轮换。推荐服务器仅保存 tokenHashes。
轮换采用更新服务配置/重启，不声称实现了凭证管理控制台。env/.env、音频输出被 server/.gitignore 排除；实际部署仍应使用系统 Secret 管理。
设备在 WebSocket upgrade 请求发送 X-Device-Id 与 Authorization: Bearer <deviceToken>。
无凭证或不匹配返回 HTTP401/DEVICE_UNAUTHORIZED，不创建 Provider；session.start.deviceId 必须绑定同一认证身份，单独 deviceId 不构成认证。
同设备只允许一个连接；默认最多8个会话，已认证设备每分钟最多6次 upgrade，每会话控制消息每秒100条、PCM约32KB/s加有限burst。

```text
AI_SERVER_HOST=127.0.0.1
AI_SERVER_PORT=8787
AI_SERVER_TLS_CERT=<PEM证书路径>
AI_SERVER_TLS_KEY=<PEM私钥路径>
```

npm run server 启动自有服务器。没有 TLS 时仅允许127.0.0.1；绑定公网地址必须提供 cert/key，TLS最低1.2。
Node 设备 runtime 明文仅允许127.0.0.1；ESP32 runtime 始终只接受 wss，无明文回退。
ESP32 createRealtimeRuntime({deviceCredentials:()=>({deviceId,token}),isTimeTrusted,ca}) 从运行时注入凭证，不要求写入 config.js。
TIME_UNVERIFIED 保留；现有无认证 SNTP/旧日期阈值不能证明可信时间。本阶段没有伪造 time-runtime。

## 两套 Provider 协议

| 模型 | 协议族 | Provider 输入 | 输出 | 默认音色 |
|---|---|---|---|---|
| qwen3.5-omni-flash-realtime | Omni/百炼 | 16k PCM16 mono | 24k PCM16 mono | Tina |
| qwen3.5-omni-plus-realtime | Omni/百炼 | 16k PCM16 mono | 24k PCM16 mono | Tina |
| gpt-realtime-2.1-mini | Realtime GA | 24k PCM16 mono | 24k PCM16 mono | marin |
| gpt-realtime-2.1 | Realtime GA | 24k PCM16 mono | 24k PCM16 mono | marin |

Omni 使用 session.modalities、voice、input_audio_format=pcm、output_audio_format=pcm、input_audio_transcription.model=qwen3-asr-flash-realtime、turn_detection。
GA 使用 session.type=realtime、output_modalities、audio.input/output.format={type:audio/pcm,rate:24000}、audio.input.transcription.model=whisper-1、audio.output.voice/speed=1.0、audio.input.turn_detection。
两者绝不混字段；等待 session.created 后发送首个 update，等待 session.updated 后才向设备发 session.ready。
音色只在首个 update 固定，禁止运行中重配；变更音色需新会话。
Omni text/audio delta 分别是 response.text.delta/response.audio.delta；GA 是 response.output_text.delta/response.output_audio.delta。

## Streaming、VAD、取消与重连

设备→Server 使用已有二进制 envelope（元信息在头，提取后的PCM没有元数据）；Server→API易按官方要求使用 input_audio_buffer.append + Base64。
只有 Server 做上游 Base64/GA重采样，MOD没有这种转换和 Key。
上游 audio delta 立即解码并送限速队列，首片不等 response.done；随后按每960字节/20ms发设备binary frame。队列最多192000字节（4秒），超限主动失败，不整段无限缓存。
设备沿用7680字节 jitter buffer；Server response.done 等队列发完，设备自己等播放 callback 完成。

默认 semantic_vad，可选 server_vad/manual。自动模式下持续上传，文件结束后默认追加2秒静音帮助 Provider 判定说完；不做客户端VAD。
Provider speech_stopped → Server 绑定response turn → 通知设备 input.speech.stopped → 设备提交本地turn确认；Server不再向Provider commit/create，防止重复生成。
manual 仅显式配置使用，执行 commit + response.create；Qwen Flash manual 下转写完成事件可能缺失，不能把缺转写当作音频会话失败。

打断：设备先停止播放、清空本地queue并失效callback → Server清空待发queue、使旧response映射失效 → Provider response.cancel。
Provider 等对应 response.output_item.done（message/function_call都适用）或 response.done，最多5秒；超时关闭不确定的上游生成状态并重连。
取消期间仍上传新输入；如果上游在未收口时开始重叠response，安全失败并重新握手，不播放混合音频。
旧 response ID/旧turn/旧callback不得进入新播放；取消ID保留最近32个，避免无限历史增长。

Omni闲置300秒可能断线且WS ping不能续期；adapter在280秒无应用活动时主动接受断线，交给设备重连，重新发送首个配置。不发送无意义 response.create 保活。
Provider connect/ready超时10秒，response停滞30秒；Server启动Provider默认最多2次重试，250/500ms退避，仅重试暂时网络故障。
显式真实Simulator关闭Server内部重试，只由设备侧最多重试2次（总共最多3次连接），防止叠加成9次；文本冒烟不重试。
Provider活跃时断开，Server发送统一错误并关闭设备socket，设备清理播放、重新session.start，不续播半截旧音频。

## 工具接口

归一化 function_call → ServerTools 白名单 → function_call_output → response.create。
默认无外部工具、无第二个大模型；普通聊天只经过Qwen Realtime。
已提供参数/结果大小、每turn最多4次、5秒超时和AbortSignal；注册的handler仍须尊重取消信号。
本阶段没有实现GPT/Search/Weather/Database，也未配置真实Provider工具schema；后续在Server配置工具声明与handler即可，不能让设备执行任意代码。

## 指标、usage 和错误

Provider 指标：connection_time、session_ready_time、first_input_time、first_text_delta_time、first_audio_delta_time、response_start、TTFA、total_response_time、input_audio_bytes、output_audio_bytes、interruption_latency。
TTFA = first_audio_delta_time - response_start（均单调时钟）。connection/session_ready/total/latency是耗时；first_*是本进程单调时钟读数，不是UTC。
Server E2E_TTFA = 当前device turn第一片输入到第一片binary PCM发回的耗时；包含输入上传时长/静音前缀，不等于设备最后输入到首输出的旧TTFA，也不是声卡出声时间。
GA Provider input_audio_bytes统计重采样后的字节；Server统计设备原16k字节，二者不能直接混比较。
response.done里的usage仅保留数值/数值子树；取消后缺少response.done时usage=null，不能编造0费用。真实费用以API易账单为准。

日志只记录固定错误码、允许的模型/协议、时间和字节计数，不记录Token、Authorization、完整响应、转写或上下文。
错误对设备统一为error/code：DEVICE_UNAUTHORIZED、PROVIDER_UNAVAILABLE、PROVIDER_RESPONSE_FAILED、STREAM_BACKPRESSURE、INVALID_MESSAGE、SESSION_TIMEOUT/EXPIRED等。
上游认证/字段拒绝不无限重试；取消等待、connect/response、工具与session都有截止时间。资源关闭会释放socket/timer/queue/provider/文件与listener。

## 分级测试与成本控制

离线（不调用API易）：

```bash
npm run server:test
npm run realtime:test
npm test
npm run simulator
```

Level1：设置Key后先文本；同session两轮，检查context、text delta、response.done与usage，最多20秒/轮，不输出完整回答。

```bash
npm run server:smoke:text
AI_REALTIME_MODEL=gpt-realtime-2.1-mini npm run server:smoke:text
```

Level2：用户提供真实短WAV（非合成正弦波），先用ffmpeg规范化，再20ms流式上传。禁止把大量长音频放入自动测试。

```bash
ffmpeg -i /path/source.wav -ac 1 -ar 16000 -c:a pcm_s16le /tmp/input-16k.wav
REALTIME_WAV=/tmp/input-16k.wav npm run server:smoke:audio
REALTIME_WAV=/tmp/input-16k.wav npm run server:smoke:audio -- --interrupt
REALTIME_WAV=/tmp/input-16k.wav npm run server:smoke:audio -- --reconnect
```

最长10秒输入加2秒静音；格式和长度在创建付费Provider前预校验。输出以0600新建到/tmp的24k WAV，不覆盖已有文件，最大10MiB；边接收边写，header随片更新，AudioOutput逐片按音频时长消费。
--interrupt 等首音频后立即打断，记录上游取消收口延迟；--reconnect 强制关闭真实上游socket，验证新session配置并计时。这些是额外显式调用，不默认批量运行。
没有Key时上述真实命令正常退出并打印SKIPPED，不能当作PASS；没有WAV时audio命令单独打印SKIPPED。

Level3：

```bash
REALTIME_PROVIDER=apiyi REALTIME_MODEL=qwen3.5-omni-flash-realtime \
REALTIME_WAV=/tmp/input-16k.wav npm run simulator
```

r连接、v短WAV、i打断、w断网/恢复、s状态、x退出Realtime、q退出。入口自动启动鉴权的自有Server，生成仅本次进程使用的设备token，不打印、不写默认配置。
该模式Realtime是真实API易；t/c仍是原Mock HTTP/text回归入口，不能误认为真实HTTP模型调用。
没有Key时明确SKIPPED，不偷偷回退Mock。不提供默认音频，不把模拟麦克风当真人音频。
目前输出文件/模拟播放时钟可用，**没有声称Linux声卡实际出声**；可自行用本机播放器检查生成WAV。

## CoreS3 到手后待办

1. 配网与真实AP断连恢复、设备凭证持久化/轮换、目标CA覆盖。
2. 可信时钟来源验证；当前SNTP不提供认证，TIME_UNVERIFIED继续保留。
3. 同I2S1/BCK34/LR33的RX/TX所有权与16k/24k共享时钟风险；AUDIO_DUPLEX_UNVERIFIED继续保留。
4. 验证连续麦克风数据、声道、采样率、PCM endian、speaker queue/Flush/stop的真实效果和延迟。
5. AEC/回声及服务端VAD，真实长时间内存、TLS峰值、抖动、打断、重连与TTFA。

本阶段没有修改host、平台、SDK或ESP-IDF来强行解决硬件缺口；Linux通过不等于CoreS3通过。

## 验证补充与能力边界

取消请求采用两族均确认的最小 type/event_id 字段；response ID保留本地用于过滤和匹配ACK，不向Omni发送未经确认的response_id请求字段。
自动VAD可能先取消生成，延迟返回的取消错误按event_id与最近32次取消关联，不得杀死新turn；等待中仍由5秒watchdog兜底。
如果Server生成已完成、只是客户端还有尾音，取消记录reason=inactive，interruption_latency=null；这是本地播放清空，不冒充真实模型取消耗时。

原SDK WebSocketClient对HTTP upgrade失败只暴露onError，生产ESP32 adapter当前不能从该回调区分401与TLS/网络失败；不得假造状态码。
Node runtime可从unexpected-response确认HTTP401并直接进入DEVICE_UNAUTHORIZED终止状态。
无论设备是否能细分该错误，自有Server都在upgrade前拒绝未认证设备，不会创建付费Provider；ESP32当前最多只按原有有限策略尝试连接。
生产装配需要把连接/ready预算设为适合上游握手的值（真实Simulator使用35000ms/响应30000ms）；原MOD默认配置与入口未自动启用。

输入字节在WebSocket发送被接受后计数；Server首片可播放PCM及字节计数也在send成功交给WebSocket后更新。
这证明的是服务端发送时刻，不是设备收到或真实speaker出声；异步链路故障不能用该指标宣称成功交付。

显式设置 AI_REALTIME_VAD=manual 时，真实Simulator按PTT模式在文件结束后commit一次、不追加VAD静音；默认semantic/server VAD仍由Provider结束回合。
输入因断线/停止提前结束会返回INPUT_STOPPED，不报告上传成功；manual提交失败返回INPUT_NOT_COMMITTED。
独立测试覆盖manual commit一次与automatic commit零次，两个模式不能混用。


## 真实低延迟验收入口（2026-10-17）

`npm run server:acceptance -- /path/test.wav` 显式运行有界付费验收，不属于自动回归。默认最多6条≤20秒WAV；每条实时分片、错误脱敏、资源释放。
`REALTIME_TEXT_SAMPLES=5 npm run server:smoke:text` 获取5次文本TTFT/总时间。
`ACCEPTANCE_MODE=interrupt/reconnect/graceful-reconnect/network-reconnect` 分别验证入口触发取消、强制上游断线、正常关闭、模拟本地网络断开；不能冒充真实AP或人声VAD打断。
`ACCEPTANCE_PROVIDER_CHUNK_MS=20/40/60` 只在Server→Provider聚合，`ACCEPTANCE_OUTPUT_CHUNK_MS=20/40` 保持v1帧上限，默认均20。60ms输出不受当前协议允许，不放宽设备限制。

音频冒烟现在必须出现`stream_completed`才成功，防止收到半截音频后断线/回IDLE被误报PASS。新Provider诊断仅保留白名单原因与数字HTTP状态，不含原始错误/凭证。

默认没有改变VAD或静音窗口；可选`AI_REALTIME_VAD_SILENCE_MS`范围100–2000ms，仅server_vad。300ms额外试验失败，不能当成已验证优化。
成功基线Qwen采用server_vad，GPT采用semantic_vad；这不是全部VAD/模型/语句交叉矩阵。真人中文理解、声音自然度和账单金额未验收，不能给出虚构的加权总榜。


### 2026-10-17补充：真实Qwen VAD打断事件次序

通过真实中文WAV barge-in发现output_item.done先于cancel时PROVIDER_OVERLAP；仅在Provider Adapter有限保留32个已收口response ID，cancel可复用已有ACK并继续新响应。
ack-before-cancel的耗时不冒充RTT，interruption_latency保持null；5秒fallback与旧response隔离保持。新增先失败后通过的离线事件顺序测试。
真实复测“北京介绍→停一下→新回应”完成：WAV首片→模拟停播942.81ms，收到hint→stop 0.034ms，旧音频写入0；其他模型仅已完成入口触发取消，不能扩大为四模型自动语音打断全通过。
不改设备协议、RealtimeSession或硬件。详见PHASE4_ACCEPTANCE.md及voice-interrupt-final.jsonl；回归npm test540、server:test41。

## Phase 4.5 流控与复验

默认模型、VAD、20ms 分片均不因少量样本直接更换。真实付费对比（不会 fallback 到 Mock）：

```bash
# firmware 目录；创建新的目录，最多 80 次响应，失败批次不自动补跑。
python3 mods/my_companion/server/tools/benchmark-phase45.py /path/input16k.wav /tmp/new-phase45-results
python3 mods/my_companion/server/tools/summarize-phase45.py /tmp/new-phase45-results
```

凭证仍由已有 Server 运行环境加载，工具不打印或保存凭证。请求结束只记录数值 usage、耗时、队列统计与白名单错误；生成音频留在本地 /tmp，不提交 Git。

ApiYiRealtimeProvider 新增 setOutputPaused，通过真实 ws.pause/resume 接收反馈；cancel 前恢复接收，确保 output_item.done 能被处理。常规 close 使用 WebSocket close 握手并在 1 秒后兜底 terminate。5 秒取消收口和有限重连不变。

队列节流只能暂停整条 Provider 连接，可能延迟 VAD；它不是模型级 pause。已缓存输入、单个超大 delta 或永不消费的设备仍可能触发明确取消，不会扩容或静默丢有效音频。本轮实验、失败和未验证项见 [PHASE45_ACCEPTANCE.md](PHASE45_ACCEPTANCE.md)，不得将 Linux WAV 模拟播放计时当成 CoreS3 声学延迟。

Qwen 自动打断竞态修复：若已观察到旧 response 的 output_item.done，旧生成已获收口依据，此时不再发送无 response ID 的迟到 cancel，以免取消新一轮自动生成。`cancel_reason=output_item.done_before_cancel` 的 wire cancel / RTT 可以是 null；不能把本地 cancelResponse 调用记作真正发出了取消。仍在生成时会发送真实 response.cancel，并保持原有 5 秒超时。

较长回复可显式设置 `ACCEPTANCE_COMPLETION_TIMEOUT_MS=60000`（最高 60 秒）；它是验收工具预算，不是生产参数调整。所有超时与修复前失败均保留在原始数据中，不通过覆盖样本提高通过率。

## Phase 4.6：显式本地输入活动提示与进度验收

`REALTIME_ACTIVITY_HINT=pcm` 只在显式真实Linux Simulator里选择纯PCM输入装饰器；默认仍provider。提示器使用既有16k单声道S16LE样本，10ms窗/40ms连续AC能量与动态范围判断，仅触发本地打断，不接管云端语义断句。不会等待Provider ACK停止播放；原response.cancel、turnId/sequence/playback epoch隔离不变。它不是AEC或普适人声VAD；真机必须验证扬声器回声及噪声，不能直接默认启用。

新增显式付费验收入口：`node --import ./mods/my_companion/simulator/register.js mods/my_companion/server/phase46-acceptance.js <WAV...>`；`ACCEPTANCE_MODE`复用既有模式，`PHASE46_TRACE`指定新的单调事件JSON文件（wx写入，不覆盖）。与旧固定60秒工具不同，新入口使用30秒无音频进展超时和180秒有限成本预算，持续流式输出不被固定短截止误判；数据仍然逐片上传、逐片播放，预算不作用于生产配置。旧验收入口默认行为保持。

Phase 4.6补充：原工具重连后误用历史lastError导致健康新Session被提前判失败；现使用CONNECTED状态+对应sessionId判断存活，历史lastError继续供诊断。输出仍有界，不自动重放旧音频。原错误样本保留并用新文件复验。真实调用日志另增加provider_failure/provider_retry，记录固定错误码、阶段、attempt和失败前队列，不记录凭证或完整响应。

完整付费矩阵工具：`python3 mods/my_companion/server/tools/benchmark-phase46.py /path/wavs /tmp/new-results`（创建新目录，hello/stop/beijing/name/recall五个既有16k mono WAV，最多81个试验，不自动补跑失败）；离线汇总用同目录`summarize-phase46.py`。本轮实际88/90成功，含原失败，详见[PHASE46_ACCEPTANCE.md](PHASE46_ACCEPTANCE.md)。显式活动hint改善Linux打断检测，不代表CoreS3回声处理通过；E2E TTFA仍未达1秒。旧CLI默认预算不变，新入口才启用进度watchdog。


## Phase4.8 设备安全边界补充

APIYI_API_KEY继续仅由Server环境/已有ignored本地加载器读取，不写MOD或DeviceConfig。新增设备credentials有效期/轮换/strict nonce模式、WSS无音频配置探测不改变API易Provider协议。详见REALTIME_PROTOCOL.md与PHASE48_ACCEPTANCE.md。strict记录应使用有期限tokenHash及requireNonce:true；旧tokens仅兼容，不能作为新安全验收结论。到期/撤销关闭已有设备Session；不自动切换Mock、注册设备或恢复撤销凭证。实际账单未核对，usage不是成本。
