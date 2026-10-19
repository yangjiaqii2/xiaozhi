# Phase4.8 验收报告：设备安全接入、时间与双工预适配

日期：2026-10-19（Asia/Shanghai）。原始证据目录：[phase48-20261018T191233Z](results/phase48-20261018T191233Z/real-summary.json)，目录名为UTC开始时间。**没有CoreS3实体；本报告不表示真机实时语音已经运行。**

## 1. 实际交付及边界

本轮增量完成DeviceIdentity、TrustedTime、DeviceBootstrap、无音频WSS配置通道、严格Server凭证生命周期、只读安全诊断和静态预检。原Companion/HTTP/WiFi/Provider核心/音频16k-24k协议保持，不改host/SDK/ESP-IDF/native C，不改变默认模型、VAD或音频分片。两个安全门TIME_UNVERIFIED与AUDIO_DUPLEX_UNVERIFIED继续生效。

**尚未具备开箱即用的完整设备安全绑定和双工**：受控实体provisioner、设备可靠nonce源、加密持久化、认证时间验证器、host全局音频lease及共享I2S实测/必要适配仍有缺口。没有把纯JS接口/注入替身称为这些能力已经实现。

## 2. 工作区与基线

Git根为stack-chan，命令在firmware。开始已有根package.json/package-lock.json修改，整个mods/my_companion未跟踪；没有reset/checkout/丢弃/提交。开始记录1063个已有host/MOD/package文件SHA256，另记录5个SDK/IDF关键文件。原始git状态、基线和结束对比独立保存，Phase4～4.7原始数据未覆盖。

本轮重跑基线npm test：582通过（404 unit+121 simulator+57 server），0失败。结束核对：16个已有文件为授权修改，无文件丢失；host、原package及lock、5个SDK/IDF文件保持一致。详见hash-check.json。

## 3. DeviceIdentity/凭证安全

- 设备必须显式confirmed进行本地provision，字段白名单deviceId/token/notBefore/expiresAt，不接受上游Key、persona/user权限下发。私有token仅RAM，JSON/诊断不包含；过期/尚未生效拒绝，鉴权拒绝后必须重新provision；轮换立即停旧Voice/取消Bootstrap；退出释放引用/监听器。JS不可变字符串不能保证密码学擦除。
- configureDevice是mod导出的受控本地适配接口，不是一个已存在配对UI/串口协议。默认不调用、不自动注册、没有网络注册端点，也不把凭证写manifest/config/Git。当前还不能声称设备到货即可安全永久存储凭证。
- SDK Preference的ESP32实现是nvs_open/nvs_set，已确认持久能力，**未确认本目标NVS/flash加密与密钥保护配置**，因此没有用它保存新设备Token。encryptedPersistence=UNVERIFIED。
- Server新credentials记录接受tokenHash或由安全环境传入token后hash，支持notBefore/expiresAt、最多4个。strict requireNonce=true要求有限期credentials，拒绝无期限旧tokens/tokenHashes；旧格式仅兼容旧联调。建议新生产设备使用严格格式，设备不是仅凭deviceId认证。
- Server对升级前鉴权、session.start.deviceId再次绑定；personaId/userId/voice/instructions来自Server权威记录，设备hint不改变权限。无音频配置响应只返回DeviceConfig白名单，不下发厂商Key。
- AIServer.updateDevices原子替换：配置非法不覆盖旧记录；撤销后新连接拒绝且现有Session关闭，到期会话有有界计时器主动释放；移除设备清理限流记录。没有远程未授权轮换端点。
- strict连接要求X-Device-Nonce及X-Device-Issued-At：±30秒窗口、单设备128个nonce上限、约60秒保留，满时拒绝不淘汰有效nonce；同进程轮换保留去重缓存。Node使用crypto.randomBytes，设备必须由本地adapter提供nonce源；没有把SDK旧rng默认c_rand初始化说成安全CSPRNG，缺少来源返回NONCE_UNAVAILABLE。

