# Phase 4.7 验收报告

日期：2026-10-18。范围：CoreS3只读诊断、受门控的设备侧生命周期组合、音频异常清理、I2S源码分析及到货验收准备。**没有实体CoreS3，真实设备实时语音闭环未验收；不能称为已经打通真机双工。**

原始证据：[本轮目录](results/phase47-20261018T082608Z/real-summary.json)。Phase4～4.6历史未覆盖。运行`npm run scan`退出0但提示`No available devices found`，不把CLI成功当作找到/验证硬件。

## 1. 实际完成与限制

- 只读诊断保留旧快照，新增每项id/item/status/evidence/checkedAt/reason/nextStep/value；状态枚举PASS/FAIL/UNKNOWN/UNVERIFIED/NOT_TESTED。有界条目，无录音/播放/上传/持续音频任务，失败observer不崩溃，密钥/原始错误不进入报告。
- 新DeviceVoice只组合现有RealtimeSession、ActivityInput、AudioRuntime/WSS Runtime；不重写Companion/Provider/设备协议。增加明确告知mic+upload+playback的手动START、STOP、interrupt；Companion退出前释放voice。默认enabled=false，未注入时间/双工/全局独占证明，实际启动继续拒绝。
- 修复经红绿测试确认的输出初始化/入队/start失败残留、输入初始化+stop同时失败掩盖原错误/残留回调，以及输入采集中错误未通知Session的设备组合缺口。
- 增加同runtime、同requestId/sessionId/turnId的一份lastAudioTrace；缺少远端或声学观测填null。增加关闭后有界JS资源快照，不宣称native资源已验证释放。
- 完成本机实际ESP-IDF6.0.2/Moddable板级与native配置审计，保留双工阻塞；不创建未经证明的重采样/共享I2S方案。
- 有限真实API易：Qwen Flash文本2轮、音频1轮，3成功/0失败；不重新跑Phase4.6大矩阵，不将离线fixture计为API易成功。

**不能直接启用真机语音**：当前host没有公开覆盖TTS/WebRadio/Speaker的全局排他lease、没有可读取的认证时间证明，且16k/24k共享时钟与槽位配置未验证。mod没有注入readiness或设备凭证provisioning回调。只把enabled、duplexValidated或timeTrusted改成true不是验证，也不能作为验收步骤。

## 2. 初始状态与保护

真实Git根为`/home/yang/code/myapp/xiaozhi/stack-chan`，命令在firmware执行。初始已有package.json/package-lock.json修改、整个mods/my_companion未跟踪；没有reset/checkout/提交/推送或覆盖用户工作。

开始保存git-status-start.txt和984个已有文件SHA256。重新执行基线npm test：**565通过（404 unit+105 simulator+56 server）**。另核对5个SDK/IDF关键源文件，涵盖目标manifest、实际io/audioin、native audioout、I2S std驱动及版本声明。结束时仅14个授权已有文件改变，无缺失/意外变化；host、根package/lock、原HTTP/WiFi/Provider、Phase4～4.6历史保持。详见hash-check.json。

## 3. 诊断入口与状态解释

设备MOD启动后手动打开Drawer：**Companion: diagnostics (read only)**。每项单独输出`[Diagnostics]` JSON行，避免一次序列化整个大报告。无需AI Server或音频启动即可查看构建元数据和未知项。

- 构建目标/版本为源码元数据，实体板型UNKNOWN；mod.loaded只在onContextCreated入口观察为true。
- CompanionState、WiFiController、Session状态、音频adapter成功片数、AudioBuffer占用、播放epoch、轮次、timer/socket引用读取既有真实对象，不创建新驱动。PASS在这些条目表示该**软件观察**成功，不表示物理音频或无线验收。
- 输入native ring填充/DMA占用和TCP积压没有现有JS观测接口，保留null；socket writable credit不能伪装成设备消费队列。
- WSS策略强制verify=true、TLS1.2最低版本和可信时间门。explicitCAConfigured仅表示调用方传入CA，内建根证书存储UNKNOWN。handshakeObserved只表示Runtime观察到连接可写，不代替实体证书试验。onError缺少可用细分原因为TLS_OR_WEBSOCKET_ERROR，不能伪造“确定是CA过期”。
- 检查时间来自本地Time.ticks；系统日期不可信时仍可记录单调ticks，不以日期阈值证明可信时间。跨机器时钟不得直接相减。
- 诊断字段通过白名单/数值范围清洗；不输出配置token、CA内容、URL凭证、PCM或转写。重复执行不改变音频或网络状态。
- 当前/停止后JS timer、buffer、socket引用有界保留；native释放仍UNVERIFIED。初始化返回或recording=true不等于采样/声音质量通过。

