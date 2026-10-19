# CoreS3 I2S源码分析（Phase4.7）

日期：2026-10-18。仅源码与离线分析，无实体设备。设备协议仍输入16k/mono/S16LE、输出24k/mono/S16LE。`AUDIO_DUPLEX_UNVERIFIED`不能解除。

## 实际调用与配置

| 层 | RX | TX |
|---|---|---|
| MOD | hardware/audio-input.js复用robot.audio.microphone.onReadable；有界立即读取 | hardware/audio-output.js，pins/audioout，每次一片SharedArrayBuffer+Callback |
| host | host/modules/audio/microphone.ts；new AudioIn({channels:1,onReadable}) | host/platforms/core_s3_audioout.js转发pins/audioout-original，并设置amp.sampleRate |
| 实际SDK | modules/io/audioin/esp32/audioin.c（不是旧pins/audioin） | modules/pins/i2s/audioout.c |
| 板级定义 | host/platforms/m5stackchan_cores3/manifest.json | SDK build/devices/esp32/targets/m5stack_cores3/manifest.json |
| I2S/引脚 | I2S1，BCK34/LR33/MCK0，DIN14 | I2S1，BCK34/LR33，DOUT13，native配置MCLK unused |
| 格式 | native双槽16bit，PHILIPS/bit shift；SDK交付JS mono | MSB/bit_shift=false，mono LEFT，16bit |
| 采样率 | 16000Hz | 24000Hz |
| 分配 | i2s_new_channel(...,NULL,&rx)，MASTER | i2s_new_channel(...,&tx,NULL)，MASTER |
| DMA/缓冲 | IDF默认6 descriptor ×240 frame；SDK 16384B ring，MAX_INPUT_BLOCK2048，pendingCallback合并通知 | 2 descriptor，frame数由sizeof(native mixer buffer)/bytesPerFrame确定；独立native任务 |

上述是预期构建配置，不证明已安装实体host采用同样二进制。核心证据SHA256见本轮sdk-protected-hashes.json。

## 能否同时工作

1. ESP32-S3控制器本身有独立RX/TX，在**独立GPIO**条件下可不同步工作；不是“同一个I2S编号就一定不支持并行”。
2. **当前板的BCK/LR实际共享。** 两个MASTER分别以16k/24k请求驱动同一WS，不能假装它们是互不影响的时钟。ES7210 ADC/扬声器codec实际锁定状态、采样是否变速、实际声音均UNVERIFIED。
3. 本机 `tools/cmake/version.cmake` 显示ESP-IDF **6.0.2**。实际 `components/esp_driver_i2s/i2s_std.c:s_i2s_channel_try_to_constitude_std_duplex`（约255行）归一化slot后对完整i2s_std_config_t做memcmp；完全匹配才设置full_duplex，后初始化的MASTER才切换SLAVE。
4. 当前RX/TX采样率、slot、bit_shift、GPIO方向字段不同，不满足这条自动配对分支。S3（HW_VERSION_2）不同配置可保留simplex，而不是立即报错，所以“初始化没有抛异常”也不是双工证据。官方在线6.0文档的兼容匹配描述比本机源码更宽，**以当前安装源码为准**。
5. `i2s_std.c:i2s_std_set_gpio`约248行分别路由WS/BCK；`i2s_common.c:i2s_output_gpio_reserve`约885行对非配对重复输出GPIO报警，后续仍调用esp_rom_gpio_connect_out_signal。故初始化顺序存在影响引脚路由的源码风险。必须分别测试RX→TX、TX→RX；不能凭源码预测设备一定出现哪种失真。
6. RX/TX分别有DMA/任务，不说明DMA必冲突，也不说明没有资源竞争。SDK RX合并JS回调，read超时50ms；真实到达节奏不能当20ms。native TX使用portMAX_DELAY写I2S，MOD无法从JS直接取得该等待时长。RX/TX native错误有只记录日志、未全部转换成JS异常的路径；仅JS constructor返回不能标硬件PASS。

## 重采样边界

现有Server `server/audio.js:PCMResampler`只处理16k→16k或16k→24k；Qwen保持16k输入，GPT GA在Provider Adapter转换到24k。设备输出始终24k，没有二次设备重采样。本轮不新增转换。

Server重采样**不能修复板上RX/TX时钟**。如未来选择统一24k原生时钟，需先证明native槽位/格式与codec兼容，再将24k采集有低通抗混叠地降到设备协议16k；不是简单丢1/3采样。现有host Microphone.start没有暴露sampleRate选项，现有Server转换器也不支持该降采样。即便绕开facade直接创建SDK AudioIn，也不能解决当前完整配置配对、codec和所有权证明；本阶段没有这样修改。

另一方案是统一16k硬件输出并把协议24k输出在MOD降采样；同样需要抗混叠、amp/slot兼容、初始化顺序及音质证明。改用32/48k统一时钟、另一I2S控制器/独立GPIO或专用共享native驱动更涉及当前约束之外的配置/板线或host/native工作，本轮不执行。

20ms协议PCM为输入640B/输出960B；固定转换应保持分片/O(1)状态并避免重复重采样。转换CPU、群时延、音质及回声抑制成本目前NOT TESTED，不用Linux CPU推算ESP32结果。

## 尚需决策与证据

