# Phase 4：API易真实联调与低延迟验收（2026-10-16～17）

**真实链路已跑通；E2E TTFA <1000ms 的低延迟验收未通过。真实 CoreS3 尚未验证。**

本报告使用真实 api.apiyi.com WSS/四个模型的响应。原始数字记录位于 [results/2026-10-17-apiyi/summary.json](./results/2026-10-17-apiyi/summary.json) 及同目录 JSONL。它们不含 Key、Header、音频、完整文本或上下文。付费试验必须显式启动，不属于 npm test。

## 方法与限制

- 每模型基线：同一个已连接会话内 5 次文本、5 次音频。共20个文本、20个完整音频响应。连接失败、取消和调参等额外试验单独保留，不混入成功样本的P95；不能据此声称整体建连成功率100%。
- 文本输入顺序：英文ALPHA7记忆/回忆、中文问候、疲惫陪聊、我叫小明。第二轮上下文检查均通过。并非全部中文语义场景的人工评分。
- 音频输入顺序：中文问候、我叫小明、回忆姓名、疲惫陪聊、中文问候。固定中文语音由本机 eSpeak NG 合成，ffmpeg转16k mono pcm_s16le；不是真人录音或真实麦克风。人格测试指令只在Server环境设置，要求中文简短回答。
- Qwen成功基线使用server_vad；GPT成功基线使用semantic_vad。该比较包含VAD配置差异，不是完全受控模型推理竞赛。
- P50/P95采用nearest rank；每组仅5个样本，P95等于最大值，样本量不足以推断生产尾延迟。
- TTFT从连接完成后的sendText/createResponse调用前计时，不含冷建连；连接时间和session_ready分别保存在每条原始记录中。
- E2E TTFA = T7 − T0：T0是最后一片原WAV数据发送前，后续补零静音不计入；T7是Simulator调用AudioOutput.write的时刻，包含20ms jitter。不是人类真实发声结束或真实扬声器DAC出声时刻。
- T1是Server验证/处理该输入帧前，T4是Provider解码首片PCM后，T5是Server调用WebSocket发送首片，T6是Simulator收帧。所有时间取同一Node进程的单调时钟。
- API易内部实际接收/确认输入结束时刻T2、实际生成首音频时刻T3无法从当前公开事件精确观测，原始记录保留null。input_audio_buffer.committed接收时间只作ACK代理，不等同远端T2。
- Provider观察TTFA = 本地收到首audio delta − 本地收到response.created。网关可能批量交付事件；个别额外试验接近0ms不表示真实推理耗时为0。重点采用E2E指标。

## 文本真实样本（ms）

| 模型 | 样本 | TTFT Min | P50 | P95 | Max | Total P50 |
|---|---:|---:|---:|---:|---:|---:|
| Qwen Flash | 5 | 554.2 | 571.7 | 632.5 | 632.5 | 799.6 |
| Qwen Plus | 5 | 678.7 | 681.4 | 785.9 | 785.9 | 908.7 |
| GPT Mini | 5 | 640.3 | 761.4 | 1379.2 | 1379.2 | 940.7 |
| GPT 2.1 | 5 | 553.1 | 571.1 | 600.1 | 600.1 | 761.6 |

## 音频真实样本（ms）

| 模型 | VAD | Provider TTFA P50 | P95 | E2E P50 | P95 | E2E Min | Max | 全轮含上传/模拟播放 P50 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Qwen Flash | server_vad | 320.1 | 410.9 | 1810.8 | 1869.5 | 1725.8 | 1869.5 | 4372.3 |
| Qwen Plus | server_vad | 361.7 | 458.9 | 1935.1 | 2515.9 | 1855.2 | 2515.9 | 5405.8 |
| GPT Mini | semantic_vad | 1301.0 | 3159.0 | 2513.9 | 5021.7 | 2096.7 | 5021.7 | 6572.5 |
| GPT 2.1 | semantic_vad | 879.2 | 958.6 | 1870.9 | 2036.7 | 1494.6 | 2036.7 | 5448.5 |

以上全轮从开始上传到播放完成，包含原WAV时长与附加静音；不是response.done − request_start，不能与文本Total直接比较。response_start、response_done原始时间可单独计算模型观察响应总耗时。

## 首包路径与Streaming

设备输入固定16k、mono、pcm_s16le，每20ms 640字节逐片上传；Qwen保持16k，GPT仅在Server Provider内16k→24k重采样。四模型输出24k mono pcm_s16le。设备段仍为v1二进制头+PCM；上游API易仍是base64 append/delta。

40个基线文本/音频样本均来自真实Provider。20个成功音频样本全部满足首binary转发早于response.done，没有等完整生成；同一次流中多次audio delta、每20ms下发并逐片写AudioOutput。