离线静态快照见offline-diagnostics-final.json；其clock来自Linux loader，物理八项仍全部UNVERIFIED。该文件不是设备日志。

手动Voice START标签明确告知会采集、上传和播放；但默认配置返回REALTIME_DISABLED。若仅启用配置，readiness仍拒绝TIME_UNVERIFIED/AUDIO_DUPLEX_UNVERIFIED/AUDIO_OWNERSHIP_UNVERIFIED。STOP/interrupt不启动任何新任务。当前没有绕过所有权的Mic/音箱“假测试按钮”；单向主动检查仍需受控harness与真实资源证明，详见清单前置条件。

## 4. I2S与全双工分析

详细证据：[CORES3_I2S_ANALYSIS.md](CORES3_I2S_ANALYSIS.md)。

| 项目 | 已从本机源码确认 | 实机结论 |
|---|---|---|
| 控制器/引脚 | RX/TX I2S1，BCK34/LR33共享；DIN14/DOUT13 | UNVERIFIED |
| native入口 | host audio-in→embedded:io/audio/in；SDK io/audioin/esp32/audioin.c；TX pins/i2s/audioout.c | 未测试实体安装二进制 |
| 格式/时钟 | RX native双槽PHILIPS→JS mono16k；TX mono LEFT/MSB24k；native各自MASTER分配 | 同步兼容UNVERIFIED |
| 本机驱动 | IDF6.0.2标准模式自动配对比较完整归一化配置；相同时才full_duplex/后初始化MASTER转SLAVE | 当前不同配置不满足该配对分支 |
| GPIO路由 | 非配对重复输出GPIO会警告，仍设置输出信号路由；初始化顺序有影响风险 | 具体错误/失真需测量 |
| DMA | RX默认6×240 frame、16384B ring；TX两DMA descriptor和独立任务 | 不能仅据此说DMA必冲突或必安全 |
| 回调/线程 | RX pendingCallback合并通知；TX native I2S write可等待 | 真实callback周期/饿死/丢片未测 |

ESP32-S3硬件可以在独立GPIO下独立运行RX/TX，不能因“同I2S编号”就判不支持；但本板共享WS且请求16/24k，不能称为互不干扰。源码风险比单纯采样率更多：slot/bit_shift/GPIO方向/MCLK也不同。本机配对实现比在线文档的兼容说明严格，以实际安装源码为准。

Server中GPT GA的16k→24k上采样保持仅在Provider Adapter，Qwen不转换；没有重复重采样。它**解决不了板上时钟冲突**。统一24k采集并在MOD降到16k，需要先证明codec/slot/初始化兼容、实现抗混叠降采样和全局独占；现有host Microphone.start未提供sampleRate参数，现有Server转换器也不做24k→16k降采样。单独把采样率数字改成一致没有充分依据，本轮不这样做。

重采样CPU/音质/附加群延迟均NOT TESTED；没有用Linux CPU模拟ESP32结论。若现状实机不兼容，需用户另行决定允许最小host/native适配、板级支持方案或明确半双工产品行为；本轮约束内不做这类修改。

## 5. 已修复问题及红绿证据

| 问题 | 原因 | 修复/实际证据 |
|---|---|---|
| AudioOutput异常残留 | Volume、RawSamples enqueue或start失败后，native引用/pending/samples未在write异常路径释放 | write异常调用现有stop/Flush/close，保留原异常；3个失败路径均先红后绿 |
| AudioInput双故障 | start异常后stop也异常会遮盖原错误；handler引用未finally清除 | 恢复onReadable所有权，finally清引用，保留原初始化异常；异步readable关闭异常不逸出 |
| 输入错误未通知Session | AudioRuntime输入onError默认空回调，错误可能仅停Mic而Session继续活着 | DeviceVoice注入onError→既有Session.lost；三轮后注入实际回调错误，buffer/handler清理后可重启 |
| 退出/重复启动 | 之前mod没有原生Realtime生命周期owner | DeviceVoice显式门控、单Session、退出先dispose、释放一次外部lease；外部lease抛错也不遗留引用 |
| 鉴权拒绝难追踪 | Server在创建Session前拒绝，没有对应诊断事件 | 新增handshake_rejected，仅固定code+HTTP状态；401请求不创建Provider且日志不含token |
| 阶段指标缺少设备关联 | 旧session级首音频计数不能当作每轮事件 | 每轮一份lastAudioTrace，新SID清旧trace；连续3轮测试各自ID/本地顺序/远端null |

