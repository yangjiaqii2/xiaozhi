# Phase 4.6 验收报告

日期：2026-10-18（Asia/Shanghai）。本轮真实连接自有 Server → API易 WSS；输入为已有 espeak 中文 WAV 的实际PCM样本，播放为 Linux MockAudioOutput 采样时钟。没有 CoreS3，也没有 Linux 声卡声学测量。

原始记录：[本轮 summary.json](results/phase46-20261018T054456Z/summary.json)；每次试验的 JSONL、逐轮 trace、失败、红绿测试日志、构建与保护哈希均在同一新目录。Phase4/4.5文件未覆盖。百分位采用 nearest rank；小样本P95不代表长期SLA。

## 1. 本轮结论

- PCM活动提示显式启用时，四模型实际音频流均可自动打断、立即本地停播并继续对话。22个有完整活动候选埋点的取消轮次：候选→检测P50 **59.79ms** / P95 **61.48ms**，检测→stop调用P50 **0.134ms** / P95 **0.240ms**，检测→buffer清空P95 **0.397ms**；旧轮有效写入泄漏 **0B**。这是Linux函数/采样数据指标，不是CoreS3声学停止。
- 固定总时长与活跃流混淆的工具缺陷已修复：新显式入口按30秒无音频进展判停滞，并保留单次180秒成本上限。长回复四模型各2次全部完成；Qwen Plus原始80字指令+取消后继续回答也单独完成一次。没有证明历史“偶发超过60秒”的Provider内部原因已经消失；不能宣称任意长回复均已通过。
- 主矩阵 **81次：79成功/2失败**；另有对照、先导及复验9次，全部可观测记录共 **90次：88成功/2失败，97.78%**。两处失败均保留：重连后历史错误误判、最终WAV对应轮次被取消后工具完成关联错误。对应修复后复验通过；不把首次失败删除或改成成功。
- **E2E TTFA仍未达到1000ms。** 本轮没有默认更换模型、VAD、20ms分片、设备16k/24k协议；没有删除限流/有界队列/隔离，也没有关闭TLS验证。
- 具备开始“有门控的CoreS3只读诊断、独立音频与时钟联调”的准备条件，**不具备声称真实双工语音验收通过的条件**。

## 2. 开始基线与保护

本轮开始保存git-status-start.txt、baseline-hashes.json；初始已有package.json/package-lock.json修改及整个未跟踪mods/my_companion。未reset、checkout、提交或推送。基线重新执行npm test：**552通过（404 unit +99 simulator +49 server）**。不是照抄Phase4.5结果。

844个已有文件与开始时哈希比较：仅11个授权源码/文档文件变化；无缺失或意外改动。host、原package.json/package-lock.json、HTTP/network硬件、原AudioInput/AudioOutput/AudioRuntime、设备协议、Companion、Provider Adapter及Phase4/4.5历史均保留。SDK板级manifest、实际io/audioin、旧pins/audioin和native audioout的额外SHA256核对均一致。见hash-check.json、sdk-protected-hashes.json。密钥仅经既有Server loader读取；本轮不创建或修改凭证配置。

## 3. P0根因与修复证据

实际调用链：host AudioIn.onReadable → Microphone.onReadable（以AudioIn为this调用）→ hardware/audio-input.js有界读取/分片立即交付 → RealtimeSession.pushInput → RealtimeClient → Server → Provider。没有录完整句再上传，没有网络await阻塞输入回调。

原自动信号只有Provider `input_audio_buffer.speech_started`，经Provider Adapter、DeviceSession、设备控制消息再到RealtimeSession.interrupt。`server/providers/apiyi/apiyi-realtime-provider.js:setOutputPaused`实际调用ws.pause/resume；音频、水位反馈、speech_started、output_item.done同用一条TCP/WSS接收流。上游生成快于24k播放时暂停整连接，会让VAD控制事件排在已积压音频后面。Server不知道远端模型实际何时判定人声，因此**云端检测耗时与TCP阻塞的各自精确占比为UNVERIFIED**，不能把总延迟全归VAD静音窗口。

RealtimeSession原本已先本地interrupt再发cancel，并未等待ACK；本轮没有凭空改成另一种状态机。最小修改确保顺序：playback epoch失效 → 清计时器 → output.stop() → finally buffer.clear() → INTERRUPTED → 异步发送既有response.cancel → LISTENING。stop异常仍清buffer。lastInterruption仅保留一份真实runtime单调事件。