| 模型 | Server转发P50 | Simulator缓冲P50 | 上游audio delta数(5轮合计) | 设备PCM帧数 | 输出PCM字节 |
|---|---:|---:|---:|---:|---:|
| Qwen Flash | 0.042ms | 20.26ms | 26 | 376 | 360960 |
| Qwen Plus | 0.032ms | 20.65ms | 27 | 396 | 380160 |
| GPT Mini | 0.036ms | 19.88ms | 25 | 454 | 434400 |
| GPT 2.1 | 0.027ms | 19.80ms | 22 | 403 | 386400 |

每模型设备原始输入合计630400字节，含测试所需附加静音；这不是API易按tokens计算的账单。没有物理声卡或CoreS3扬声器播放验证。

## 真实取消

在首片模拟播放后由测试入口立即触发interrupt；这是客户端明确活动提示/键盘等价测试，不是客户端VAD或真实人声自动打断。

| 模型 | 本地停止(ms) | cancel→ACK(ms) | 收口事件 | 迟到delta丢弃 | 丢弃字节 | 旧音频泄漏 | response.done |
|---|---:|---:|---|---:|---:|---:|---|
| Qwen Flash | 0.087 | 486.2 | output_item.done | 6 | 92160 | 0字节 | 未收到 |
| Qwen Plus | 0.025 | 430.9 | output_item.done | 6 | 92160 | 0字节 | 未收到 |
| GPT Mini | 0.051 | 489.0 | output_item.done | 13 | 269760 | 0字节 | 收到 |
| GPT 2.1 | 0.089 | 983.7 | output_item.done | 7 | 134400 | 0字节 | 收到 |

四次均在仍有active response时cancel，输出队列和播放buffer清空，不等待response.done停止。Qwen两款没有response.done，按output_item.done收口。5秒fallback仍保留，但本轮成功取消没有自然触发该timeout；timeout由离线测试验证。另追加一轮Qwen Flash真实语音文件barge-in，结果见下文；其余三模型仍未跑完整自动语音打断矩阵。

### 真实VAD语音文件打断与继续对话

- 模型播放北京介绍时，上传“停一下”中文WAV，真实Provider VAD触发打断，然后新一轮响应完整结束。见[voice-interrupt-final.jsonl](./results/2026-10-17-apiyi/voice-interrupt-final.jsonl)。
- 新语音首片上传→客户端收到打断事件942.776ms；首片上传→模拟停播942.810ms；事件收到→stop调用0.034ms；检测后的旧音频写入0字节。不能用0.034ms冒充用户开口到停播延迟。
- 发现并修复真实Qwen事件次序：output_item.done可能早于speech_started/显式cancel。Adapter原先丢掉较早ACK，导致PROVIDER_OVERLAP。新增失败回归后修复，有限保留最近32个已收口response ID；同一response取消直接使用已有ACK，仍发送cancel并隔离旧ID。
- 较早ACK标记output_item.done_before_cancel；其ACK RTT未知/不适用，保持null，不填0ms。新response正常开始且最终stream_completed，队列耗尽。
- 第一次修复后试验出现新一轮长回复OUTPUT_BACKPRESSURE，正确停止而非继续播放脏数据，见voice-interrupt-fixed.jsonl。最后一次使用“用户要求停止只答好的”的测试人格完成新一轮。未扩大queue掩盖过载；长时间快生成/慢播放的上游流控仍需后续完善，不能声称任意长度回复都可稳定播放。
- 该额外记录包含两个响应，历史provider_TTFA底部字段对应后一个响应，T0/T4/T7对应首个响应，不能混用于基线统计；单独采用barge时间点/收口/新轮次完成作为证据。后续脚本分开保留首响应与新轮次TTFA、标明usage_scope。
- 没有真人麦克风/AEC，不能据此声称CoreS3声学双工打断已验证。

## 真实重连与失败记录

- Flash主动正常关闭上游WSS后，设备重连到新session并重新session.update成功：8417.7ms。
- Simulator Wi-Fi断开/恢复（非真实AP）后，连接真实API易新session及配置成功：1860.6ms。
- 强制terminate上游的Mini/GPT试验也出现重连等待超时，完整失败记录保留在reconnect-mini/reconnect-gpt.jsonl。自动重连不能宣布全场景通过。
- 另有多次真实WSS握手10秒超时；诊断单次延长30秒仍有超时。未鉴权可达性探测收到401不能代表已鉴权通道一定可用，也不能证明是API额度问题。
- 未制造/伪称真实API易5xx；5xx与旧session迟到消息注入仅有离线覆盖，当前真实5xx场景UNVERIFIED。
- 重试最多2次，Server内部真实模式0次重试，防止双层重试放大；正常会话和新session隔离仍由原RealtimeSession/Client实现。

## VAD与中文输入