native constructor内部若分配后抛错，MOD可能拿不到实例close；某些SDK native错误只记录日志而不转成JS异常。上述测试不能证明这种native内部资源或“完全不产PCM但没有JS错误”的情形已解决，必须到货观察首片数据和native日志。没有改底层C去掩盖它。

## 6. 流式链路与时钟边界

准备好的组合：Mic facade→AudioInput→可选ActivityInput→原RealtimeSession→原RealtimeClient→WSS Runtime→自有Server→API易→Server有界流控→设备AudioBuffer→AudioOutput。默认没有自动启用。

| 事件 | 当前可观察性 |
|---|---|
| ADC真正采样 | null；SDK未提供可关联的ADC时间戳 |
| PCM回调交付/发送调用 | 本地runtime ticks，关联当前input turn |
| Server收到/Provider收到 | 设备trace为null；不能把send成功冒充远端收到 |
| Provider首delta/Server首发 | 继续用既有Server/Phase46 observer，独立时钟域 |
| 设备首有效audio/播放write调用 | 同一轮lastAudioTrace记录 |
| 生成done/最终播放callback | 各自记录，不互相替代 |
| 声学首声/实际停止 | null/UNVERIFIED，需要外部仪器 |

lastAudioTrace只保留当前或最近一轮，含requestId/sessionId/turnId。inputLastSentAt是该轮传输PCM的最后发送事件，不自动等于人类声学说完，静音尾/云VAD分界必须另行说明。没有将不同机器的timestamp相减。

原始binary header、turn/sequence、20ms默认、16k/24k格式、有界队列与背压、5秒取消收口和有限重连均保留。首片不等response.done；AudioOutput只留一片native样本，其余用现有AudioBuffer。旧epoch/turn/session包继续丢弃。无per-chunk日志，也不把PCM序列化入诊断。UI/日志和音频JS仍共享事件循环，实际设备负载下能否影响播放尚未测，不能保证物理音频不受UI阻塞。

## 7. PCM活动提示现状

默认provider模式；设备owner的activity默认false，mod不自动打开。PCMActivity仅AC能量+动态范围、10ms样本窗、40ms连续样本候选，不是VAD/ASR/情绪识别/AEC。

本轮新增静音/DC/低幅信号、非法PCM/配置、合成键盘样式噪声、纯音样式回声的离线行为覆盖：低幅信号不触发，足够持续的噪声或播放纯音**可以触发**。这是算法局限的证据，不是“真实键盘/风扇误触发率测试”；真实环境误触发与声学回声仍UNVERIFIED。没有提高阈值、增加未经证明的冷却窗口或修改默认VAD。

本地hint在上传当前片前调用既有interrupt，不等Provider ACK，输入不暂停；网络接收pause不直接挡住本地样本检测，但JS事件循环自身拥塞仍需实机测量。playEpoch失效、stop调用、buffer清空与新轮输入保留原单调事件。旧轮回调/迟到包、取消后新轮、Qwen已有ACK后的迟到cancel保护仍由本轮既有回归执行。Phase4.6的0.240ms stop P95、61.48ms候选检测P95仅作为历史Linux数据，**本轮未重跑自动打断延迟矩阵，不能冒充新测量**。

## 8. 有限真实API易与usage

只显式临时选择Qwen Flash，不改默认代码配置；真实自有Server/Provider，无Mock fallback。2轮文本同会话验证上下文，1轮16k mono S16LE合成中文WAV音频；沿用已有smoke、Phase46 acceptance/observer。每个进程外部90秒有限预算，不自动补失败批次；本轮没有调用失败，也没有重试失败样本。