新增 `PCMActivity` / `ActivityInput` 在有效SPEAKING轮次中读取**实际PCM值**：10ms固定样本窗，AC能量+动态范围，默认40ms连续候选；O(1)状态，不缓存整句。触发时先调用既有interrupt，之后上传触发片；不关闭持续采集，不等待网络或云端ACK。重置按session/turn/生命周期隔离。

它是输入活动hint，**不是AEC、语音识别或语义断句器**。静音/DC/低幅噪声/单脉冲的离线回归通过，不等于已能区分真机扬声器回声与人声。`REALTIME_ACTIVITY_HINT=pcm`显式启用；默认仍provider，未默认启用未经硬件校准的门限。Server语义VAD不变。

### 新真实对照：同三段WAV及同50字/10字指令

provider-only每模型1次，PCM提示主矩阵每模型3次；同机公网顺序运行，不是随机化大样本。

| 模型 | 原Provider信号：文件首片→检测ms（n=1） | PCM提示：文件首片→检测P50/P95 ms（n=3） |
|---|---:|---:|
| Qwen Flash | 7458.59 | 121.64 / 122.93 |
| Qwen Plus | 4558.30 | 121.24 / 123.62 |
| GPT Realtime Mini | 4456.70 | 120.61 / 122.84 |
| GPT Realtime 2.1 | 1459.59 | 121.13 / 122.86 |

失败试验若在异常路径未计算旧汇总字段，样本量按实际非null数（Mini旧汇总n=2）；其完整逐轮trace仍参与新候选/stop统计。文件首片含前导静音，不能称人声声学开始；第一片满足样本阈值的候选用firstCandidateAt单列。10ms样本窗与40ms音频持续量不等于同样的墙钟间隔，因为每次调用交付20ms样本。

| 模型 | 有完整hint轮数 | 候选→检测P50/P95 ms | 检测→stop P50/P95 ms | 检测→清buffer P95 ms | cancel wire→本地观察ACK P50/P95 ms | 检测→新输入继续 P95 ms |
|---|---:|---:|---:|---:|---:|---:|
| Qwen Flash | 6 | 20.44 / 61.48 | 0.05 / 0.24 | 0.34 | 579.03 / 1027.66 | 0.61 |
| Qwen Plus | 6 | 20.81 / 61.39 | 0.07 / 0.22 | 0.40 | 419.39 / 797.04 | 0.67 |
| GPT Realtime Mini | 6 | 59.73 / 60.56 | 0.13 / 0.37 | 0.51 | 462.27 / 621.15 | 0.92 |
| GPT Realtime 2.1 | 4 | 60.12 / 61.83 | 0.14 / 0.18 | 0.29 | 378.43 / 507.09 | 0.48 |

本地stop P95≤50ms：**Linux已满足，CoreS3 NOT TESTED**。ACK多数按output_item.done收口；已有结束确认的分支不发迟到无目标cancel；无线确认的RTT填null，不伪装0。5秒fallback未删除，本轮活动wire取消未观测fallback；超时兜底由离线回归覆盖。旧响应的迟到PCM及回调注入、延迟350ms ACK、输入不断、后续新回复完成由activity-wire.test.js明确验证，它是**离线本地WS fixture**，不计真实API成功。真实旧包没有到达时不声称实际观察到丢包；零泄漏只证明收到的数据没有在已取消轮次写入。


新一轮首音频仍需模型/VAD处理，不能把“输入已恢复”当成“新回复已到达”。按同session后继turn实际firstAudioAt统计：

| 模型 | 检测→后继首音频P50/P95 ms |
|---|---:|
| Qwen Flash | 3137.95 / 5162.18 |
| Qwen Plus | 3469.24 / 4513.46 |
| GPT Mini | 3453.59 / 6490.59 |
| GPT 2.1 | 4031.33 / 8945.58 |

## 4. P1长回复：持续输出与完成关联

历史Plus超过60秒时，仍有37440B Server排队且无done；当时没有精确末delta时间，不能断言是生成停滞或客户端未收口。原工具把固定25/60秒预算耗尽归为ACCEPTANCE_TIMEOUT，与播放消耗时长混淆。新ProgressDeadline只用于显式验收：输入结束后的实际收音频字节/调度播放字节有进展就刷新30秒idle计时；180秒成本上限独立错误码。生产原有5秒慢消费者保护、Provider连接超时、取消收口和客户端边界均不改变。