- Qwen server_vad基线成功，额外回显确认默认silence_duration_ms=800。Flash追加带停顿、嗯、对、约17.9秒长句的四轮均完整返回；见chinese-cases.jsonl。长句E2E约4420.3ms，不能用短句数据替代。
- Qwen semantic_vad曾出现等待首输出超时；GPT semantic_vad完成基线。GPT server_vad探测在建连阶段超时，不能归因VAD实现。两种模式、四模型、所有标准句子的完整交叉矩阵未完成。
- 新增可选AI_REALTIME_VAD_SILENCE_MS（100–2000，仅server_vad），默认不设置，分别放入两协议族正确字段。300ms额外试验失败(PROVIDER_INVALID_MESSAGE)，不得把它当作低延迟优化通过。
- 当前运行建议：Qwen使用server_vad默认800ms；GPT保留已测semantic_vad。依据是已完成的样本，不能推出某模式永久不受支持或全场景更好。
- 输入为机械合成语音；只证明语音链路响应，不构成真人中文识别准确率、姓名回忆正确率、自然度人工评分。未输出完整转写/回答，也未做听感主观打分。

## Chunk实验

设备输入仍20ms，只在Server→Provider测试聚合20/40/60ms，最多2880字节(24k)。保留所有设备turn/sequence/大小上限。输出20/40ms均在原v1≤1920字节范围；60ms输出超出协议，本轮明确不测试、不放宽。

| 输入Provider分片 | 输出分片 | 模型 | 样本 | E2E(ms) | 说明 |
|---|---|---|---:|---:|---|
| 20ms | 20ms | GPT Mini | 5 | P50 2513.9 | 基线、不同短句 |
| 40ms | 20ms | GPT Mini | 1 | 2670.0 | 额外问候语样本 |
| 60ms | 20ms | GPT Mini | 1 | 3287.1 | 额外问候语样本 |
| 40ms | 40ms | GPT Mini | 1 | 2310.4 | 额外问候语样本 |

这些单样本有模型抖动和上下文差异，不能证明20ms显著优于40ms。保持已有20ms默认，不引入100/200ms等待。CPU记录为Node进程user/system微秒，不是ESP32；原始记录保留峰值Server队列，所有成功基线最终队列为0、protocol_errors为0。短试验不能证明长时间音频连续性或真实声卡听感。

## 真实usage（5个成功音频响应合计，非估算）

| 模型 | Audio In | Audio Out | Text In | Text Out | Cached |
|---|---:|---:|---:|---:|---:|
| Qwen Flash | 266 | 94 | 2608 | 39 | 未返回 |
| Qwen Plus | 266 | 99 | 2624 | 43 | 未返回 |
| GPT Mini | 361 | 181 | 383 | 743 | 384 |
| GPT 2.1 | 361 | 161 | 354 | 215 | 256 |