| 测试 | 模型/协议 | 成功/失败 | 首增量/完成耗时 | usage |
|---|---|---:|---|---|
| 文本第1轮 | Qwen Flash/Omni | 1/0 | TTFT 552.87ms；总849.26ms | `{"total_tokens": 44, "input_tokens": 36, "output_tokens": 8, "input_tokens_details": {"text_tokens": 36}, "output_tokens_details": {"text_tokens": 8}}` |
| 文本第2轮 | Qwen Flash/Omni | 1/0 | TTFT 818.61ms；总1535.55ms | `{"total_tokens": 71, "input_tokens": 67, "output_tokens": 4, "input_tokens_details": {"text_tokens": 67}, "output_tokens_details": {"text_tokens": 4}}` |
| 音频1轮 | Qwen Flash/Omni，server_vad | 1/0 | Provider TTFA 337.51ms；Linux E2E 1871.76ms | `{"total_tokens": 519, "input_tokens": 496, "output_tokens": 23, "input_tokens_details": {"text_tokens": 482, "audio_tokens": 14}, "output_tokens_details": {"text_tokens": 8, "audio_tokens": 15}}` |

音频Provider/设备/模拟播放均57600B，首片在response.done前发送。原始日志保存connection/session_ready、队列峰值/积压、chunks、输入/输出字节、usage和结束事件；远端模型内部首音频时间仍不可见。音频退出后buffer/timer/server sessions为0，Provider socket状态3。实际账单未获取，**actualBillCost=null / billVerified=false**；不由token估算实际扣款或推荐低价模型。

| 对比项 | Phase4.6历史 | Phase4.7本轮 |
|---|---:|---:|
| Flash Provider TTFA | P50 290.53ms，n=10 | 337.51ms，n=1，冒烟 |
| Flash Linux E2E | P50 1725.33ms，n=10 | 1871.76ms，n=1，冒烟 |
| 其他三模型性能 | 有原始矩阵 | NOT TESTED，不重复计为新结果 |
| PCM提示检测/stop P95 | 61.48/0.240ms，n=22 | NOT TESTED；仅新增离线边界/回声局限测试 |
| CoreS3声学指标 | UNVERIFIED | UNVERIFIED |

n=1不能计算有意义P50/P95，也不能证明延迟优化/退化；当前没有新证据显示E2E已低于1秒。真实调用3/3仅为有限冒烟，不扩展成长期可用率或“CoreS3闭环成功”。Phase4.6两次工具失败保留并在phase46-failure-audit.json引用，没有重写历史为全通过。

## 9. 本轮修改文件

| 文件（均在mods/my_companion） | 职责/原因 |
|---|---|
| hardware/diagnostics.js | 逐项只读证据、状态、单调检查时间、队列/轮次/资源和阶段事件；物理八项不误标PASS |
| hardware/device-voice.js（新增） | 受门控的现有Realtime组合/启动/打断/停止、资源释放快照与输入错误接入 |
| hardware/audio-input.js | 初始化/关闭异常清理、固定错误码及格式/成功片数观察 |
| hardware/audio-output.js | write异常释放、成功callback计数与只读状态 |
| ai/realtime-runtime.js | 保留TLS/时间安全门，增加只读状态/错误/显式CA标记 |
| ai/realtime-session.js | 单份有界同轮阶段埋点；不改wire/核心状态设计 |
| mod.js、manifest.json | 注册DeviceVoice及手动入口；默认不启动，退出先释放voice |
| server/server.js | 握手拒绝固定code/status日志，不记录headers |
| simulator/tests/realtime-audio-failure.test.js、realtime-device-voice.test.js（新增） | native边界故障注入、门控/生命周期、三轮流式/输入错误/重复启动/lease清理 |
| simulator/tests/diagnostics.test.js、realtime-adapters.test.js、activity-input.test.js、realtime.test.js | 只读/未知状态/秘密过滤、TLS拒绝、样本局限、同轮时间戳 |
| server/tests/relay.test.js | 错误token401日志与不创建Provider回归 |
| CODEBASE_DOC.md、本报告、CORES3_I2S_ANALYSIS.md、CORES3_CHECKLIST.md、新results | 同步实际证据、限制和到货步骤 |

没有修改host、SDK、ESP-IDF、底层AudioIn/AudioOut C、原package-lock修改、核心Companion、WiFi/HTTP、Provider协议及设备音频格式；没有删除已有测试。模组变更需要新MOD，不能声称对固件零影响，但底层host不改。

## 10. 离线回归与构建