**防重放限制**：此机制抵御本进程/时间窗口内同一握手重放，不保护已泄露Token被持有人重写nonce；缓存不跨Server重启。需要更高保证时另行实现持久去重/单次票据或设备公钥绑定。HTTP读取接口继续Bearer+有效期，不消耗WS nonce；没有实现任意HTTP写操作的防重放。TLS校验仍必要。

验证：无凭证/错误/未来/到期/ID不符、旧凭证轮换撤销、活动会话到期、重复连接原回归、nonce重复/时间窗/上限、严格配置与真本地socket配置探测均有行为测试；拒绝/配置探测不创建Provider。红绿原日志保留，测试失败未删除。

## 4. 时间与TLS

已从本机源码确认Time.ticks/delta/set、SNTP.time/error/close和host NetworkService时间处理。新增time-runtime只在显式Bootstrap、WiFi connected后启动SNTP；有10秒默认超时、错误/STOP/晚回调隔离、单请求复用，关闭时区分SDK自身已关闭。

TrustedTime分别记录readable、synchronized、trusted：普通SNTP只设置系统时间，**永远不自动认证其来源**，成功仍TIME_UNVERIFIED。acceptEvidence需本地安装验证器核对签名/来源/新鲜性，不接受远端trusted:true；证据有效期最多1小时，并以本地单调时钟及wall clock漂移检查失效。生产入口未安装认证验证器，没有凭空将日期阈值或SNTP同步当可信。

WSS继续要求wss、时间门、verify=true、主机名与TLS1.2下限，可传CA，不关闭验证、不降级WS。实际SDK ssl_cert.js核对SAN、签名链与有效期；io onError只提供合并TLS_OR_WEBSOCKET_ERROR，本轮未伪造“确定为过期CA”的细分。原HTTP HTTPS_UNAVAILABLE保持，配置探测改走独立已验证策略WSS adapter，不使用明文生产替代。新RAM凭证没有灌入旧明文HTTP配置；旧HTTP模板仍为空，若后续修复安全HTTPS再接入同一身份来源。

### 时间缺口与最小改造提案（未执行）

1. 当前host/modules/connectivity/network-service.ts只执行未认证SNTP，日期过阈值还会跳过，未暴露可验证新鲜性/认证来源。**只导出synced布尔值不能解决可信时间。**
2. MOD-only候选是受控物理初始化通道或签名时间服务：本地安装只读信任根与验证器，设备新nonce绑定、签名时间/有效期、抗回放和超时验证后才Time.set。SDK有签名/TLS相关模块，但当前并未完成该端到端验证器/安全provisioner，不能声称现成接口已经可信。
3. 若由host统一提供，最小范围在NetworkService及其公开connectivity接口增加认证时间服务和可读证据/失效状态，默认仍不可信；签名信任根/nonce与持久安全策略须单独评审。MOD time-runtime只读该证明，不改系统TLS校验。具体新增接口目前是提案，不作为可调用API。
4. NVS/flash加密、硬件随机、设备身份永久绑定均需实际板配置/烧录与保护策略。当前无证据认为必须改ESP-IDF；也不能承诺只改MOD便能满足生产可信引导。先保留TIME_UNVERIFIED。

离线测试覆盖同步成功但不trusted、离线不发请求、同步超时/停止/迟到包、验证器证据有效/失效、伪造布尔值拒绝、TLS拒绝及手动恢复。它们不是CoreS3 SNTP/TLS实测。

## 5. I2S全双工预适配结论

详见[CORES3_I2S_ANALYSIS.md](CORES3_I2S_ANALYSIS.md)新增Phase4.8提案。

| 已从当前源码确认 | 当前结论 |
|---|---|
| RX io/audioin I2S1，BCK34/LR33/DIN14/MCLK0，16k，PHILIPS双槽→JS mono | 设备采集与codec锁定未实测 |
| TX pins/audioout I2S1，BCK34/LR33/DOUT13，24k，mono LEFT/MSB | 与RX有rate/slot/bit_shift/完整GPIO配置差异 |
| 两方向各自MASTER分配，本机IDF6.0.2匹配完整归一化配置 | 当前配置不满足自动pair分支；不能仅改采样率数字 |
| S3硬件支持同port独立simplex，但板上BCK/LR共享 | 不等于当前共享脚可安全使用不同外部帧时钟 |
| RX ring/DMA与TX descriptor/任务分离；native handles无JS共享接口 | 不能从JS证明并行资源/无饿死；不伪造DMA API |
| Microphone.start未暴露sampleRate，RuntimeAudio未公开全局排他lease | MOD lifecycle控制不能替代native owner与全局音频所有权 |