usage按Provider实际回传的各模态明细汇总，同会话前文可能再次计入输入/缓存；不得把缺失字段当0。取消没有response.done的轮次usage未知，不等于0费用。此次未读取控制台账单或实扣金额，因此没有实际美元/人民币成本结论。官方价格与缓存计费说明以[API易文档](https://docs.apiyi.com/api-capabilities/realtime/overview.md)及账单为准。

## 暂定模型选择

- 默认候选：Qwen Flash + server_vad。基线E2E P50最低(1810.8ms)，provider观察TTFA也低，四模型真实取消中可用；实际总延迟仍未达标。
- 旗舰候选：GPT 2.1。基线E2E P50 1870.9ms、最小1494.6ms、完整5轮与取消通过；不将这些数据推导为中文自然度或复杂推理已优胜。
- 低成本候选：Qwen Flash。基于官方音频定价和实际usage，非实扣账单排名；GPT Mini在本次配置的延迟更高，不能仅因mini名就选作默认。
- 备用模型候选：Qwen Plus，已跑通相同设备协议；若需要另一协议族候选可用GPT Mini，但本轮较慢。这些仍共用API易，不能当作独立Provider故障切换。
- 不提供伪造的30/20/20/10/10/10加权总榜：中文理解/自然度人工评分、实际账单、足够稳定性样本缺失。上述只作为继续开发的候选配置。

## 代码与验证

- 新增server/acceptance.js和acceptance-audio.js：有界付费验收、时间点、迟到音频/取消/重连、CPU和队列计数；不进入固件。
- 修改smoke.js：可选5次文本样本和TTFT/总延迟；必须stream_completed才算音频成功，修复部分音频后断连仍报告成功。
- 修改Provider：错误保留固定安全原因和数字HTTP状态；新增server_vad静音时长配置；不打印原始错误体。
- 修改OutputStream：可选20/40ms片长，默认仍20ms，上限与队列限制不变。
- DeviceSession增加固定白名单协议失败原因日志；未重构核心Session、Companion、HTTP、Wi-Fi或硬件适配。
- 新增/扩展Server离线测试，补充Qwen ACK早于cancel的真实事件次序回归，保护分片拼接/flush、输出sequence与大小、部分音频不误判、HTTP错误脱敏和VAD字段。
- host、平台、SDK、ESP-IDF、原package-lock修改均保留；设备协议、固件生产路径未改变。最终回归结果见CODEBASE_DOC.md更新。

## 复现命令

从firmware执行，凭证已由Server环境/既有本地加载入口读取，不在命令中放Key。

```bash
npm run server:smoke:text
AI_REALTIME_MODEL=gpt-realtime-2.1 REALTIME_TEXT_SAMPLES=5 npm run server:smoke:text
python3 mods/my_companion/server/tools/generate-test-wav.py
AI_REALTIME_VAD=server_vad REALTIME_WAV=/tmp/companion-acceptance-audio/hello.wav npm run server:smoke:audio
AI_REALTIME_VAD=server_vad node --import ./mods/my_companion/simulator/register.js mods/my_companion/server/acceptance.js /tmp/companion-acceptance-audio/hello.wav
REALTIME_PROVIDER=apiyi AI_REALTIME_VAD=server_vad REALTIME_WAV=/tmp/companion-acceptance-audio/hello.wav npm run simulator
```

生成脚本只生成固定测试语音，需系统已存在libespeak-ng与ffmpeg；不安装依赖、不读取Key、不联网。默认音频冒烟10秒预算不变；显式acceptance允许≤20秒，每次最多6条、不自动遍历所有模型。模式ACCEPTANCE_MODE=interrupt/reconnect/graceful-reconnect/network-reconnect；voice-interrupt需依次提供初始语音和打断语音两个WAV，分片ACCEPTANCE_PROVIDER_CHUNK_MS=20/40/60与ACCEPTANCE_OUTPUT_CHUNK_MS=20/40，不能将其当作真实硬件分片配置。

## 尚未验收

CoreS3 Microphone / Speaker / I2S Full Duplex / Real Wi-Fi / TLS/CA / Device Clock / Real CoreS3 E2E 全部UNVERIFIED。AUDIO_DUPLEX_UNVERIFIED与TIME_UNVERIFIED安全门控保持。未验证真人回声/AEC、四模型完整自动语音barge-in矩阵、长期稳定性，也未完成四模型×两VAD×全部中文场景的完整矩阵。

真实WSS和Linux模拟播放成功，不代表真实机器人已经发声。用户说完后真实CoreS3多少ms发声：**当前未测**。


最终回归：npm test **540**（404+95+41）、realtime:test **37**、server:test **41**、独立Phase1/2 **59** 全通过；lint/format通过（1条原有host info）。MOD BUILD SUCCESS，退出0，66331字节，sha256 `62427768524ab7abc61ed378a23e799a6066c4cf110ecd8cd743c2ba69d7418c`。
633个受保护文件与开始快照一致；详情见[verification.json](./results/2026-10-17-apiyi/verification.json)。

### 文件清单

| 新增文件 | 职责 |
|---|---|
| server/acceptance.js | 独立显式付费音频/取消/自动VAD打断/重连计时验收 |
| server/acceptance-audio.js | 有界测试分片与完整流成功判定 |
| server/tools/generate-test-wav.py | 固定中文机械语音WAV生成，非产品TTS |
| server/tests/acceptance-audio.test.js | 分片、序号、40ms边界与半截音频不误判回归 |
| docs/PHASE4_ACCEPTANCE.md、docs/results/2026-10-17-apiyi/* | 真实数字、失败试验、验收口径和验证证据 |

| 修改文件 | 原因 |
|---|---|
| firmware/package.json、server/package.json | 增加显式server:acceptance命令，无依赖/lock变更 |
| server/smoke.js | 5次文本计时、错误脱敏、stream_completed门槛 |
| server/output-stream.js | 可选40ms测试输出，默认20ms和原上限不变 |
| server/device-session.js | 只输出白名单失败原因便于真实定位 |
| server/providers/apiyi/apiyi-realtime-provider.js | 较早ACK取消次序修复，安全HTTP/异常原因诊断 |
| server/providers/apiyi/model-config.js、apiyi-omni-protocol.js、apiyi-ga-protocol.js | 可选server_vad静音参数，分别放入正确协议字段 |
| server/tests/provider.test.js、protocol.test.js | HTTP脱敏、早ACK隔离、VAD字段行为回归 |
| docs/CODEBASE_DOC.md、REALTIME_PROTOCOL.md、APIYI_REALTIME.md | 同步真实验收结果和限制 |

仅修改Server及桌面验收路径；设备v1协议和固件生产文件没有改变。