另发现一次工具相关假停滞：Mini已完成turn3的105600B逐片播放，队列0，工具却仍等待被取消的turn2完成，30秒后报STREAM_STALLED。现最终上传的输入轮次只可由本轮完成，或**该轮有实际取消记录后、同session更晚完成的后继轮**满足；其他session、较早回复及已取消回复都不能满足。新增失败→修复→通过回归，原失败不改写。raw JSON记录completion_expected/observed/cancelled，逐轮trace保留每次response ID；不能用一个旧回复的结束冒充最后一句问候的响应。

### 四模型独立长回复（各2次，原80中文字北京指令；毫秒）

| 模型/样本 | Provider/Device/Playback B | 首delta→末delta ms | 末delta→Provider done ms | Provider done→末片播放完 ms | Server峰值B/积压ms | 临时背压次数 | 结果 |
|---|---:|---:|---:|---:|---:|---:|---|
| Qwen Flash/1 | 652800/652800/652800 | 12920.02 | 0.35 | 700.62 | 54720/1140.00 | 20 | PASS |
| Qwen Flash/2 | 925440/925440/925440 | 18680.24 | 0.56 | 620.39 | 54720/1140.00 | 29 | PASS |
| Qwen Plus/1 | 1751040/1751040/1751040 | 35319.77 | 641.68 | 540.59 | 54720/1140.00 | 56 | PASS |
| Qwen Plus/2 | 936960/936960/936960 | 18360.30 | 640.50 | 539.96 | 60480/1260.00 | 29 | PASS |
| GPT Realtime Mini/1 | 854400/854400/854400 | 16540.58 | 760.03 | 522.62 | 72960/1520.00 | 22 | PASS |
| GPT Realtime Mini/2 | 948000/948000/948000 | 19080.02 | 0.70 | 690.91 | 72960/1520.00 | 24 | PASS |
| GPT Realtime 2.1/1 | 996000/996000/996000 | 19880.25 | 0.50 | 890.96 | 72960/1520.00 | 25 | PASS |
| GPT Realtime 2.1/2 | 1339200/1339200/1339200 | 27694.59 | 0.47 | 839.32 | 65280/1360.00 | 33 | PASS |

全部长回复最终字节数一致、逐片消费、done后完成播放，未扩大192000B Server/7680B客户端上限；字节数相同不等同内容hash相同或声音自然度通过。输入文件末片T0、含尾静音的transport_input_last_chunk、首/末delta、Provider done、playbackCompletedAt、usage等均保存在对应jsonl/trace；两种“末输入”不能混用。

额外 `qwen-plus-original-60s-replay.jsonl` 完全保留原80字Server指令、北京→停下两段WAV、provider-only模式；本次整段工具等待约38.95秒，取消后response完成，队列最终0。这次未重现历史超过60秒；因此结论是**固定deadline误判已修复且本轮场景通过，历史上游为何偶发超长仍UNVERIFIED**，不是声称Plus生成故障完全根治。连续消费超过130秒的离线时钟测试证明不再被旧60秒截止杀死，但不冒充130秒真实Plus样本。

## 5. 四模型短回复性能与Phase4.5对比

20ms默认、同一句中文WAV及≤15字指令；每模型2个真实WSS会话，每会话5轮。Qwen server_vad、GPT semantic_vad不变。输入16k mono S16LE、输出24k mono S16LE，GPT上采样仍仅Server Provider Adapter。

| 模型 | 本轮成功/尝试 | Provider首音频P50/P95 ms | Linux E2E P50/P95 ms | 历史Provider/E2E P50 ms | Server转发P50 ms | 模拟调度P50 ms |
|---|---:|---:|---:|---:|---:|---:|
| Qwen Flash | 10/10 | 290.53 / 477.88 | 1725.33 / 2131.46 | 272/1737 | 0.03 | 19.89 |
| Qwen Plus | 10/10 | 381.89 / 484.59 | 2006.22 / 3452.95 | 393/1817 | 0.03 | 20.28 |
| GPT Realtime Mini | 10/10 | 819.61 / 1027.40 | 2021.09 / 2236.96 | 818/2024 | 0.04 | 20.19 |
| GPT Realtime 2.1 | 10/10 | 825.52 / 1192.07 | 4139.60 / 7994.33 | 692/1906 | 0.03 | 19.98 |