| 命令/检查 | 实际结果 |
|---|---|
| npm test（基线） | 565通过，0失败 |
| npm test（最终） | 582通过：404 unit+121 simulator+57 server，0失败，退出0 |
| npm run realtime:test | 50通过，0失败，退出0 |
| npm run server:test | 57通过，0失败，退出0 |
| npm run simulator | 默认Mock s/q启动/状态/退出正常；不是API易测试 |
| Biome check / npm run lint / npm run format | PASS，原host空constructor提示保留为info |
| git diff --check | PASS；新文件另经Biome及行为测试 |
| 保护哈希 | PASS：984个已有文件，仅14个授权文件改变，无缺失/意外改动；5个SDK/IDF关键文件一致 |
| 密钥扫描 | PASS：Git可见文件及最终xsa不含已配置实际Key/常见凭证匹配；只输出路径/行号 |
| MOD build | BUILD SUCCESS，退出0 |

产物：`/home/yang/code/myapp/xiaozhi/stack-chan/firmware/dist/bin/esp32/debug/my_companion/my_companion.xsa`；**92977B**；SHA256 `7e2dae0039acc68dc1787e2d343c59a01e2ef724358716fe0c6505d40595e536`。编译只验证MOD/导入兼容，不验证native驱动初始化或实际双工。

红→绿日志、初次格式检查错误及最终修正结果均留存；没有删失败测试。输出的3种初始化/入队故障、输入双故障、owner退出lease故障、无效PCM、TLS fail-closed、未知硬件不PASS、诊断无上传/无秘密均有行为回归。原断网/重连旧音频、取消后新轮、多轮、慢消费者/有界队列测试也全部执行。离线本地WS fixture只算软件验证，不能计入真实API或硬件结果。

## 11. 真机到货执行步骤与仍存阻塞

完整逐项编号、操作/预期/实际/日志/通过标准/设备要求见[CORES3_CHECKLIST.md](CORES3_CHECKLIST.md)。所有实体实际结果当前NOT_TESTED；A基础连接、B单向音频、C双工、D真实对话、E恢复分别有检查项。

第一条命令（只扫描，不刷host）：

```bash
cd /home/yang/code/myapp/xiaozhi/stack-chan/firmware
source /home/yang/.local/share/xs-dev-export.sh
npm run scan
```

确认兼容host已安装后，才用现有`npm run mod -- mods/my_companion/manifest.json`写MOD。手动打开只读诊断，先取得AP/时间/证书/凭证证据。单向检查也需要真正独占资源，当前没有默认可直接执行的安全harness；B/C阻塞不应跳到D。不能执行host deploy/debug去偷偷改变底层，也不能将三个readiness布尔值设true代替测量。

必须先解决/证明：

1. I2S1共享时钟、slot/codec和初始化顺序兼容；否则在当前约束内继续停在adapter。若需底层最小修改，另行明确方案和用户决策。
2. 认证时间来源及CA验证；SNTP同步不是认证时间证明，不绕过TIME_UNVERIFIED。
3. Host全局音频所有权；MOD业务lease不能覆盖TTS/radio/native Speaker。
4. 设备凭证安全provisioning回调和自有WSS服务配置；不把API易Key交给CoreS3。
5. native内部失败/无首片/释放、真实回声与UI负载、长期heap/丢片，以及外部声学首声/停止测量。

## 12. 物理能力逐项状态

| 能力 | 状态 | 原因 |
|---|---|---|
| CoreS3麦克风 | UNVERIFIED | 无实体PCM采集/声学输入证据 |
| CoreS3扬声器 | UNVERIFIED | 无实体输出/失真/停止证据 |
| I2S全双工 | UNVERIFIED | 源码存在共享时钟/配置风险，尚未现场测量 |
| 真实Wi-Fi | UNVERIFIED | Linux联网不证明CoreS3 AP连接 |
| TLS/CA | UNVERIFIED | Linux WSS成功不证明设备证书握手 |
| 设备可信时间 | UNVERIFIED | 没有认证时间证明，门控保留 |
| 真实声学首音频延迟 | UNVERIFIED | 没有实体与外部测量 |
| 真实声学停止延迟 | UNVERIFIED | stop调用时刻不是实际静音 |

本轮可交付的是更可诊断、失败可清理、受安全门控的设备适配准备及Linux有限真实冒烟。**没有实体设备，就没有真实CoreS3音频闭环验收结果。**

官方依据：[ESP-IDF ESP32-S3 I2S](https://docs.espressif.com/projects/esp-idf/en/release-v6.0/esp32s3/api-reference/peripherals/i2s.html)；本机源码位置/差异详见I2S分析，当前安装源码优先于其他芯片/在线版本描述。