若现场确实不兼容，最小提案是板型限定共享native owner一次申请TX/RX，统一经codec确认的clk/slot/gpio、明确lease与失败释放；可选统一24k硬件，再由AudioRuntime抗混叠降到16k输入。**尚未实施/验证**，需另行授权host/板级native接口；优先隔离新板级owner，不直接改SDK/IDF。详细具体文件、官方示例影响、回滚及两种初始化顺序/波形验收列于I2S文档。没有证明一定要改底层，也没有证明可仅靠MOD实现。

Server GPT 16k→24k仍仅在Provider Adapter，Qwen不转；没有新增重采样/重复转换，没有改设备对外16k输入/24k输出。候选24k→16k抗混叠滤波、ESP32 CPU/延迟/音质未测；不能拿现有上采样器假装降采样已完成。

## 6. 初始化流程与真机入口

设备启动仍先创建原Companion/基础表情/WiFi，不自动启动音频。手动Drawer **Setup CHECK: network time + WSS config (no audio)** 才执行网络→时间→凭证→安全WSS→配置；单阶段有有界超时和PASS/FAIL，重复start共用任务/结果，缓存再次使用前重新校验时间/凭证有效性。STOP、换凭证、断网、退出取消/关闭通道/SNTP/计时器/监听器，晚任务不恢复旧连接。

配置探测新增device.config.get/device.config，在session.start前一次请求，由Server鉴权身份返回白名单DeviceConfig；probe不创建API易Provider、不采集上传PCM。成功仅configurationReady=true，仍返回AUDIO_DUPLEX_UNVERIFIED，不自动启动Voice；Server feature=true也不能绕过。当前默认因缺认证时间/凭证而安全拒绝，基础表情不被影响。

只读Drawer **Companion: diagnostics (read only)**新增security白名单段，保留每项证据/时间/原因/下一步与物理八项UNVERIFIED。不打印Token/原始错误/完整音频。

Linux静态预检（不是设备远程诊断）：

```bash
node --import ./mods/my_companion/simulator/register.js mods/my_companion/simulator/device-preflight.js
# 需先加载既有SDK环境；只显式调用已有USB扫描，不刷写、不录音
node --import ./mods/my_companion/simulator/register.js mods/my_companion/simulator/device-preflight.js --scan
```

默认只输出静态报告；--require-hardware因无实体证据退出2；拒绝未知参数。完整六阶段/每项前置和失败停止条件见[CORES3_CHECKLIST.md](CORES3_CHECKLIST.md)。单向音频也需要安全受控harness/独占证明，当前没有可假装已可用的按钮。

设备到货第一条项目命令：

```bash
cd ~/code/myapp/xiaozhi/stack-chan/firmware
source ~/.local/share/xs-dev-export.sh
npm run scan
```

本轮实际扫描exit0但No available devices found，硬件验收未通过。确认兼容host后才使用原npm run mod命令，不自动deploy/debug刷host。

## 7. 有限Linux真实API易验证

APIYI_API_KEY: CONFIGURED，仅使用既有Server运行时加载器，不输出值。只选qwen3.5-omni-flash-realtime/Omni，无Mock fallback、Provider maxRetries=0。本轮不跑四模型性能矩阵、不改变默认参数。

| 调用 | 实际证据 | 工具结果 | usage/阶段 |
|---|---|---|---|
| 文本1 | 真实WSS/API易/模型 | PASS | TTFT546.16ms，总921.12ms；in21/out2/total23 |
| 文本2 | 同Session上下文 | PASS | TTFT517.39ms，总716.33ms；in46/out4/total50 |
| 音频首次 | 真实strict nonce+expiry设备鉴权→Server→API易→逐片播放 | 工具FAIL；底层stream_completed已返回 | Provider TTFA317.62ms；usage in485/out102/total587，audio in14/out77 |
| 音频第二工具尝试 | 零Server事件，未计真实API请求 | FAIL | 原始细分异常未保存；同固定输出路径离线复现EEXIST，记录保留 |
| 音频复验 | 改用已有assertStreamCompleted及唯一输出路径；真实strict链路 | PASS | Provider TTFA324.97ms；usage in485/out146/total631，audio in14/out115；消费441600B/460片 |