首有效delta立即进入OutputStream并向设备发binary，不等response.done，不缓存完整WAV/response。40个短回复first_audio_before_done均true。Server转发P50约0.03ms、模拟jitter约20ms，解释不了秒级等待；本轮没有为TTFA删jitter/限流/隔离。Flash/Mini与历史近似，Plus/GPT2.1变慢；尤其GPT2.1的输入末片到response.created等待增加。顺序公网小样本不能证明代码导致模型端加速/退化。没有重新跑40ms对比（本轮NOT TESTED），不复用旧40ms冒充新结果。

### 指标事件定义

所有可相减时刻来自同进程performance.now()，按requestId/sessionId/turnId/Provider responseId关联；不能跨进程相减。

| 指标 | 起止事件 |
|---|---|
| 自动活动检测 | 第一片达到阈值的候选送入detector → detectedAt；文件首片→检测另列且含前导静音 |
| 本地停止调用 | detectedAt → stopInvokedAt；stopReturnedAt仅函数返回，不是声学停止 |
| 缓冲清空 | detectedAt → bufferClearedAt，remainingBufferBytes实测0 |
| 取消收口 | cancelSentAt → cancelAcknowledgedAt；后者是Adapter本地观察output_item.done/完成事件，不是远端内部时钟 |
| 恢复输入 | detectedAt → inputResumedAt；继续上传不等待ACK；下一次firstAudioAt按新turn单独保留 |
| Provider TTFA | 本地收到provider response.created → 本地收到首有效audio delta |
| Server转发 | 首audio delta进入output.push(T4) → 首binary send调用(T5)，不是送达ACK |
| Linux调度 | runtime收到首帧(T6) → AudioOutput.write(T7)，不是声卡发声 |
| Linux E2E TTFA | 最后一片文件PCM发送前T0 → 模拟AudioOutput.write(T7)，不含附加VAD静音尾 |
| 完整响应延迟 | response_done − T0 |
| 播放完成延迟 | 最后片真实模拟回调完成 − T0 |

远端API易实际收到/确认输入、模型内部首delta生成、真实Mic起始、真实扬声器起止均null/UNVERIFIED。voice-interrupt包含多个响应，旧顶层T0/T7保留但**不作为新轮TTFA**；分阶段取消/新响应看trace内相同turn，不混合旧新首包与done。早期trace的newInputTurnId曾被后续输入覆盖，本轮末期已改为只取首个；inputResumedAt一直只取第一次，不用早期ID推算跨轮延迟。

## 6. 失败分类、重连与资源

Phase4.5的9个失败逐条追溯到原文件/行号/requestId/错误/队列：[phase45-failures-classified.json](results/phase46-20261018T054456Z/phase45-failures-classified.json)。2个明确客户端BUFFER_OVERFLOW；2个25秒固定工具预算；2个60秒长回复预算；1个旧取消完成竞态；2个早期事件不足UNKNOWN。历史未记录的重试次数/末delta均null，不能倒推。

本轮所有90个有真实API证据的试验：88满足对应成功条件/2失败；其中主矩阵79/81。与历史101/110（91.82%）相比观测成功率升高到97.78%，但样本场景、样本量、测试条件不同，**不能宣称统计显著改善或长期API可用率**。短回复40/40，独立长回复8/8、主矩阵三段打断11/12、连续三轮12/12；一条Mini打断失败是工具完成关联错误，其最终音频实际已播完。重连主矩阵7/8满足工具成功条件，Flash复验2/2；首次失败保留。另原Plus续答1/1、Provider-only对照4/4、先导2/2、Mini复验1/1。

| 本轮失败 | 实际证据/根因 | 修复及复验 |
|---|---|---|
| Flash reconnect第2轮 PROVIDER_UNAVAILABLE | 新session已CONNECTED并有新音频，lastError仍保留旧Provider断开；工具误用诊断历史 | activeSessionError按当前状态与预期SID判活，不清历史；retest-flash-reconnect两轮均完成 |
| Mini barge第2组 STREAM_STALLED | turn3的105600B已完成、queue0，工具等待已取消turn2；不是Provider无输出 | TurnCompletion记录显式取消继承与最终完成；retest-mini-barge-completion最终新回复859200B完成 |