- 先到货测量现状，不改host/SDK/native强行凑双工。
- 如真实共享时钟/格式不兼容，在当前MOD约束内暂不开放双工。需另行决定是否允许最小host/native配置改动、板级支持方案，或接受明确半双工产品行为；半双工不能冒充本阶段自动打断双工验收。
- host RuntimeAudio没有公开可证明覆盖TTS/webRadio/Speaker的全局排他lease；Companion.runTask只是本MOD业务门，不是I2S独占证据。DeviceVoice另保留AUDIO_OWNERSHIP_UNVERIFIED。
- NetworkService使用SNTP/日期阈值，没有可读取的认证时间证明；不能由“已联网/日期像当前时间”解除TIME_UNVERIFIED。
- 当前mod入口没有注入上述证明，也没有设备凭证provisioning回调；START默认REALTIME_DISABLED。即使仅配置enabled，也不能绕过readiness及WSS验证。

官方参考：[ESP-IDF6.0 ESP32-S3 I2S](https://docs.espressif.com/projects/esp-idf/en/release-v6.0/esp32s3/api-reference/peripherals/i2s.html)。Context7已查询，发现结果默认落到C6后另核对S3页面；不把其他芯片文档当S3板级证明。


## Phase4.8：最小可执行预适配提案（未实施底层改动）

2026-10-19再次核对安装源码：RX `modules/io/audioin/esp32/audioin.c:493/522`、TX `modules/pins/i2s/audioout.c:1507/1525/1559`仍各自申请MASTER、rate与bit_shift不一致；`i2s_std.c:257`归一化slot后比较完整配置；`i2s_common.c:i2s_output_gpio_reserve`仍有重复路由风险。板级setup-target.js创建ES7210 ADC和AW88298 amp，amp默认24k；ADC寄存器/槽位/共享MCLK的实际锁定需实测。没有新证据解除AUDIO_DUPLEX_UNVERIFIED。

官方[S3 I2S 6.0文档](https://docs.espressif.com/projects/esp-idf/en/release-v6.0/esp32s3/api-reference/peripherals/i2s.html)允许同port的独立simplex使用不同内部时钟；共享BCLK/WS的full-duplex则要求帧时序匹配。在线文档已改为较宽兼容匹配，而本机6.0.2文件仍是memcmp；不能用在线新实现覆盖本机证据。Context7命中C6示例后另核对S3页面。

### 缺失能力与方案顺序

1. **先测现状**：只读诊断→全局音频独占→单向ADC/输出→RX→TX与TX→RX的WS/BCK/MCLK测量。若两方向格式/速率持续正确，才可提交实机证据讨论门控；不能先强开Voice以“测试”。
2. **仅MOD协调的边界**：当前robot.audio.microphone.start()只把channels/onReadable传给native；TX仅通过已有pins接口。JS拿不到两方向I2S channel handles、共用配置或DMA所有权。AudioRuntime能控制生命周期，却不能凭空合并native channel。因此本轮没有伪造duplex factory或重采样“修复”。
3. **若现状不兼容，优先评审一个板型限定的共享native owner**：一次i2s_new_channel申请TX/RX，把同一份经codec确认的clk/slot/gpio配置用于两方向；统一硬件rate候选24k，仍需验证ES7210/AW88298支持该槽位/采样组合。RX统一硬件rate后仅在AudioRuntime降采样24k→16k，外部16k输入/24k输出不变。不能只加sampleRate参数就宣称完成pairing。
4. **重采样未实现**：现有server/audio.js只支持16k→16k或24k，GPT转换继续仅在Server。候选24k→16k需有抗混叠FIR、跨片相位/有限history、饱和运算及脉冲/带外衰减测试，不能简单删采样；额外CPU/heap/群延迟/音质NOT_TESTED。不重复Server GPT上采样，也不把设备输出改成别的wire rate。
5. **所有权**：host/app/runtime-audio.ts的activeOperations为内部管理，未暴露覆盖TTS/radio/直接Speaker的排他lease。最小host层方案须先提供带release/finally/失败回收的排他接口，再接共享owner；当前Companion.runTask不替代它。

### 需另行授权的具体文件与影响

| 范围 | 最小候选改造 | 官方影响与回滚 |
|---|---|---|
| host/app/runtime-audio.ts | 暴露真正覆盖TTS/WebRadio/Speaker的可释放排他所有权 | 默认路径不变，仅显式Realtime lease；撤销新接口及MOD调用即可回滚 |
| host/modules/audio/microphone.ts | 可选受控native输入/统一rate入口，默认16k行为保持 | 旧MOD/record/start签名与默认不变；回滚可选入口 |
| host/platforms/m5stackchan_cores3/manifest.json + 新板型专用native模块（提案，当前不存在） | 导出共享I2S owner并采用已证实的codec配置 | 只CoreS3显式启用；其他板型/示例不改。撤销include和owner即可回到基线 |
| SDK modules/io/audioin/esp32/audioin.c、modules/pins/i2s/audioout.c | 现有分离分配的源码证据；优先不直接改SDK，以板型owner隔离 | 若无法隔离才另行评审最小补丁与全部官方音频示例；本轮没有修改 |
| MOD hardware/audio-runtime.js及有限重采样模块 | 对接共享owner，协议两端保持16/24 | 仅在owner/实机证据已齐全后切换；保持旧安全门可立即回滚 |

以上是工程提案，不是已存在API；是否必须动native仍以实机失败/波形为依据。当前约束下无法证明可仅用MOD解决，不宣称必然要改ESP-IDF。不可在源码外部盲改SDK头文件或全局rate宏。

### 提案验收与停止条件

先保存现状二进制/SHA和host源码；旧官方look_around、原TTS/record/WebRadio须回归。每次只启用一种owner，错误时先stop双向/销毁handles，不能留下native任务。分别测试两种初始化顺序、30秒双向流、10次start/stop、断线取消、长期heap和错误注入；逻辑分析仪证明WS稳定、ADC实际速率与输出频率正确；记录DMA错误、JS回调周期、队列峰值与延迟。任何GPIO/codec/首PCM/独占证明失败停止双工，不改为无界缓冲或半双工冒充通过。