统计口径：**真实已完成响应4轮（2文本+2音频）；工具调用5次，3PASS/2FAIL，不能写全通过。**首次音频脚本错误地寻找response_done日志名，而项目完成事件是stream_completed，导致完整流被误报STREAM_INCOMPLETE；原文件未覆盖，复验是另一次真实请求。第二工具尝试没有Server事件，不计Provider调用；其原具体异常未保存，不事后伪造成确定上游错误。已有WavAudioOutput使用wx保护原文件，同路径EEXIST离线复现属于本地工具证据。没有通过删除失败样本计算“100%真实验收成功率”。

两次实际音频均Server峰值54720B/57帧、终态队列0，首次/复验暂态压力8/13次，stalledCount均0；分别完整发出295680B/441600B。没有OUTPUT_BACKPRESSURE/永久消费停滞；暂态pause仍正常保留，不误作错误。API音频样本为既有合成中文WAV，不是真人Mic输入。复验设备指标timeToFirstAudio=574.21ms使用旧Session最后提交音频（含测试静音尾）到收片口径，**不是用户说完到声学播放的E2E TTFA**；本轮该声学指标null，不拿此数字宣布低于1秒。

未重测自动打断延迟、四模型排名/重连耗时；对应NOT_TESTED，原离线回归照常执行。实际账单未获取，actualBillCost=null；usage字段直接保留返回值，不估算扣款。原始real-audio.json/second/third、real-text.log、real-summary及失败本地复现均保存。

## 8. 本轮新增与修改文件

| 文件（均在mods/my_companion） | 新增/修改 | 职责 |
|---|---|---|
| app/device-identity.js | 新增 | RAM私有凭证、显式provision、到期/拒绝/轮换/释放 |
| app/trusted-time.js | 新增 | 可读/同步/可信分层，限时/取消、认证证据边界 |
| app/device-bootstrap.js | 新增 | 初始化阶段、单任务/缓存有效性、异常清理；不启动音频 |
| hardware/time-runtime.js | 新增 | 真实SDK SNTP/Time/Timer适配 |
| ai/device-channel.js | 新增 | 无音频安全配置探测、requestId与关闭隔离 |
| hardware/diagnostics.js | 修改 | 安全状态白名单，物理项目保留UNVERIFIED |
| ai/realtime-runtime.js | 修改 | 支持严格设备nonce/issued-at headers；TLS策略保留 |
| ai/realtime-session.js | 修改 | 仅新增expired/nonce unavailable两个fatal错误，避免无意义重连 |
| mod.js/config.js/manifest.json | 修改 | 显式本地配对适配边界、CHECK/STOP、生命周期与模块注册 |
| server/auth.js | 修改 | 有期限hash凭证、轮换及有界连接去重 |
| server/server.js | 修改 | 严格接入、主动到期/撤销活动连接、限流清理 |
| server/device-session.js | 修改 | 已鉴权Provider前DeviceConfig白名单请求 |
| server/node-runtime.js | 修改 | Node真实随机连接nonce |
| simulator/device-preflight.js | 新增 | 无音频静态预检及显式scan |
| simulator/tests/realtime-device-security.test.js | 新增 | 凭证/时间/Bootstrap、取消/缓存/过期与fatal行为 |
| simulator/tests/realtime-device-channel.test.js | 新增 | 配置关联、非法消息、TLS错误及关闭 |
| simulator/tests/device-preflight.test.js | 新增 | 静态非硬件、拒绝录音参数、秘密不输出 |
| simulator/tests/diagnostics.test.js | 修改 | security段白名单/无副作用/未验证不能PASS |
| server/tests/device-security.test.js | 新增 | expiry/rotation/replay/活动连接/Provider前配置真实本地socket |
| CODEBASE_DOC/REALTIME_PROTOCOL/APIYI_REALTIME/CORES3_CHECKLIST/CORES3_I2S_ANALYSIS/本报告与新results | 新增/修改 | 同步真实边界、完整步骤、原始证据 |