两次失败类型分别为工具错误历史、工具轮次关联；1次超时计入总数。不额外记预期terminate产生的旧session PROVIDER_UNAVAILABLE为“API随机故障”，但绝不抹掉工具失败试验。1个空的retest-mini-barge.jsonl是一次启动器未返回任何事件的中止，标ORCHESTRATION_ABORTED/NOT OBSERVED，不计成功；是否实际到达上游无法证明，成本不可据此估算。

本轮未观察到首次WSS建连超时、首音频超时、永久OUTPUT_BACKPRESSURE、BUFFER_OVERFLOW、取消fallback、协议错或实际恢复失败。错误分级并未删除：connect/stream阶段、attempt、失败前queue及provider_retry数字日志已增加。不能主动制造API易5xx，本地503/超时/持续慢消费者/断线旧包/重试耗尽是离线回归，不叫真实API故障注入。

主动terminate后新session重新执行voice/VAD/格式配置，旧SID/responseID隔离保留。主矩阵实际执行7次强制断连（Flash第2轮在注入断连之前被工具历史错误误判而退出），Flash另复验2次：共9次真实Provider断连恢复成功。原Flash失败试验已收到上一次恢复后的新轮音频，不等于又完成了一次强制重连。

| 模型 | 记录到的成功恢复n | 重连P50/P95 ms |
|---|---:|---:|
| Qwen Flash | 3 | 3094.43 / 4001.91 |
| Qwen Plus | 2 | 3245.36 / 4940.23 |
| GPT Realtime Mini | 2 | 2950.83 / 3936.01 |
| GPT Realtime 2.1 | 2 | 2679.46 / 4029.58 |

上表n合计9；Flash原失败trace证明上一轮重连后的session已就绪，未把它额外当成一次重连。观测到54次Provider连接建立尝试及129个response.created事件（一次试验可能多response）；不是90笔账单请求。所有有完整连接计数的进程实际次数符合初始连接+显式断连重连，未观察额外重试；无法从早期空启动记录推断是否消耗额度。未自动重跑失败批次，复验显式另命名。生产有限重连/连接超时/250、500ms Provider退避和5秒取消上限均保留。

40个逐轮观察trace退出时Session计时器0、音频缓冲0、input handler释放、output timer释放、Server sessions0、Provider timers0；Provider关闭标志true，新版trace实际socket状态3。早期未记录socket状态则null/NOT TESTED，不补造。每个已关闭Provider留1个防未处理error的空监听器，是固定数量；观察器finish释放Provider引用，不随多轮累加音频任务。全部12次三段对话最终新回复逐片完成，另每模型单会话三轮以及两会话各5轮均完成；没有实体机器无法验收长期native内存。

## 7. usage与成本

以下只汇总本轮每模型10次短回复实际返回字段；取消/未返回usage时保持null。不是按音频字节换算token，不猜人民币成本。

| 模型 | Audio In | Audio Out | Text In | Text Out | Cached |
|---|---:|---:|---:|---:|---:|
| Qwen Flash | 560 | 206 | 5260 | 100 | null |
| Qwen Plus | 560 | 267 | 5260 | 100 | null |
| GPT Realtime Mini | 708 | 298 | 710 | 664 | 768 |
| GPT Realtime 2.1 | 708 | 504 | 772 | 414 | 512 |

## 8. 修改文件与边界

下列均在mods/my_companion；旧文件仅小范围修改，不重构Companion。hash-check列出本轮已有文件的精确变化，未跟踪目录不会依赖git diff才能辨认。

| 文件 | 原因 |
|---|---|
| ai/pcm-activity.js、ai/activity-input.js（新增） | 有界、实际样本活动hint与输入装饰器，stop优先、采集持续 |
| ai/realtime-session.js | 先使播放epoch失效/stop，finally清buffer；单份单调打断事件 |
| manifest.json | 注册两个纯JS模块，真实硬件driver不变 |
| simulator/apiyi-simulator.js | 显式注入PCM活动adapter，默认不变 |
| hardware/diagnostics.js | 只读phase/STOPPED/实际打断耗时/物理场景UNVERIFIED |
| server/progress-deadline.js（新增） | 进展watchdog、成本上限、活跃SID判定、最终轮完成关联 |
| server/phase46-observer.js、phase46-acceptance.js（新增） | 有界逐轮真实埋点与显式付费入口，资源释放等待与安全JSON输出 |
| server/acceptance.js | 可选observer/watchdog；修正历史错误及已取消轮完成关联，保留旧CLI预算 |
| server/device-session.js | provider失败阶段/次数/清理前队列数字日志；设备error协议不变 |
| server/tools/benchmark-phase46.py、summarize-phase46.py（新增） | 显式有限付费复现与离线可重算统计，不处理密钥 |
| simulator/tests/activity-input.test.js、realtime-stop-order.test.js（新增） | 实际样本门限、stop不等待ACK、输入持续、旧回调/stop异常清理 |
| simulator/tests/diagnostics.test.js | 新只读耗时及UNVERIFIED行为 |
| server/tests/progress-deadline.test.js、activity-wire.test.js（新增） | 130秒有进展、无进展超时、SID/历史错/最终取消后继、本地WS流式打断恢复 |
| server/tests/relay.test.js | 实际provider失败阶段和重试次数日志行为回归 |
| CODEBASE_DOC.md、APIYI_REALTIME.md、REALTIME_PROTOCOL.md、本报告、新results | 同步调用链、证据、限制和实际结果 |

新增测试先红后绿日志保留，原测试未删除。既有慢消费者/长输出/断网/重连迟到包与资源释放测试均在本轮server:test执行。

### 复现命令（firmware）

```bash
npm test
npm run realtime:test
npm run server:test
npm run simulator                 # 默认Mock，仅启动/状态/退出验证
# 真实交互显式开启，不把默认Mock视为API易
REALTIME_PROVIDER=apiyi REALTIME_ACTIVITY_HINT=pcm npm run simulator
# 真实付费矩阵：81个有界试验，不自动补失败批次；WAV目录要含hello/stop/beijing/name/recall
python3 mods/my_companion/server/tools/benchmark-phase46.py /path/wavs /tmp/new-phase46
python3 mods/my_companion/server/tools/summarize-phase46.py /tmp/new-phase46
# 单个真实试验可用ACCEPTANCE_MODE，PHASE46_TRACE必须是新文件
REALTIME_ACTIVITY_HINT=pcm ACCEPTANCE_MODE=normal PHASE46_TRACE=/tmp/new-trace.json \
node --import ./mods/my_companion/simulator/register.js mods/my_companion/server/phase46-acceptance.js /path/input16k.wav
source /home/yang/.local/share/xs-dev-export.sh
npm run mod:build -- mods/my_companion/manifest.json
```

Key不在上述命令行中，工具不打印Authorization、PCM、完整模型文本或敏感上下文。原始中文WAV元数据和SHA256见wav-metadata.json，不把合成WAV声学自然度当作真人评测。

## 9. 回归、构建与密钥检查

| 检查 | 本轮结果 |
|---|---|
| npm test | 565通过：404 unit +105 simulator +56 server，退出0 |
| npm run realtime:test | 38通过，退出0 |
| npm run server:test | 56通过，退出0 |
| npm run simulator | s/q启动、查看状态、正常释放退出0；这是默认Mock启动验证 |
| Biome check companion | PASS；新结果JSON只格式化空白，历史数据不改 |
| npm run lint / npm run format | PASS；保留原host空constructor的1条info，无新增错误 |
| git diff --check | PASS；未跟踪新源码另由Biome/实际测试覆盖 |
| 密钥扫描 | Git可见文件+已编译MOD均无配置Key/常见凭证命中；详见key-scan.json（仅路径/行号输出） |
| 保护哈希 | PASS，844个已有文件核对，无意外修改/丢失；SDK4个关键文件不变 |
| MOD | BUILD SUCCESS，退出0；不等同真机功能通过 |

产物：`/home/yang/code/myapp/xiaozhi/stack-chan/firmware/dist/bin/esp32/debug/my_companion/my_companion.xsa`；**73749B**；SHA256 `2c29529c5128a18ed560d8b38b093bd05d5f624196f145cee0260858d30dbd45`。

## 10. CoreS3诊断与到手步骤

本轮重新核对：host/modules/audio/audio-in.js实际映射`embedded:io/audio/in`，实际C源码是SDK modules/io/audioin/esp32/audioin.c；16384B native ring、MAX_INPUT_BLOCK2048、read超时50ms、pendingCallback合并回调，不能据此保证20ms回调。此前旧pins AudioIn说明不足，本轮已在CODEBASE_DOC补正。MOD保证每片≤1280B立即交付，硬件实际采集节奏仍未知。