新增模块仅通过生产manifest引用纯JS/已确认SDK模块；模拟器/Server/Node测试未混入ESP32生产路径。无新增npm依赖/script，无package/lock改动。

## 9. 回归与构建

| 检查 | 本轮实际结果 |
|---|---|
| 基线npm test | 582通过，0失败 |
| 最终npm test | **618通过：404 unit+149 simulator+65 server，0失败/取消/跳过，exit0** |
| npm run realtime:test | **75通过，0失败，exit0**（是上述子集，不能再累加总数） |
| npm run server:test | **65通过，0失败，exit0** |
| Biome check / npm run lint / npm run format | exit0；原host info不改 |
| git diff --check | exit0 |
| npm run scan | exit0，无设备；硬件结果NOT TESTED |
| npm run simulator | 默认Mock s/q启动/状态/退出exit0，不是API易或硬件验证 |
| MOD build | **BUILD SUCCESS，exit0** |

产物：[my_companion.xsa](../../../dist/bin/esp32/debug/my_companion/my_companion.xsa)，**111954B**；SHA256 `03cc155f9f161efb8b137a686684377d59946448bb21a89c885849730d892e56`。旧92977B为历史，本轮增加18977B（归档大小，不等于运行heap）。MOD编译不证明native初始化、证书握手或声音。基线/红绿/中间回归和全部失败日志保留；初次测试导入helper路径错误另保留，纠正后再做真正行为红绿。

保护文件核对与密钥扫描结果见hash-check.json/key-scan.json。初始原package/lock修改未覆盖，旧Phase结果未改。扫描Git可见1449个文件及最终xsa：实际已配置Key/常见凭证模式零命中，archiveHit=false，PASS；仅报告路径/行号，不输出内容。扫描不宣称覆盖内存转储或所有形态秘密。独立只读审查未发现Critical/Important问题，定向测试33/33通过；该数量是子集，不额外累加总数。

## 10. 尚未解决与下一阶段

| 能力 | 状态 |
|---|---|
| CoreS3 Microphone | UNVERIFIED |
| CoreS3 Speaker | UNVERIFIED |
| CoreS3 I2S Full Duplex | UNVERIFIED |
| CoreS3 Wi-Fi | UNVERIFIED |
| CoreS3 TLS/CA | UNVERIFIED |
| CoreS3 Trusted Time | UNVERIFIED |
| CoreS3 Acoustic TTFA | UNVERIFIED |
| CoreS3 Acoustic Interruption | UNVERIFIED |

1. **真正启用语音还缺什么？** 受控实体配对/nonce与持久化方案、认证时间证据、真实CA/域名/设备鉴权、音频全局独占和共享I2S方案/验证，以及实体Mic/Speaker/回声与声学验收。不能仅改enabled/readiness为true。
2. **已有完整代码、只待实体边界验证的部分？** 状态/Persona/表情动作、WiFi/HTTP、Realtime流协议/队列/取消/隔离/有限重连、音频输入输出适配、WSS策略、RAM身份/Bootstrap状态机/只读诊断与Server strict鉴权已有代码及软件测试；认证时间验证器、持久安全配对、共享native owner不在此列。
3. **哪些一定要改host/native？** 当前没有真机证据可断言必须改底层。若现有时钟/槽位不兼容，JS缺少共享channel配置/handle及全局lease接口，不能声称MOD足够；按I2S提案评审最小板型owner/host入口，另行授权，不要求盲改SDK或IDF。时间若由host集中负责，则须新增认证来源与公开证据，不能把现SNTP状态改名为trusted。
4. **第一条命令？** 在firmware加载原SDK环境后`npm run scan`；当前没有设备无需刷写。
5. **下一阶段可否真机联调？** 可从设备识别、只读诊断和基础连接开始，逐阶段解决门槛；**不能直接跳到完整实时双工对话验收**。详见六阶段清单及失败停止条件。