板级RX/TX均I2S1，BCK34/LR33共享；请求输入16k/输出24k，native分别创建资源，共享时钟与全双工兼容性无硬件证据。未改host/SDK/IDF/native C，也未臆造重采样方案。保留AUDIO_DUPLEX_UNVERIFIED与TIME_UNVERIFIED门控。

手动Drawer `Companion: diagnostics` 为只读入口，不创建AudioIn/AudioOut，不读音频、不自动录音/发声。构建元数据只说明预计版本1.1.0/板型；物理探测UNKNOWN。WiFi读实际Controller；microphone.recording来自真实host getter，未初始化时UNKNOWN。speaker初始化、CA验证、声学起止及真机场景返回UNKNOWN/UNVERIFIED。运行中的Realtime若由owner注入可显示连接状态、有限计数、最近白名单错误和最后一次分段打断耗时；未注入则UNKNOWN，不能把源码能力当检测结果。

设备到手依次执行：

1. 刷入本轮MOD，手动打开诊断，保存构建/目标/真实AP连接状态，确认没有自动音频任务。
2. 单独验证WiFi断开/恢复、重启后连接；记录真实状态与错误，不记录密码。
3. 证明设备时间来源与可信更新、CA链和拒绝错误证书/错误时间；TIME_UNVERIFIED未获证据前不解除，绝不降级HTTP/关闭证书验证。
4. 用户触发独立Mic短采集与Speaker短播放，验证格式/采样率、资源错误、stop/flush；保存初始化状态。
5. 测I2S1共享资源与16/24k全双工，检查引脚时钟、持续采集/播放、回声。失败则停在安全adapter层，不改native凑数。
6. 双工与TLS安全门通过后才显式连接自有WSS；先Provider VAD，再校准PCM活动门限/AEC需求，测静音、风噪、扬声器回授和人声误触发。
7. 用外部录音/示波器测真实人声开始→停声、说完→首声音，与SID/turn/request和函数时刻关联。Linux的0.24ms stop调用P95不是声学结果。
8. 测播放中打断、取消后立即新对话、长回复/连续多轮、AP恢复、Provider重连与设备重启；检查heap/native资源、监听器/定时器与旧音频隔离，再决定是否解除门控。

**CoreS3 Microphone / Speaker / I2S Full Duplex / Real Wi-Fi / TLS/CA / Device Clock / Real CoreS3 E2E：全部UNVERIFIED。** Linux真实WSS成功只验证Linux证书/时钟与API链路。真人中文识别/自然度、声卡听感、超长回复长期稳定性、真实API5xx注入、任意回声环境检测均未验收。

## 11. 明确回答验收问题

- 自动打断为什么慢？旧信号依赖远端VAD和被音频流控pause的同一WSS；本地stop原本就不等ACK，不能靠缩静音窗口掩盖。显式PCM活动hint把本地停播从该控制链中解耦。
- stop调用P95达到50ms吗？Linux真实API链路中22个有效hint轮P95=0.240ms，达标；物理声学停止仍UNVERIFIED。
- 自动检测还多慢？候选样本进入检测→触发P50/P95=59.79/61.48ms；文件首片→触发约121ms（含WAV前导静音），真实Mic声学检测NOT TESTED。
- Qwen Plus长回复解决了吗？工具固定deadline与最终轮收口误判已修复，本轮两次独立长回复及原始取消续答都通过；历史上游偶发超长的内部原因未证实消失，不能宣布彻底解决。
- 成功率改善了吗？观测88/90=97.78%，历史101/110=91.82%；场景/分布不同，仅为客观计数，不是统计因果结论。首次2次工具失败保留。
- 还有背压/超时/重连失败吗？临时水位流控仍必要（逐轮trace合计504次）；永久容量/消费者停滞/缓冲溢出本轮0；保留1次工具误判STREAM_STALLED及1次历史错误误判；对应复验通过。不能说全部首次试验均通过。
- E2E低于1000ms了吗？没有。Flash/Plus/Mini/GPT2.1短回复Linux P50分别约1725/2006/2021/4140ms；不是CoreS3实际发声时间。
- 可以开始真机吗？可以开始有门控的诊断和分模块联调；真实双工、可信时间、TLS/CA、声学打断/首包和回声都需实体CoreS3验证。

官方语义依据：[API易 Realtime文档](https://docs.apiyi.com/api-capabilities/realtime/overview.md)；ws pause/resume/send已复核官方文档及安装源码。服务端文档字段不作为未知硬件API的替代证据。
