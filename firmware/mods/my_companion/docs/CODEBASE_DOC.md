# AI Companion MOD：Phase 1–4.8

适用当前源码：Stack-chan 1.1.0、Moddable SDK 9.0.0、ESP-IDF 6.0、
`esp32:./host/platforms/m5stackchan_cores3`。架构是硬件身体加自有服务器大脑。
Phase 2.5 新增 Linux 模拟器；Phase 3 新增Realtime核心；Phase 4新增自有Server/API易 adapter，默认仍Mock，真实Key缺失时明确跳过。
真实 ESP32 入口仍保持 Phase 2 的 Wi-Fi 管理、HTTP JSON 通信和测试入口。
MOD不运行LLM/STT/TTS模型；Phase 4由服务端适配云端Realtime。未实现真实录音、摄像头、Vision、长期记忆或情绪模型。
未修改 host、平台、SDK、ESP-IDF；Phase 4只有独立Server包新增ws依赖与自己的lock。当前工作区的固件根 package-lock 另有平台可选包元数据变动，随源码提交。

## 公开仓库与本地记录

项目仓库为 `https://github.com/yangjiaqii2/xiaozhi`，基于 Stack-chan v1.1.0，保留上游提交历史和原许可证。
公开内容包括 Companion 源码、测试、模拟器、Server、配置模板和阶段验收说明。
`server/local-config.js`、依赖、构建产物和 `docs/results/` 中的原始验收输出保留在本地，不随公开仓库发布。
阶段说明中指向原始结果的历史链接仅在保留记录的开发机上可用，详见 [本地记录说明](results/README.md)。

### 2026-10-19 - 首次公开上传准备

- 变更摘要：补充 Xiaozhi 入口说明，排除本地原始验收结果并整理现有开发内容用于首次提交。
- 影响文件：根 `README.md`、`mods/my_companion/.gitignore`、`mods/my_companion/docs/results/README.md` 和本文档。
- 影响范围：仓库说明和文件发布范围；本地原始记录保留，运行逻辑未改动。
- 验证：本地 Key 和原始结果已被 Git 忽略，候选文件中未发现该 Key 的副本；`APIYI_API_KEY='' npm test` 退出 0，基础测试 404、模拟器测试 149、Server 测试 65，共 618 项通过。`git diff --check` 通过；本次未运行真实 API 或硬件验收。

## Phase 2.5：Linux 无真机开发

### 启动与命令

在 `firmware/` 下执行，使用现有 Node 22.23.1；不需要实体机器、SDK 环境变量、Xvfb、摄像头、麦克风或扬声器：

```bash
npm run simulator
```

入口会自动启动 `127.0.0.1:8787` 的 Mock Server 和终端机器人，不需要第二个终端。
输入命令后按 Enter；选择 c 后显示 You，再输入文本并回车。q 或 Ctrl+C 关闭输入、任务、定时器与本地服务器。

| 命令 | 行为 |
| --- | --- |
| t | 触发现有 Mock 电源键 → Companion.testServer → GET 配置 |
| c | 输入文本 → Conversation → POST 聊天 → 表情/动作/SPEAKING → IDLE |
| w | 显式断开；再次输入后 CONNECTING → CONNECTED |
| s | 输出 deviceId、系统 Wi-Fi、业务状态、表情和本地 Persona |
| q | 取消在途任务并退出，不依赖 process.exit 强制结束 |

```bash
MOCK_LATENCY_MS=0 npm run simulator
MOCK_SCENARIO=timeout npm run simulator
MOCK_SCENARIO=500 npm run simulator
MOCK_SCENARIO=invalid-json npm run simulator
MOCK_PORT=8788 MOCK_LATENCY_MS=500 npm run simulator
npm run simulator:test
```

端口 0 表示操作系统选择空闲端口，自动测试使用此设置避免冲突。默认延迟 500 ms，支持 0。
支持场景：200、400、401、404、429、500、503、timeout、invalid-json、large-response，
以及 invalid-protocol、wrong-request-id、unknown-emotion、unknown-action。
`npm run simulator:server` 可单独启动 Mock Server；它是替代用法，不要与完整模拟器同时占用默认端口。

### 复用与隔离

```text
KeyboardInput → MockRobot input → Companion / Conversation
                                  │
                      State / Persona / Protocol / Logger
                                  │
                              ApiClient
                                  │
                     MockHTTP (SDK Request 形状适配)
                                  │
                     本机 TCP → Mock HTTP Server
```

- `hardware/wifi.js`、`hardware/face.js`、`hardware/motion.js`、真实 network-runtime/http-runtime、ApiClient、config、mod 和生产 manifest 保持不变。
- 共享 Companion 只将现有测试任务锁抽取为通用 runTask；testServer 仍使用原路径，没有模拟器条件分支。
- 新增 `app/conversation.js` 是无硬件依赖的聊天编排，按 port 注入 API、状态、展示、时钟和 Logger；当前仅由模拟器装配，未加入 ESP32 生产 manifest。
- `ai/protocol.js` 增加严格聊天协议导出；已有设备配置与健康校验保留。
- Node 的模块 loader 按生产 manifest 解析已有模块，并将 timer/time 映射到桌面调度。
  Face/网络枚举直接加载当前 host TypeScript 源码并剥离类型，没有复制数值或加载硬件驱动。
- Node 原生模块、Mock、键盘和 Server 全部位于 simulator/，只由桌面启动脚本加载；生产 manifest 不打包 simulator/ 或测试。
- 修改了 firmware/package.json 的 npm scripts；没有新增依赖，没有修改 package-lock、host、平台、SDK 或 ESP-IDF。
- Node 模拟器不是 Moddable Linux/Piu 模拟器，不依赖图形桌面。Node 22 的类型剥离 API 会输出 experimental 警告。

### 新增文件与职责

路径相对 `mods/my_companion/`：

| 文件 | 职责 |
| --- | --- |
| app/conversation.js | 严格聊天生命周期、关联 requestId、可取消的显式幂等重试；无历史和模型调用 |
| simulator/index.js | 单入口装配与启动失败清理 |
| simulator/simulator.js | 复用 Companion、装配两个 runtime、输入任务互斥、快照、关闭 |
| simulator/register.js、loader.js、runtime.js | Node 模块解析、源码枚举、Timer/Time 适配 |
| simulator/config.js | 仅模拟器使用的端口、场景、延迟、测试人格与预算，不改生产配置 |
| simulator/mock-robot.js | 最小 MockRobot、MockInput、MockFace、MockMotion 和抽屉/气泡状态 |
| simulator/mock-input.js | readline 键盘命令、聊天输入、Ctrl+C/q/EOF 清理 |
| simulator/mock-wifi.js | NetworkService 形状替身，下面不接真实 Wi-Fi，上面仍运行原 WiFiController |
| simulator/mock-http.js | Node HTTP → SDK Request 回调/read/close 约定，限制仅本机 HTTP |
| simulator/mock-server.js | 三个接口、可控故障、延迟、固定回复、有限去重缓存 |
| simulator/presentation.js | 安全情绪回退、动作白名单、SPEAKING/VOICE 日志及可取消停留 |
| simulator/tests/ | 协议、核心流程、adapter、CLI、资源关闭及生产清单隔离测试 |

### Mock 边界

MockRobot 只提供当前使用的 face.setEmotion、motion.lookAway/lookAt/setTorque/setPose、
input.button.power.onEvent、ui 气泡/抽屉和 connectivity.network.ready。
它记录表情、姿态、凝视、扭矩和气泡，并输出终端日志；不模拟 CoreS3 全部能力。

MockWiFi 以真实 NetworkConnectionState 枚举提供一个原生服务替身，真实 Phase 2 WiFiController 负责状态和重连。
公开 connect/disconnect/isConnected/getStatus 交给该 controller；setAvailable(false) 模拟 AP 消失，
使自动测试观察 RECONNECTING、ERROR、退避与恢复。w 是用户主动断开，因此不会被自动重连立即覆盖。

MockHTTP 使用本机 node:http，实际经过 loopback TCP 和 HTTP 解析，不直接返回预制 JSON。
禁止连接非 loopback 主机，不伪装 HTTPS。超时、取消、状态分类、响应字节限制和 JSON 解析仍由未修改的 ApiClient 处理。
适配器补齐 SDK 自动生成的 Host、Connection、Content-Length；Node 原始 header 数组不会自动补齐这些行为。
请求结束后关闭底层 request/response；不存在额外无限响应缓存。

### Mock Server 与聊天协议

| 接口 | 返回 |
| --- | --- |
| GET /api/device/config | robot-001、小七、voiceChat/vision=true；不启动任何真实功能 |
| GET /api/health | status=ok、serverTime |
| POST /api/chat | 校验 deviceId/requestId/text，返回关联 requestId 和完整 reply |

请求：

```json
{ "deviceId": "robot-001", "requestId": "chat-001", "text": "你好" }
```

响应：

```json
{
  "requestId": "chat-001",
  "reply": { "text": "你好呀，我是小七。", "emotion": "happy", "action": "look_around", "voiceId": "default" }
}
```

必填字段必须是非空字符串。deviceId/requestId 最多 64 字符，请求 text 最多 1024 字符；
reply 必须为对象，reply.text 最多 2048 字符、emotion 最多 32 字符、action/voiceId 最多 64 字符。
响应 requestId 必须与请求体匹配，错误关联返回 INVALID_PROTOCOL；已知字段之外的数据不保留。
未知 emotion/action 是合法字符串，不由 Protocol 擅自限制枚举，交由展示 adapter 安全处理。

- 未知 emotion 记录 fallback，再复用真实 FaceController 回退 NEUTRAL。
- look_away 映射已确认存在的 motion.lookAway；look_around 在桌面 adapter 中映射两次小范围 lookAt。
  没有发明 robot.motion.look_around 方法，也没有给真实硬件新增动作实现。
- 其他 action 记录 ignored；不使用 eval 或用服务器字符串直接查找对象方法，constructor/__proto__ 等不会执行。
- SPEAKING 只输出文字与 voiceId 并短暂停留，不进行 TTS 或音频播放。
- 默认显示的“小七”是独立模拟器 fixture，通过原有 Persona 加载；不是生产默认人格，也不是新增远端 Persona 应用流程。

聊天复用 Companion.runTask：单任务运行时保持 THINKING，不接受排队输入；请求/校验成功后进入 SPEAKING，
再等待已有姿态任务排空后应用回复表情和动作，避免默认表情/迟到的 lookAway 覆盖回复；最终或失败回 IDLE。
这是终端模拟的动作/展示流程，不构成真实设备执行证明。

**POST 重试边界**：生产 ApiClient 的 POST 不自动重试，保持 Phase 2 策略。
Conversation 仅在 retry.enabled 与 idempotentServer 都严格为 true 时重试，最多 3 次；
模拟器默认 2 次，覆盖 TIMEOUT、NETWORK_ERROR 和 500/502/503/504。
断网 NETWORK_DISCONNECTED、鉴权、限流、JSON/协议/预算错误不重试。
Mock Server 按请求体 deviceId+requestId 去重，同一 ID 的文本冲突返回 400；缓存最多 32 条、有效期 60 秒。
重试复用相同聊天 requestId，在缓存窗口和容量范围内服务端只计算一次固定回复。真实服务必须提供覆盖重试预算的幂等保证；未知服务器不承诺幂等时不得开启此开关。
HTTP 层 X-Request-Id 是每次 ApiClient 调用的追踪 ID；聊天去重使用正文 requestId，两者职责不同。

Mock Server 的错误场景会覆盖实际路由输出。timeout 故意不返回数据，由真实 ApiClient 截止时间关闭连接。
Node 服务端限制请求体 8 KiB；客户端仍按 Phase 2 的 32 KiB 响应预算处理 large-response。
缓存、HTTP socket、延迟定时器、重试等待、说话停留和 stdin 均在退出时清理。

### 验证与下一阶段

`npm test` 已包含原仓库单元测试与 simulator:test。Phase 1/2 的独立测试另按原命令回归。
本阶段测试使用进程内替身和本机 loopback，不需要外网、真实 Wi-Fi、真实 AI Server 或 SDK 环境变量。
验证覆盖正常聊天、状态顺序、500/503/timeout 有限重试、断网、坏 JSON、大响应、协议错、未知情绪/动作、
按键流程、关机时取消请求/重试/展示，以及生产清单不含桌面模块。

Phase 3 建议先用同一协议接入受控的自有 AI Server；先确定设备鉴权、正文 requestId 幂等约定和生产 HTTPS 传输，
再为真实 ESP32 装配 Conversation 与动作/展示 port。模型供应商只存在服务器端。
本阶段不解决已记录的生产 HTTPS 缺口，不声明 Node 测试等同于 XS 或真机验证。

## Phase 1/2 真实设备路径说明

以下内容说明现有 ESP32 路径；模拟器独有配置与聊天装配以上文为准。

## 文件职责

路径均相对 `mods/my_companion/`。

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 显式声明 MOD 模块，使用 my-companion 命名空间，不打包测试 |
| `mod.js` | 官方 onContextCreated 入口，注入真实平台适配器，重新初始化前关闭旧实例 |
| `config.js` | 空服务器凭证、集中测试路径、网络/HTTP 预算、人格、动作和日志设置 |
| `app/companion.js` | 组装控制器，保存系统网络状态，驱动测试请求生命周期和清理 |
| `app/state.js` | 10 个陪伴状态、进入/退出回调、持续时间、当前动作、对话阶段 |
| `app/persona.js` | 加载本地人格配置并限制大小；Phase 2 不应用服务器返回的人格 |
| `hardware/face.js` | 逻辑情绪到真实 Emotion 常量的映射 |
| `hardware/motion.js` | 小角度姿态、串行调度、仅保留一个最新等待意图、释放扭矩 |
| `hardware/wifi.js` | WiFiController、系统网络状态、观察单例、退避与清理 |
| `hardware/network-runtime.js` | 真实 network-manager、network-state、stored-wifi、Timer/Time 适配 |
| `ai/api-client.js` | 唯一的 HTTP Request 创建入口；GET/POST、超时、预算、重试、取消、JSON |
| `ai/http-runtime.js` | SDK Request、URL、TextDecoder、Timer、Modules 和 UTF-8 编码适配 |
| `ai/protocol.js` | JSON 解析、DeviceConfig/HealthResponse 校验，仅返回已知字段 |
| `utils/network-errors.js` | 可分类的 NetworkError、HTTP 状态映射及重试策略 |
| `utils/logger.js` | 标签与 debug 开关；保留错误日志 |
| `tests/state.test.mjs` | Phase 1 状态与 Persona 测试 |
| `tests/wifi.test.mjs` | 网络状态、复用连接、断线、退避、看门狗、停止和无凭证 |
| `tests/api-client.test.mjs` | HTTP 分类、超时、重试、JSON、UTF-8、预算、取消、TLS 门控和日志 |
| `tests/protocol.test.mjs` | 协议字段、类型、缺失字段和非法 JSON |
| `tests/companion-network.test.mjs` | 电源键/抽屉到请求、THINKING、失败恢复、禁止应用远端 Persona |
| `tests/sdk-http.test.mjs` | 直接执行已安装 SDK 原始 http.Request，校验字节分段及提前 close |
| `tests/helpers/` | 确定性时钟、HTTP 能力替身、SDK socket 字节替身，仅用于测试 |
| `tests/register.mjs`、`tests/node-loader.mjs` | Node 测试解析与 SDK 代码加载，不进入 MOD |
| `tests/companion-runtime/`、`tests/node-runtime.mjs` | Phase 1 能力测试；显式关闭网络以隔离动作和状态 |

## 使用方式与配置

Wi-Fi SSID/密码继续通过官方设置 UI 与 host Preference 配置，不写入 MOD 源码。
服务器地址、deviceId、token 默认均为空；没有真实服务器或凭证时，短按测试会记录 INVALID_CONFIG 并回 IDLE。
不得把真实 Token、密码、JWT 或云模型密钥提交 Git；运行配置可通过构造器注入，当前未实现额外的安全配网或凭证管理产品流程。

默认设置：

- `network.enabled=true`，每 500 ms 观察已有 NetworkService；单个原生连接阶段看门狗 15 秒。观察间隔限制为 10–5000 ms，看门狗最大 120 秒。
- Wi-Fi 退避从 1 秒开始，失败后翻倍，最大 60 秒；连接成功后重置。可通过 reconnect.enabled 关闭自动重连。
- `server.testPath=/api/device/config`，`testProtocol=deviceConfig`；可改为自有路径。
- 测试健康接口时同时设置 `testProtocol=health`，避免按 DeviceConfig 误判响应。
- `server.timeoutMs=10000`：每次尝试总截止期限，包括连接、发送、接收。GET 默认总计最多 2 次尝试，中间等待 1 秒。
- `server.maxResponseBytes=32768`：响应体最大字节数；`maxRequestBytes=8192`：POST UTF-8 请求体最大字节数。
- HTTP 预算校验：超时 1–120000 ms，响应/请求上限 1–32768 字节；重试最多 3 次，延迟为正整数且不超过 60 秒。
- `debug.enabled=false` 关闭本 MOD 的 debug 日志，不关闭错误及官方 host 日志。
- features.voiceChat/vision/emotionAnalysis 保持 false；收到服务器 true 不会启动这些能力。

运行时操作：

1. 沿用官方启动和联网流程；host 允许用户选择离线进入 MOD。MOD 不等待 ready 才更新 UI。
2. **短按电源键**或抽屉 `Companion: test server` 发起一次测试。
3. 统一业务状态为 `IDLE → THINKING → 请求/校验 → IDLE`；失败、超时、非法协议也回 IDLE。
4. 请求期间重复按键复用同一个测试任务，不排队；状态演示入口不会覆盖正在进行的请求。
5. 原有 next/previous/idle 演示入口保留。若存在 A/B/C，仍提供演示控制，不依赖它们测试网络。
6. stop 清理 API 请求/重试等待、Wi-Fi 观察/退避定时器、输入、抽屉、动作与气泡；恢复 IDLE。

网络变化只更新 `Companion.networkStatus`，不等同于 HAPPY/SAD/ANGRY。
状态机演示默认 5 秒回 IDLE；API 请求期间暂停演示自动回退，保持 THINKING 至请求结束，UI 线程仍可运行。
当前 host 没有 MOD onDispose 钩子；清理发生于显式 stop 或再次初始化，不虚构自动卸载事件。

## Wi-Fi 管理与源码依据

真实 API：

- `robot.connectivity.network.ready`：只表示 host 启动结果，不是持续订阅。
- `network-manager.getNetworkConnection()`：取得唯一的 host NetworkService。
- `network-manager.startNetworkConnection(options)` / `stopNetworkConnection()`：管理同一个单例。
- `NetworkService.state`、`network-state.NetworkConnectionState`：观察 CONNECTING/SYNCING_TIME/CONNECTED/RECONNECTING/FAILED 等真实状态。
- `stored-wifi.readStoredWiFiPreference('ssid'/'password')`：读取现有设置；不新建 Wi-Fi 驱动。
- SDK Timer.set/repeat/clear、Time.ticks/delta：非阻塞调度与可跨 ticks 回绕的时间差。

实现依据为 `firmware/host/modules/connectivity/{network-manager,network-service,network-state,stored-wifi}`、
`host/app/{main,boot-services,capabilities}`，以及平台 manifest 与 SDK 的 embedded:network/interface/wifi 实现。

WiFiController 提供 connect、disconnect、isConnected、getStatus、onStatusChanged、close。
系统状态为 DISCONNECTED、CONNECTING、CONNECTED、RECONNECTING、ERROR，订阅最多 8 个并提供取消函数。

- 已有健康连接直接复用，不重连，不反复调用 join，避免回调链累积。
- 观察到失联/失败后停止旧单例，清除其固定延迟重连计时器，再由 MOD 退避调度重建。
- 新建 service 的原生重连延迟设置为 maxDelayMs + pollMs，为 MOD 观察并接管留出窗口。
- 同时最多一个观察定时器和一个重试定时器；不会并行创建两个 Wi-Fi 管理器。
- CONNECTING/SCANNING/SYNCING_TIME 停滞超过看门狗期限，同样转入错误和退避。
- 没有 SSID 时停留 ERROR，不循环创建连接；下次显式 connect 或检测到设置后再尝试。
- close 保留借用的健康 host service，仅停止本 MOD 创建且仍为当前单例的 service。
- **disconnect 是设备级操作**，会停止当前共享网络单例；普通 Companion stop 使用 close，不主动断开借用的健康网络。

借用 service 的失联检测存在 pollMs 观察延迟；若整个 JS 事件循环被其他代码阻塞，所有 JS 定时器都会延后。
源码与替身测试不能替代真实 AP 断电、恢复及长时间运行验证。

## HTTP 行为与边界

业务只调用 ApiClient.get(path) / post(path, body)，SDK Request 仅在 ApiClient 内创建。
实际来源为 `$MODDABLE/modules/network/http/http.js`，host/app/manifest.json 已声明该模块。
使用 `new Request(options)` 后再设置 `request.callback`；当前构造器不读取 dictionary.callback。

使用的回调常量：status、header、responseFragment、responseComplete、error。
分段读取使用 `request.read(ArrayBuffer, count)`，取消/超时使用真实 `request.close()`，没有虚构 abort。

- 单个 ApiClient 同时最多一个操作，包含重试等待；重复调用报 BUSY，不增长队列。
- 每次尝试启动 Timer；超时、网络失联或 close 均终止连接并释放定时器/订阅。
- requestId 在同一逻辑请求及其重试之间保持不变，通过 X-Request-Id 发送；deviceId 使用 X-Device-Id。
- 非空 token 以 Bearer Authorization 发送；拒绝换行注入。日志不打印 header、完整 URL、查询串、token 或完整 JSON。
- path 必须是单斜杠开头的同源路径，不跟随重定向，不转发凭证到其他 origin。
  baseUrl 可为 http/https 地址，不允许 URL 内用户名、密码、查询串、fragment；绝对 path 使用 URL 标准从 origin 根解析。
- POST 经 JSON.stringify 后转为 UTF-8 ArrayBuffer，检查字符和实际字节预算；循环引用等返回 INVALID_REQUEST。
- 响应不设置 response:String，避免 SDK 不受限聚合。首个片段分配一个固定上限 Uint8Array，不保留片段对象列表。
- Content-Length 超限立即关闭；没有 Content-Length 或 chunked 时逐片检查累计字节，超限时不读取/保留该片段。
- 收齐后一次 UTF-8 解码，避免中文跨包损坏；非法 UTF-8 返回 INVALID_RESPONSE，JSON.parse 失败返回 INVALID_JSON。
- 204 空响应返回 null；测试 DeviceConfig 仍需通过协议校验。
- 请求 Accept-Encoding: identity；压缩响应明确拒绝 UNSUPPORTED_ENCODING。
- 3xx 返回 REDIRECT；400 BAD_REQUEST；401/403 AUTH_ERROR；404 NOT_FOUND；408 TIMEOUT；429 RATE_LIMIT；5xx SERVER_ERROR。
- 只有 GET 的网络错误、失联、TIMEOUT、502/503/504 可重试；400/401/403/404/429/500、解析/预算/协议错误不自动重试。
- **POST 默认不重试**，因为连接断开或超时不能证明服务器没有执行写操作。后续写接口需要服务器幂等协议。

字节上限约束响应体，不代表总 RAM 上限。解码字符串、JSON 对象、SDK HTTP 头、socket/TLS 缓冲仍有额外内存开销。
不缓存聊天历史、图片、音频；业务不得传入巨大待序列化对象。当前 JSON 大小上限是小型设备配置用途。

## HTTPS 当前缺口

**当前 http.Request 通路的 HTTPS 不可直接使用，不能报告已完成 HTTPS 握手或证书校验。**

源码证据：

1. host 音频/fetch/WebSocket 清单链引入 SDK `examples/io/tcp/tlssocket/manifest.json` 和 `modules/crypt/tls_419.json`。
   已有 `embedded:io/socket/tcp/tls`、`ssl/session` 的 session_419，以及 CA 资源。
2. 旧式 `http.Request` 使用旧 Socket 回调/read/write 约定；HTTPS 要求传入兼容的 Socket 构造器，通常是 securesocket。
3. 当前 host 清单未声明 securesocket。SDK `modules/crypt/tls.json` 才声明它，并把同名 ssl/session 指向 session_original。
4. `session_original.handshake(s,n)/read(s,n)/bytesAvailable` 与 session_419 的 transport 约定不同。
   **不能直接把 419 TLSSocket 当作旧式 SecureSocket，也不能盲目 include tls.json 覆盖现有 ssl/session。**
5. securesocket 还需要 `modules/crypt/securesocket/modsecuresocket.c` 中的 xs_securesocket_read/write，普通 MOD 归档不能新增这些原生函数。

本阶段行为：http-runtime 通过真实 Modules.has 检查兼容 securesocket；当前缺失时返回 HTTPS_UNAVAILABLE。
没有静态 import 不存在模块，没有降级到 HTTP，没有 verify:false。
若未来 host 提供兼容 socket，ApiClient 的适配路径会设置 Socket、443、verify:true、trace:false、TLS 1.2；此路径目前只有能力替身测试。
SDK Modules.importNow 默认返回 default export，源码证据为 `modules/base/modules/modules.c`，不是 namespace.default。

证书和时间：

- SDK `ssl_cert.js` 会检查证书链、SAN 主机名和有效期，使用 Date.now；信任根必须覆盖 AI Server 证书链。
- host 当前显式附带 ca109/ca176/ca236 和 CA 索引，不代表信任所有域名或私有 CA。
- host NetworkService 在设备日期不晚于 2023 年初时尝试 SNTP；日期超过该阈值就跳过，不能证明当前时钟准确。
- MOD HTTPS 门控最低时间为 2024-01-01，仅能拒绝明显未设置的时钟，不能证明时间可信或足够新。
- 旧式 socket 隐藏了部分握手原因，异步失败只能保守记录 TLS_OR_NETWORK_ERROR；不伪造“证书错误”或“鉴权失败”。

最小解决方案（仅记录，未实施）：

- **优先保持 host 不变**：在 `ai/http-runtime.js`/`ai/api-client.js` 增加或替换为已有 embedded:network/http/client + ECMA-419 TLS 的传输适配，保留 ApiClient 对外接口和相同预算/测试。
  这是 MOD 层可行性方案，需单独实现与验证，当前不冒充已经支持。
- 如果后续坚持旧式 http.Request + SecureSocket，则必须审查 `firmware/host/modules/connectivity/manifest.json` 的原生 glue 声明，
  为 legacy TLS session 和 SecureSocket 提供隔离命名空间的适配文件；涉及 SDK `session_original`、securesocket JS 的 import 重绑定和 modsecuresocket.c。
  禁止覆盖现有 ssl/session。只有在明确授权后才调整 host，并同时回归官方联网示例。
- 私有 CA 需要补充相应证书资源或 SDK 支持的注册机制；具体资源文件取决于真实 AI Server 证书，当前未提供所以不编造 CA。

交叉核对文档：[HTTP Request](https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/network/network.md)、
[SecureSocket](https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/network/securesocket.md)。版本事实以本机 SDK 9.0.0 源码为准。

## 当前服务器协议与下一阶段边界

默认接口：`GET /api/device/config`，可使用 X-Device-Id、X-Request-Id 和可选 Bearer 凭证识别设备/请求。
服务器应返回非压缩 UTF-8 JSON，响应体不超过配置上限。

```json
{
  "deviceId": "robot-001",
  "persona": { "name": "小七" },
  "features": { "voiceChat": false, "vision": false, "emotionAnalysis": false }
}
```

deviceId 为必填非空字符串，最多 64 字符；persona 可选且 name 为最多 64 字符的字符串；
features 可选，已知开关必须为 boolean。未知字段忽略。配置了本机 deviceId 时，不接受其他设备 ID 的配置。
只校验并记录 config valid，不应用远端 Persona/features，不保存原始响应。

HealthResponse：必填 status 为 ok/degraded/error；可选 serverTime 为最多 64 字符的字符串。
健康接口路径由 server.testPath 指定，没有在业务中硬编码第二条路径。

```json
{ "status": "ok", "serverTime": "2026-10-16T08:00:00Z" }
```

Phase 2.5 已定义 POST /api/chat 的基础文本协议（见上文）；后续真实服务器可扩展可选会话标识。
响应建议保留 requestId，以及 reply.text/emotion/action/voiceId。
服务端保存上下文/记忆并绑定用户 Persona；机器人不直接绑定模型供应商。
开始写接口前，需要服务端明确鉴权、错误响应、最大长度、幂等/去重和超时语义。
真实 ESP32 入口仍只使用基础 JSON 通信和设备配置测试；聊天端点目前仅在 Linux 模拟器调用。

## 验证命令与证据边界

在 firmware 目录执行，加载现有环境仅设置当前 shell 变量，不安装或重配工具链：

```bash
source ~/.local/share/xs-dev-export.sh
node --import ./mods/my_companion/tests/register.mjs --test mods/my_companion/tests/*.test.mjs
node mods/my_companion/tests/node-runtime.mjs
npm test
npm run mod:build -- mods/my_companion/manifest.json
./node_modules/.bin/biome check mods/my_companion
```

SDK contract 测试直接加载 $MODDABLE/modules/network/http/http.js，运行原始 Request 解析器；
底层 Socket 仍是字节替身。其他网络测试使用确定性时钟与能力替身，不依赖真实服务器。
本次独立测试 59 项通过，Phase 1 能力回归输出 ok，仓库 npm test 404 项通过，指定 MOD 构建退出码 0，Biome 检查通过。
没有新增生产 Node.js 依赖。Node 22 的 stripTypeScriptTypes 会产生 experimental 警告。

Phase 1 的额外 XS 模拟器测试此前被缺少 xvfb-run 阻断；未为此安装软件或改变环境。
本次不把 Node 测试描述为 XS 真机执行。
MOD 构建成功只证明归档编译通过；未刷机、未实测 AP 断连、真实 HTTP Server、TLS 握手或设备长期稳定性。

## 变更记录

### 2026-10-16 — Phase 4 自有Server/API易两协议族

- 变更摘要：新增设备鉴权的自有Server、Omni/GA Provider adapter、流式重采样与限速、工具接口、真实模式Simulator和分级冒烟。
- 影响文件：server/（含独立package/lock）、simulator/apiyi-simulator.js及入口；ai/realtime-protocol/session/runtime增量；根package脚本；CLI/隔离/adapter测试；docs/APIYI_REALTIME、REALTIME_PROTOCOL与本文件。
- 影响范围：默认Mock不变；仅显式真实模式加载Provider；新增text/error和设备凭证回调。未修改host/平台/SDK/IDF/原Wi-Fi/HTTP/音频硬件实现/Companion/入口/固件根lock。
- 验证结果：npm test原404+Simulator95+Server32=531项通过；realtime37；server32；旧独立59；全仓库lint/format通过（lint有1条既有info）；MOD build退出0、66331字节。真实API文本/WAV/Simulator均因无APIYI_API_KEY明确SKIPPED，无真实延迟/usage结果。真机未验证。

### 2026-10-16 — Phase 3 Realtime 流式架构与模拟器

- 变更摘要：新增独立 Realtime 协议/会话/有界音频缓冲、双向 binary streaming、打断、有限重连与指标；扩展 Linux 键盘/Mock Server/音频 fixture。
- 影响文件：ai/realtime-*.js、ai/audio-buffer.js、hardware/audio-{input,output,runtime}.js、app/realtime-presentation.js、simulator 新模块及 realtime*.test.js、config/manifest、firmware/package.json、docs/REALTIME_PROTOCOL.md 与本文件。
- 影响范围：保留 HTTP/text、10 状态与原 ESP32 入口；生产新 adapter 仅被编译、默认不启用。音频双工和可信时间 fail closed；没有接模型、录音文件、STT/TTS/Camera。
- 验证结果：npm test 404+95=499 项通过；独立 realtime 37 项通过；Phase 1/2 独立 59 项与原能力回归通过；Biome 67 文件通过；MOD 退出码 0，归档 65393 字节。实际启动 npm run simulator；键盘实时/打断/断网/恢复 HTTP 与文本闭环自动化通过。624 个受保护文件哈希不变，含 host、原硬件/HTTP、Companion、mod.js、package-lock。真机与真实 WSS/AI Server/Provider 均未验证。

### 2026-10-16 — Phase 2.5 Linux 终端模拟器

- 变更摘要：新增独立桌面 runtime、Mock Robot/Wi-Fi/HTTP、本地 Server、严格文本聊天与自动化键盘闭环。
- 影响文件：simulator/、app/conversation.js、ai/protocol.js、app/companion.js、firmware/package.json 与本中文文档。
- 影响范围：Companion 通用任务门控抽取；协议增量；Node npm scripts。真实硬件、生产网络 adapter、ApiClient、入口、配置、manifest、host 与依赖保持不变。
- 验证结果：simulator:test 58 项通过；Phase 1/2 独立测试 59 项通过；原能力回归输出 ok；最终 npm test 原有 404 项 + 模拟器 58 项全部通过（共 462 项）；指定 MOD 构建退出码 0。实际启动 npm run simulator 并操作 t/c/w/s/q 成功；624 个受保护文件哈希未变。Biome 与 diff 检查通过；未进行真机验证。


### 2026-10-16 — Phase 2 网络基础设施

- 变更摘要：新增共享 Wi-Fi 单例封装、有限 HTTP JSON 客户端、协议校验和电源键/抽屉测试入口。
- 影响文件：上方职责表的网络模块、配置、MOD 入口、Companion、manifest、网络测试及本中文文档。
- 影响范围：默认启用网络观察，电源键改为测试配置接口；未应用服务器人格与功能，不修改底层和依赖。
- 验证结果：独立测试 59 项通过（含原有状态/Persona 3 项）；Phase 1 Node 能力回归输出 ok；仓库 npm test 404 项通过；Biome 通过；指定 mod:build 退出码 0，生成 my_companion.xsa。HTTPS 仍为上述适配缺口，未做真实服务器或设备网络验证。

### 2026-10-16 — Phase 1 离线基础

- 变更摘要：将简单演示替换为 Companion、统一状态、Persona、Face/Motion 和 Logger。
- 影响文件：mod/config、app、hardware/face、hardware/motion、utils/logger、manifest 和原有 tests。
- 影响范围：10 种逻辑状态映射到官方 8 种表情；小角度动作使用真实 setPose/setTorque；不增加硬件 API。
- 验证结果：状态/Persona 3 项与 Node 能力测试通过，仓库 404 项通过，MOD 归档构建成功；无真机证明。

## Phase 3 Realtime 基础架构与源码调查（2026-10-16）

独立 RealtimeSession/Client，不复用 HTTP 请求生命周期；控制 JSON，PCM 二进制。
协议 v1 的 16 字节网络序头：SC magic(uint16)、version(uint8=1)、direction(uint8=1 input/2 output)、turnId(uint32)、sequence(uint32，从 1 开始)、PCM 字节数(uint32)。PCM 本身小端。不同 turn、重复/乱序包不能重新激活已取消播放。
新增 realtime-protocol/realtime-config/audio-buffer，资源限制集中配置；生产默认 enabled=false。

已从当前源码确认：
- host/modules/audio/microphone.ts 暴露 microphone.onReadable、start、stop；audio-in.js 转出 embedded:io/audio/in。
- SDK modules/io/audioin/esp32/audioin.{js,c} 提供持续回调、read(size/buffer)、start/stop/close，16bit LPCM；C 使用 I2S RX/环形缓冲/任务，配置通道 I2S1。
- host/modules/audio/manifest.json 与 platforms/m5stackchan_cores3/manifest.json：输入 16000Hz/16bit、硬件双声道；Microphone 请求 channels=1，SDK read 对单声道执行 strip channel。线上输入约定 16000Hz/mono/pcm_s16le。采样字节顺序来自 ESP32 小端 int16_t；实际模拟信号质量未验证。
- Speaker.play 只支持完整 WAV；pins/audioout 已由 CoreS3AudioOut 包装原始 i2s AudioOut（更新 amp.sampleRate）。RawSamples/Callback/Flush、start/stop/close 在 SDK modules/pins/i2s/audioout.js 存在；PCM 缓冲必须 SharedArrayBuffer。输出约定 24000Hz/mono/pcm_s16le，与 host audioOut 定义相同。
- host/modules/connectivity/manifest.json 已包含 WebSocket manifest；examples/io/tcp/websocketsclient/config.js 提供 device.network.wss.io（embedded:network/websocket/client）与 TLS419。低层 write 无隐式队列，onWritable 报告容量；onReadable 支持 binary/more。高层 WebSocket.js 会无界拼接接收消息，故生产 adapter 使用低层并先限制分片字节数。
- SDK tlssocket.js 把 verify/ca/host 转给 Session；ssl_cert.js 默认 verify=true。WSS 不依赖 Phase 2 缺失的 legacy securesocket，因此不能把 HTTPS_UNAVAILABLE 推导成 WSS 不存在。必须校验证书链、域名、日期；设备时间可信性不能由一次编译证明。
- Camera：host/app/runtime-camera.ts 管理触摸共享资源；host/modules/camera/device/camera.ts 支持 capture(options)，默认 176x144/rgb565le（当前源码值），有 jpeg 类型分支，返回 frame.buffer/width/height/imageType/close。GC0308 是否实际支持请求 JPEG、有效分辨率/帧内容，当前无硬件无法确认。本阶段不启动 Camera。

当前环境无法确认：真实麦克风采样、扬声器连续播放/即时静音、双向声学回声、AP/WSS 握手、目标服务器 CA 覆盖及真实时钟。host Speaker facade 缺少 streaming/stop，最小方案为新增 MOD adapter 使用已打包 pins/audioout，不修改 host。生产开启前须保证其他 TTS/webRadio 未占用设备，并验证双工及回声；不实现假的客户端 VAD。

新增二进制协议与有界环形队列及基础测试；最终验证结果见本节末尾。未改 host/SDK/现有硬件实现。

Phase 3 实现补充：
- ai/realtime-client.js 管理单一 transport/epoch，丢弃旧 socket 回调；realtime-session.js 负责握手、持续采集、响应 turn、播放泵、打断、超时/心跳及有限重连。所有计时/音频/连接均注入；现有 Companion/HTTP/Wi-Fi 源文件不变。
- hardware/audio-input.js 包装真实 robot.audio.microphone 的 onReadable/read；audio-output.js 通过注入的 AudioOut 分片 RawSamples + Callback，stop/Flush/close；audio-runtime.js 绑定已存在 pins/audioout。默认 MOD 入口尚不启用这些 adapter，避免在无设备、无可信时钟、无服务器时启动硬件。
- realtime-runtime.js 使用 device.network.wss.io，强制 wss、verify=true、TLSv1.2 下限、域名与可信时间 gate；可注入私有 CA。保留 Resolver 引用并 close，抑制 DNS 晚回调，避免 SDK 构造器 DNS 阶段关闭后重新创建连接。TLS 错误输出固定错误码，不输出 URL 凭据。
- simulator/realtime-simulator.js 是现有 Simulator 的新增 sidecar，使用原 runTask 门控租约，防止演示 hold timer/HTTP 操作覆盖实时状态；退出前释放租约。不改 app/companion.js。
- Mock Realtime Server 以 upgrade listener 接入同一 8787 端口；Node 22 内置 WebSocket 客户端，无新增依赖。mock-websocket.js 是只用于 loopback 的受限 RFC6455 测试实现：mask、ping/pong/close、TCP 分段/粘包，拒绝扩展/WS 消息碎片与 64bit 长度（生产 SDK adapter 支持 WS 消息分片）。
- 新增 MockAudioInput 产生 4 个各 640 字节 PCM（每 20ms），不是录音；MockAudioOutput 按 PCM 时长消费，不会真的发声。默认响应 3 个各 960 字节 PCM；可配置首包延迟、chunk 间隔及故障。
- 命令保持 t HTTP/c 文本，新增 r Realtime 连接、v 合成语音流、i 打断、x 退出实时恢复 HTTP、w Wi-Fi、s 状态/指标、q 释放资源退出。npm run simulator 自动启动两种协议的 Mock Server。新增 npm run realtime:test。

测试严格走真实 loopback WebSocket 回调边界；打断后允许已经在链路中的旧包被累计丢弃，不依赖固定的迟到包总数。

### Phase 3 协议、生命周期与运行

完整协议见 [REALTIME_PROTOCOL.md](./REALTIME_PROTOCOL.md)。生产 input=16kHz/mono/PCM s16le，output=24kHz/mono/PCM s16le；SDK C 与板级定义的证据如上。
输入/输出均为 chunk binary streaming；控制 JSON，包含 sessionId/turnId/requestId，避免打断和重连后的旧数据串音。
默认输出队列 7680 字节/8片，单片 ≤1920 字节；输入单片 ≤1280 字节，发送背压立即失败，不偷偷缓存。
INTERRUPTED 为 Realtime phase，连接状态独立；复用原 10 状态，不把网络异常映射成负面情绪。
TTFA 用对应 turn 最后发送 PCM 到首片有效输出接收的真实时钟差；不是模型真实延迟或扬声器出声测量。
增加 playbackTimeoutMs=2000，防止 network response.done 后 native callback 缺失永久卡住。

```bash
npm run simulator
# 输入 r 回车连接，v 回车发送4片合成PCM；i 打断；w切换Wi-Fi；s看状态和指标
# x退出实时后仍可t测试HTTP、c文本聊天；q退出
MOCK_FIRST_AUDIO_DELAY_MS=500 npm run simulator
MOCK_REALTIME_SCENARIO=invalid-message npm run simulator
npm run realtime:test
npm run simulator:test
```

MOCK_REALTIME_SCENARIO 支持 normal/invalid-message/large-chunk/sequence-error/buffer-overflow/unknown-emotion/unknown-action/no-ready/no-pong/no-output。
MOCK_FIRST_AUDIO_DELAY_MS 允许 0；Mock 固定绑定 loopback，不作生产 AI Server。
生产 config.realtime 是配置模板、默认 disabled；当前 mod.js 仍启动原 Phase 2 Companion，不因修改这个 flag 自动启动音频。
未来入口只需组合 RealtimeSession + createAudioRuntime + createRealtimeRuntime（并绑定 audio input onError → session.lost），
由生命周期拥有者在 Companion.close 前 dispose 会话；注入可信时间确认、服务器 WSS URL/认证与独占音频管理，不修改核心会话/缓冲/打断算法。

WSS 当前结论：已有可复用 SDK 路径与新增校验证书的 adapter；无实体设备、目标 CA/时钟验证，所以不是“真机 WSS 可用”的结论。
没有关闭 verify 或降级明文。默认 isTimeTrusted=false 直接 TIME_UNVERIFIED；缺少 device.network.wss 则 WSS_UNAVAILABLE。
目标 CA 不在 host 已打包信任根时可从本 MOD 注入 CA；不需修改 host。SDK TLS/DNS/native 分配的峰值不包含在 JS PCM 队列限额内，仍须真机测量。

### 真实双工的新增硬件缺口（必须保留）

继承 SDK build/devices/esp32/targets/m5stack_cores3/manifest.json 的 audioOut.i2s.num=1、BCK=34、LR=33、dataout=13，
本项目 m5stackchan_cores3/manifest.json 的 audioIn.i2s.num=1、BCK=34、LR=33、datain=14。
输入默认 16000Hz、输出 24000Hz，而共用时钟引脚。SDK modules/io/audioin/esp32/audioin.c 创建 RX channel，
modules/pins/i2s/audioout.c 独立创建 TX channel；单独录音/播放 API 存在不能证明这套双工所有权和时钟兼容。
当前源码证据确认“共享引脚 + 不同请求采样率”，不声称已经在设备上观察到失败。
因此 createAudioRuntime 默认明确抛 AUDIO_DUPLEX_UNVERIFIED；duplexValidated=true 只能表示调用方已经完成真实板级验证，不能用来绕过缺口。

最小解决范围：首先更换本 MOD 的 hardware/audio-runtime.js 与相关 AudioInput/Output adapter，验证同一 I2S 时钟下协调 TX/RX 资源。
可能需要统一设备采样率并在 adapter 内做有界重采样，保持线上 16k input/24k output 协议；host Microphone facade 目前不接受采样率选项。
若 SDK 独立 RX/TX 构造器不能安全共享同一 I2S channel，才需评估 host 原生音频协调模块的最小变更；此阶段不实施、不假设已有 duplex API。
AEC/回声消除也未实现；扬声器回放被麦克风重新采集时，真实 Server VAD 必须处理，而非把每片 PCM 当作用户打断。

Phase 3 生命周期补充：连接状态通过 onStatus 独立通知 CONNECTING/CONNECTED/DISCONNECTED/RECONNECTING/ERROR/STOPPED；
onPhase 仅呈现 LISTENING/THINKING/SPEAKING/INTERRUPTED/IDLE。外部回调抛错记录 PRESENTATION_ERROR，不让 UI 错误崩溃音频链路。
即使回调内部立即 stop，也不能重新创建计时器或启动输入。新增回调重入清理测试；每片播放 callback watchdog 与响应网络 watchdog 独立。
修正 Mock VAD 提示：即便服务器已发送 response.done、客户端仍有待播片，新轮输入仍发 speech.started，及时清掉尾部播放。

### Phase 3 最终验证记录（2026-10-16）

| 验证层 | 命令/证据 | 结果与范围 |
|---|---|---|
| 源码 | 本文引用 host/SDK 9.0.0 API 与板级配置 | 确认 API 存在；同 I2S1 不同速率风险明确记录 |
| 仓库与模拟器 | npm test | 404 原仓库 + 95 模拟器 = 499 项，0 失败 |
| 独立 Realtime | npm run realtime:test | 37 项，含真正 localhost TCP/WebSocket，不依赖真实模型/设备 |
| 原 Phase 1/2 | node --import ./mods/my_companion/tests/register.mjs --test mods/my_companion/tests/*.test.mjs | 59 项通过（先 source 现有 SDK export） |
| 原能力回归 | node mods/my_companion/tests/node-runtime.mjs | ok |
| 终端运行 | npm run simulator | 实际启动 r/v/w/s/x/t/c/q；新增 CLI 自动化覆盖 r/v/i/w/s/x、HTTP/text 与退出 |
| 静态检查 | ./node_modules/.bin/biome check mods/my_companion；git diff --check | 67 文件通过；diff 检查通过 |
| MOD 归档 | npm run mod:build -- mods/my_companion/manifest.json | 退出码 0；BUILD SUCCESS；65393 字节 |
| 保护边界 | 本轮编辑前后 SHA256 比对 | 624 文件未变；未修改 host/SDK/IDF/平台/原硬件/原 HTTP/原 Companion/入口/package-lock |
| 真实硬件 | CoreS3/AP/Mic/Speaker/WSS/真实 Server/Provider | 全部未验证，不刷机、不宣称设备可用 |

MOD 路径：dist/bin/esp32/debug/my_companion/my_companion.xsa。
SHA256：52283a09d81ae112f6758676355b5c661333aa739f72c6c154ed0ed14582440c。
package-lock 在本轮开始前已有工作区改动，原样保留；没有新增 Node 依赖。
测试日志在 /tmp/companion-phase3-npm-test.log、/tmp/companion-realtime-tests.log、/tmp/companion-phase3-build.log。

一次最终 npm test 内的真实本地测量（模拟首包延迟 500ms，非真实模型性能）：

```json
{"connectionTime":1.8436420000000453,"firstInputAudioTime":674.150931,"firstServerResponseTime":734.83472,"firstOutputAudioTime":1234.762811,"timeToFirstAudio":500.2843130000001,"audioChunksReceived":3,"audioBytesReceived":2880,"audioChunksSent":4,"audioBytesSent":2560,"interruptionCount":0,"reconnectCount":0,"droppedChunks":0,"protocolErrors":0}
```

三轮测试发送 12 片/7680 字节、消费 9 片/8640 字节，队列归零；打断专项验证 interruptionCount=1、cancelEvents=1、clearEvents=1；
Server 主动关闭专项 reconnectCount=1。不同测试分别测量，不拼接成一次会话指标。
覆盖首包即 SPEAKING、连续输入、流式播放、server activity hint、生成已完成但待播尾音打断、迟到包、重复/跳序、未知 emotion/action、非法 JSON、超大 chunk、溢出、背压、连接/响应/播放/心跳超时、Wi-Fi 与 Server 重连、stop/start/dispose、回调内部 stop、清理资源与键盘退出。

下一步首先实测并解决 AudioRuntime 的共享 I2S 时钟/资源协调与 AEC 策略，同时部署实现本协议的自有服务器、设备鉴权、可信时间与目标 CA/WSS。
Provider Adapter 只放服务器；在这些条件落实后，替换/绑定 adapter 与入口生命周期即可复用现有 Session/Protocol/Buffer/Interruption/Emotion/Action 核心。

## Phase 4 — 自有 Server 与 API易 Provider（2026-10-16，代码/离线完成，真实API待凭证）

新增独立 server/ 包，依赖 ws 8.22.0（只改变 server/package-lock，不改变 firmware/package-lock），原因是需要生产级 WebSocket Server 和 Authorization header 的 Provider 客户端。
Provider 接口与两套协议族独立于 RealtimeSession；默认 Qwen Flash，GA 在 Server 做流式 16k→24k 重采样，设备仍保持 16k/24k。
Server 在 upgrade 前验证设备 token，身份和 Persona 从服务端记录读取；使用原设备 v1 binary 帧，不将 API易事件直接透传。
自动 VAD 的 speech_stopped 通知设备原有 commitInput，但该 commit 只确认设备 turn，不重复向上游手动 commit。
输出经过有界、20ms 限速队列，避免 Provider 大 delta 压满 ESP32 jitter buffer。新增统一 text delta/error 是现有协议增量，未重写 RealtimeSession。
真实运行通过 REALTIME_PROVIDER=apiyi 显式启用；默认仍 Mock。真实文件输入必须提供 16k mono PCM16 WAV、最长10秒，之后2秒静音帮助 VAD；没有麦克风或真实音箱声明。
设备 WSS adapter 增加凭证回调，仅发送设备 token，不包含 Provider key；TIME_UNVERIFIED / AUDIO_DUPLEX_UNVERIFIED 保留。
当前已跑通基础协议、Provider 事件与真实 localhost Server→原 Session 测试；真实 API Key 缺失，不宣称 Linux 真实 API 通过。完整配置及验证边界见 APIYI_REALTIME.md，最终统计见下表。

### Phase 4 最终交付与验证

详见 [APIYI_REALTIME.md](./APIYI_REALTIME.md) 与 [REALTIME_PROTOCOL.md](./REALTIME_PROTOCOL.md)。
本阶段新增独立server/provider/protocol/resampler/auth/tool/WAV模块；只对现有Realtime增加text/error、onTextDelta、凭证headers，不替换State/Companion/HTTP/Wi-Fi架构。
普通聊天走单一Realtime Provider；没有额外GPT调用、模型回退实现、摄像头或真实录音。
服务端人格/voice/user来自认证设备配置；连接内上下文由Provider保留，重连仅重放instructions，不声称已实现历史对话持久化。

| 层级/命令 | 结果 | 不能推出的结论 |
|---|---|---|
| npm test | 404+95+32=531通过 | 不代表真实API/硬件通过 |
| npm run server:test | 32通过 | 上游为离线fixture，不是API易 |
| npm run realtime:test | 37通过 | 不是CoreS3执行 |
| 旧Phase1/2独立测试 | 59通过 | 不替代AP/TLS实测 |
| npm run lint / npm run format | 全仓库通过，lint有1条既有info，未修host | 不代表真机内存峰值通过 |
| Biome check mods/my_companion | 新模块/修改模块通过 | 文档有真实调用缺口 |
| npm run simulator | 实际启动r/v/q且完整键盘CLI自动化通过 | 默认Mock不是真实API |
| server:smoke:text / server:smoke:audio | 正常退出，REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured | 未测TTFA/usage/模型兼容性 |
| REALTIME_PROVIDER=apiyi npm run simulator | 正常退出并明确SKIPPED，不偷偷回退Mock | 未通过Linux真实API闭环 |
| mod:build -- mods/my_companion/manifest.json | 退出码0，BUILD SUCCESS，66331字节 | 未刷机/未真实WSS/未音频双工 |
| 627个保护文件SHA256 | 本轮未变 | 用户原有根package-lock改动仍保留 |

归档：dist/bin/esp32/debug/my_companion/my_companion.xsa。
SHA256：62427768524ab7abc61ed378a23e799a6066c4cf110ecd8cd743c2ba69d7418c。
测试日志：/tmp/companion-phase4-{npm-test,server-test,realtime-test,build,lint,format}.log。
标准npm test中的所有CLI子进程显式强制Mock，即使父shell配置了真实Key/REALTIME_PROVIDER，也不会意外计费。
Server自身有独立package-lock，仅ws依赖；CI需先npm ci --prefix mods/my_companion/server，固件根lock未变。

已再次读取板级RX/TX同I2S1/BCK34/LR33及SDK独立channel创建源码，16k/24k冲突风险没有被解决，AUDIO_DUPLEX_UNVERIFIED不移除。
现有host SNTP无认证，且日期大于2023阈值时跳过校时，不能证明可信时间，TIME_UNVERIFIED保留，不新增伪造的time-runtime。
真实CoreS3到手后还需要设备凭证持久化、可信时间/CA、真实AP/WSS握手、双工/AEC/Flush及长时间内存验证。
当前缺少Key和真实短WAV，下一步按文本→短WAV→显式真实Simulator顺序联调；不得用Mock的500ms首包测量充当API易TTFA。


### 2026-10-16 - 服务器本地 Key 配置

- 变更：支持在 Git 忽略的 `server/local-config.js` 中填写 API易 Key；保留环境变量优先，显式空值禁用本地 Key。
- 文件：`server/local-config-loader.js`、`server/local-config.example.js`、`server/.gitignore`、Server/Smoke/Simulator 入口、`server/tests/local-config.test.js`、`docs/APIYI_REALTIME.md`。
- 影响：仅 Linux/Server 启动配置；不修改 MOD、host 或硬件路径。默认 Mock 不发起真实 API 请求。
- 验证：`npm run server:test` 33 项通过；变更 JS 文件 Biome 检查通过；`git check-ignore` 确认本地配置已忽略。不执行付费冒烟。


## 2026-10-17：Phase 4真实API验收

最新报告：[PHASE4_ACCEPTANCE.md](./PHASE4_ACCEPTANCE.md)，数字证据：[summary.json](./results/2026-10-17-apiyi/summary.json)。
四模型各5个真实文本和5个完整音频样本；四模型真实取消通过，真实上游关闭重连与模拟网络恢复后真实重连各通过一次，并保留失败试验。
E2E TTFA P50：Flash1810.8ms、Plus1935.1ms、GPT Mini2513.9ms、GPT 2.1：1870.9ms。<1000ms目标未通过；Simulator播放不是物理发声。

### 变更日志

- 日期：2026-10-17。
- 摘要：增加独立Linux付费验收和精确首包时间点，修复部分音频后断线误报成功，补充受控分片/安全诊断/可选server_vad静音配置。
- 影响文件：`server/acceptance.js`、`server/acceptance-audio.js`、`server/tools/generate-test-wav.py`、`server/smoke.js`、`server/output-stream.js`、`server/device-session.js`、`server/providers/apiyi/{apiyi-realtime-provider,model-config,apiyi-ga-protocol,apiyi-omni-protocol}.js`、Server测试、根/Server package.json scripts、三份协议/架构文档及新验收报告/数字证据。
- 影响范围：仅Server/桌面测试；原设备协议、硬件/HTTP/Companion/RealtimeSession生产实现未改。默认20ms、bounded queue、sequence/turn与cancel隔离保持；不修改host、平台、SDK、ESP-IDF、原package-lock或凭证文件。
- 验证：`npm test`540项通过(404+95+41)；`realtime:test`37项通过(包含在95中)；`server:test`41项通过(包含在540中)；变更JS Biome检查通过。完整lint/format通过，lint保留1条原有host info。
- MOD：先加载既有`~/.local/share/xs-dev-export.sh`，再运行`npm run mod:build -- mods/my_companion/manifest.json`，退出0，生成`dist/bin/esp32/debug/my_companion/my_companion.xsa`。首次未加载export导致mcrun ENOENT，未重配环境，修正调用后通过。
- 手工：默认Mock Simulator启动/退出通过；显式真实Provider Simulator运行v后完成LISTENING→THINKING→SPEAKING→IDLE并q释放资源。
- 限制：机械合成中文测试输入，不代表真人识别准确率/自然度评测；实际成本未对账，usage缺失不填0。CoreS3 Mic/Speaker/全双工/AP/TLS时钟和真实E2E仍未验证。


### 2026-10-17补充：真实Qwen VAD打断事件次序

通过真实中文WAV barge-in发现output_item.done先于cancel时PROVIDER_OVERLAP；仅在Provider Adapter有限保留32个已收口response ID，cancel可复用已有ACK并继续新响应。
ack-before-cancel的耗时不冒充RTT，interruption_latency保持null；5秒fallback与旧response隔离保持。新增先失败后通过的离线事件顺序测试。
真实复测“北京介绍→停一下→新回应”完成：WAV首片→模拟停播942.81ms，收到hint→stop 0.034ms，旧音频写入0；其他模型仅已完成入口触发取消，不能扩大为四模型自动语音打断全通过。
不改设备协议、RealtimeSession或硬件。详见PHASE4_ACCEPTANCE.md及voice-interrupt-final.jsonl；回归npm test540、server:test41。


最终独立Phase1/2测试59项通过；最终MOD重编译退出0，归档66331字节，SHA256 `62427768524ab7abc61ed378a23e799a6066c4cf110ecd8cd743c2ba69d7418c`。
633个host/平台/硬件/共享核心/根lock及Server lock文件与本轮开始快照一致；Git可见Companion文件的实际Key匹配扫描通过。
机器可读验证记录见`docs/results/2026-10-17-apiyi/verification.json`。未提交、推送或部署。

## Phase 4.5：有界流控、指标与只读诊断（2026-10-18）

本轮保留 Companion、设备 v1 协议、16k 输入/24k 输出和原有安全门控，未修改 host/平台/SDK/native audio。

- `server/output-stream.js`：PCM 仍最多 192000B；48kB/24kB 高低水位通知 Provider 暂停/恢复接收。发送前检查本地 WS 积压，暂时拥塞保留队首 PCM 与 sequence，5 秒持续不可发送才终止。统计 bytes/frames/backlog/pressure/peak，首帧仍立即发送，后续按采样时长绝对期限调度。
- `server/device-session.js`：把水位接入 Provider，预留控制消息发送空间；容量耗尽与持续慢消费者分别报告 `OUTPUT_CAPACITY_EXCEEDED` / `OUTPUT_CONSUMER_STALLED`，取消活动生成并释放队列。日志只含错误码、轮次和数字统计。
- `server/providers/apiyi/apiyi-realtime-provider.js`：通过实际 ws.pause/resume 实现 TCP 接收反馈；取消前先 resume，保留 output_item.done / 5 秒取消兜底；close 优先正常关闭，最多 1 秒后 terminate。
- `server/acceptance.js`：Linux 单调时钟、requestId/turnId、首包转发与播放调度事件。多响应打断模式不输出混合轮次的完整 timeline。`measurement_version=45.2` 起在 finishPlayback 实际完成回调记录播放结束；此前观测完成的旧字段仅作轮询上界，不参与新口径精确播放完成统计。
- `server/tools/benchmark-phase45.py` / `summarize-phase45.py`：显式付费的 20/40ms 各 10 次/模型测试及 nearest-rank 汇总。不会自动用于 npm test，也不会默认启动真实 API。
- `hardware/diagnostics.js`：只读快照；mod drawer 的 `Companion: diagnostics` 手动触发。只读真实 `robot.audio.microphone.recording` 和 WiFiController 状态，不调用 start/read/write，不创建原生音频对象。固件版本/目标板属于源码构建元数据，实际板型仍 UNKNOWN；未初始化音频返回 UNKNOWN。
- 测试：`server/tests/flow-control.test.js`（确定性时钟压力/慢消费者/取消/重连隔离）、`flow-wire.test.js`（离线真实本地 WebSocket receive pause/resume + cancel + 迟到包）、`simulator/tests/diagnostics.test.js`（只读与敏感字段过滤）。本地 WS fixture 不是 API易真实验证。

重要限制：TCP pause 不是模型级流控，也不是扬声器播放确认；可能同时延迟该连接上的 VAD/控制事件。内核/socket/WS 已接收缓冲不能靠 pause 撤回，超过 PCM 容量仍必须明确取消。当前设备协议没有消费 credit，发送成功只证明本地 socket 写入，不证明设备消费；任意长期变慢的真实扬声器仍需真机验证，不能保证由 Server socket 水位检测出来。

再次核对实际 SDK：`build/devices/esp32/targets/m5stack_cores3/manifest.json` 的 AudioOut 为 24k/I2S1/BCK34/LR33；项目 `host/platforms/m5stackchan_cores3/manifest.json` 的 AudioIn 为 16k/I2S1/BCK34/LR33（板级双槽，SDK 向 JS 交付 mono）。SDK `modules/pins/audioin/esp32/audioin.c:139` 分配 RX，`modules/pins/i2s/audioout.c:1501` 独立分配 TX；无法据此证明异采样率共享时钟可全双工工作。继续保留 AUDIO_DUPLEX_UNVERIFIED。无认证 SNTP 与日期阈值也不能解除 TIME_UNVERIFIED。

完整原始数据、测试与剩余阻塞见 [PHASE45_ACCEPTANCE.md](PHASE45_ACCEPTANCE.md)。Phase 4 报告和历史数据不覆盖。

Phase 4.5 长回复进一步复现 Simulator BUFFER_OVERFLOW：默认 MockAudioOutput 原先每片从回调后重新等待完整 20ms，文件写入/事件循环晚到时间会逐片累积，和 Server 采样率时钟发生漂移。模拟器改用可注入的单调采样 deadline；停止/欠载重置时钟，显式 playbackMs 慢消费者仍保留。`simulator/tests/audio-clock.test.js` 证明 100 片在每次回调晚到 2ms、处理额外 3ms 的情况下保持约 2005ms，而不会逐片增加完整等待；这是时钟模型验证，不是真实硬件速率验证。失败原始真实 API 数据保留，修复后结果另存 after-clock 文件。

自动语音打断的追加根因：实际 Qwen 事件顺序可为旧 output_item.done → speech_started → speech_stopped → 新 response.created。原 Adapter 已缓存旧 ACK，却仍发送不带 response ID 的 response.cancel，可能误伤上游已开始的新回复。现在对“旧 ACK 已确认”的分支仅使旧 response ID 失效并本地收口，不再发送迟到的无目标 cancel；活动生成仍正常 cancel、等待 output_item.done 并保留 5 秒 watchdog。provider.test.js 新增禁止该迟到取消的断言，已完成失败→修复→通过验证。真实事件账本只保存事件类型、responseId 和单调时刻，不保存文本或音频。

长回复验收工具原固定 25 秒完成窗口不足以覆盖约 20～30 秒音频加生成/网络时间；新增显式 ACCEPTANCE_COMPLETION_TIMEOUT_MS（1000～60000，默认仍 25000）。它仅改变 Linux 验收等待预算，不更改任何生产 timeout、VAD 或设备协议。25 秒超时的旧样本保留，不当作成功，也不等同于 Provider 拒绝。

## Phase 4.6 开发记录（2026-10-18）

- 变更：新增 `ai/pcm-activity.js` 固定10ms样本窗、40ms连续AC能量/动态范围门限的输入活动提示，以及 `ai/activity-input.js` 可插拔输入装饰器。仅在现有回复已开始且SPEAKING时工作，直接调用既有 RealtimeSession.interrupt，然后继续上传触发片，不等待Provider VAD或取消ACK。不是语音识别/断句/AEC，不能把任意PCM片当成人声。静音、DC、低幅噪声和单点脉冲的离线回归保留。
- 范围：manifest注册纯JS模块；`simulator/apiyi-simulator.js` 显式 `REALTIME_ACTIVITY_HINT=pcm` 启用，默认仍provider。生产MOD不自动启动音频，也不自动启用该活动提示，真实设备必须校准回声、门限及双工后才由生命周期owner选择此adapter。设备16k/24k格式、wire消息、Provider VAD、模型均未变。
- 原因：原先唯一自动speech_started来自Provider，同一WSS受OutputStream水位pause，活动控制与输出PCM共用接收流；本地stop本身不等待ACK，慢的是信号抵达。SDK Mic为真实onReadable回调，MOD有界分片立即转发，没有上传前整句缓存；无实体机器，DMA/实际回调频率依旧UNVERIFIED。
- 新验收：`server/progress-deadline.js`、`server/phase46-observer.js`、`server/phase46-acceptance.js`。仍复用真实ApiYiSimulator/Provider/原Session，原acceptance只增加可选观察钩子和进度watchdog，不改变默认旧测试预算。持续消费推进时不受旧固定60秒截止误杀，30秒无进展则STREAM_STALLED；单次180秒成本上限单独标ACCEPTANCE_COST_BUDGET，不冒充Provider错误。
- 指标：观察器按requestId/sessionId/turnId和Provider response ID关联，分别记录有效活动候选/触发、stop调用、缓冲清空、取消wire、ACK、恢复、新音频、逐轮末包/结束/播放完成及有界队列；没有远端内部/声学时刻则null/UNVERIFIED，不保存PCM/转写/敏感上下文。
- 验证：本轮基线npm test实际552通过；新增活动输入4项、进度watchdog2项已红→绿，真实Flash显式PCM提示先导试验成功，文件开始注入到本地触发约120ms（不是声学指标）。完整新实测/回归与未达标项待本轮PHASE46_ACCEPTANCE.md记录；不复用Phase4.5数字冒充本轮。

Phase 4.6 停播顺序与诊断补充：RealtimeSession仅小改clearPlayback的顺序（先epoch失效/清计时器，再stop，finally保证清buffer），不重写状态机；新增单份lastInterruption真实runtime单调时刻，记录调用、失效、stop、清缓冲和下一轮输入，不保留无限历史。只读hardware/diagnostics.js展示这些实际耗时、当前phase及STOPPED状态；真实播放打断/长回复/连续轮次/断网/重启验收仍返回UNVERIFIED。新增native stop抛错仍释放PCM的行为回归与真实本地WS延迟ACK测试，证明本地停播不依赖ACK、采集不断、旧包丢弃、新响应播放、退出后计时器/句柄/队列释放；本地WS上游明确是离线fixture，不计真实API成功。

Phase 4.6 重连验证追加根因：真实Flash连接已恢复且新轮首包已到达，旧验收工具却把RealtimeSession保留的历史lastError当成新会话错误，提前结束第二轮。现按CONNECTED状态和当前sessionId判断本轮存活，仍保留lastError用于诊断；相同错误码再次断线也能识别。新增历史错误/新损失同码回归，原失败保留，复验文件另存，不清空错误历史伪装稳定。Server另补provider_failure（阶段/轮次/实际attempt/失败前queue）与provider_retry数字事件，统一设备error wire不变。

硬件源码本轮补核：实际host/modules/audio/audio-in.js转发embedded:io/audio/in，CoreS3 audio manifest映射SDK modules/io/audioin/esp32/audioin.c（不是旧pins AudioIn）。该实现使用16384B native ring、MAX_INPUT_BLOCK=2048、读超时50，并以pendingCallback合并onReadable回调；mono交付字节数/2。真实回调周期不能据此断言20ms，MOD只保证每片<=1280B且立即上传。板级I2S1/BCK34/LR33及不同请求采样率风险不变；SDK关键源文件已额外保存只读SHA256，编译后核对，不修改底层。

本轮最终验收：[PHASE46_ACCEPTANCE.md](PHASE46_ACCEPTANCE.md)。新原始目录phase46-20261018T054456Z：90个有真实API证据的试验88成功/2失败，失败未删除，工具修复后复验另存；不是90笔计费请求。最终回归565（404+105+56）、realtime38、server56，MOD73749B；声学/硬件均未验收。22个实际样本hint轮检测→stop调用P95约0.240ms，候选→检测P95约61.48ms；默认provider仍不变。新增最终WAV完成追踪，仅可由该轮或其明确取消后的同session后继已完成响应满足，避免已播完新回复却等待被取消旧轮；其他SID或较早响应不能满足。阶段性初次失败、版本字段和未知时刻均保留。

## Phase 4.7 开发记录（2026-10-18）

本轮增量完善只读hardware/diagnostics.js：保留旧快照字段，新增有界checks（状态/证据/本地单调检查时间/原因/下一步）、队列/轮次/JS资源观察，物理八项仍UNVERIFIED。mod入口按项目逐行输出，避免一次序列化大报告；不创建音频/上传任务。WSS Runtime新增只读诊断，保留verify=true与默认TIME_UNVERIFIED，TLS/WS合并错误不能伪装精确CA故障。

已复现AudioOutput在volume/RawSamples enqueue/start异常时保留native实例或pending样本；增量加异常清理和只读状态。AudioInput在start/stop同时失败时原异常被覆盖、handler引用未清除；现保留初始化异常并finally清引用。只证明JS所有权/清理调用，native内部失败是否泄漏仍需实机验证。

新增hardware/device-voice.js仅负责复用原RealtimeSession/ActivityInput/AudioRuntime的生命周期；构造不连接/录音，必须显式confirmed且具有外部可信时间、双工和独占音频证据。mod新增明确告知mic/upload/playback的手动START、STOP、interrupt入口；默认realtime.enabled=false且未提供readiness证据，始终门控，不得声称已能真机双工。Companion.close在mod owner边界先释放voice，核心Companion不改；示例/API协议/16k输入24k输出不改。Phase4.7新增红绿用例与完整结果待PHASE47_ACCEPTANCE.md记录。

Phase4.7阶段埋点：RealtimeSession只新增一份lastAudioTrace（同request/session/turn），记录输入PCM交付/发送、设备首音频、播放write调用、done及最终回调；新Session清除旧trace，不保留增长历史。ADC采样时刻、远端Server/Provider时刻和实际声学输出无可观测证据则null，不能将跨机器时间直接相减。diagnostics按已知字段清洗展示。原Node Phase46 observer/指标工具继续复用，没有改wire协议或默认VAD。

输入活动补测仅使用确定性合成样本：静音/DC/低幅信号不触发；持续键盘样式噪声和播放样式纯音可以触发，说明energy hint不能解决AEC/人声识别。默认参数及默认关闭状态不变，不以提高阈值或缩短VAD窗口掩盖问题。Server只补401/404/409/429握手拒绝的固定code/status日志，未鉴权请求不创建Provider，不记录Header或设备凭证。

Phase4.7补充已复现的设备链路缺口：原音频工厂input.onError默认空函数，采集中错误可能只停止Mic却不通知Session。新DeviceVoice在创建AudioRuntime时注入固定码onError→既有RealtimeSession.lost，复用清理/有限重连；native close失败不再从readable异常路径逸出。集成回归证明三轮后注入输入错误会清buffer/释放采集handler，重复stop/start仍可恢复。原硬件factory签名与门控不改。

DeviceVoice停止后仅保留一份有界JS释放快照（timer数、buffer字节、socket引用），再次只读诊断仍可展示；native资源释放始终UNVERIFIED。WSS诊断explicitCAConfigured只说明调用方是否传入CA，内建根证书存储未知，不将false误解成“不校验”。最后一轮阶段时间/关联信息只保留固定字段，未来到货按CORES3_CHECKLIST.md逐项填写真实结果。

Phase4.7最终验证：本轮基线565通过；最终npm test582（404 unit+121 simulator+57 server）、realtime:test50、server:test57均0失败；有限真实Qwen Flash文本2轮+音频1轮3/3通过，其他模型/打断性能未重测，不复用历史为新数据。MOD BUILD SUCCESS；本轮产物92977B，物理声学指标仍全部UNVERIFIED。Biome/lint/format/diff通过（原host info保留），984个已有文件保护核对只有14个授权变更，5个SDK/IDF文件未变，凭证扫描无命中。详细边界、文件列表、数据与阻塞见[PHASE47_ACCEPTANCE.md](PHASE47_ACCEPTANCE.md)，源码I2S依据与到货检查另见CORES3_I2S_ANALYSIS.md/CORES3_CHECKLIST.md。没有修改host/SDK/ESP-IDF/native C/原lock，也没有声称真机闭环已经验收。


## Phase 4.8 开发记录（2026-10-19）

新增纯JS DeviceIdentity（显式本地provision、仅RAM、有效期/拒绝/轮换、私有凭证字段）、TrustedTime（可读/同步/认证证据分离）与DeviceBootstrap。启动检查只取配置，不自动录音/上传/播放，不因服务端feature标记开放双工；缺乏认证时间验证器时始终TIME_UNVERIFIED。time-runtime复用真实sntp/Time/Timer，SNTP仅同步，限时/取消/关闭；无声称NVS已加密。

服务端DeviceAuth新增credentials过期/notBefore/hash、原子轮换、活动Session撤销与到期释放；requireNonce严格模式有30秒时间窗口及有界60秒去重，旧tokens/tokenHashes格式明确保留兼容。nonce不能替代TLS或抵御已泄露Token持有者。新增音频无关device.config.get/device.config控制消息，在鉴权后、Provider创建前返回原DeviceConfig白名单；不改音频帧/采样率/RealtimeSession。Node runtime使用随机nonce，ESP32依赖受控provisioner注入nonce源，不能把旧rng默认伪随机源说成已验证安全随机。

影响文件：app/device-identity.js、trusted-time.js、device-bootstrap.js；hardware/time-runtime.js；ai/device-channel.js、realtime-runtime.js；server/auth.js、server.js、device-session.js、node-runtime.js；manifest及相应新测试。凭证/通道红绿日志保留于本轮results；最终回归/编译结果见PHASE48_ACCEPTANCE.md。host/SDK/native不修改，TIME_UNVERIFIED/AUDIO_DUPLEX_UNVERIFIED保留。

Phase4.8入口增量：mod.js导出configureDevice供受控本地adapter显式注入RAM凭证/自有WSS地址/nonce源；不是已实现的配对网页或串口命令，不接受Server下发此调用。Drawer新增Setup CHECK/STOP，检查可能发送SNTP与鉴权WSS配置请求，但不session.start、不创建Provider、不录音播放；默认缺认证时间验证器/未配对，继续安全拒绝。identity轮换/拒绝立即停旧Voice，退出依次释放Bootstrap/Voice/Identity/Time。只读诊断新增白名单security段，不输出secret、不解除物理八项UNVERIFIED。

Phase4.8静态预检脚本：`node --import ./mods/my_companion/simulator/register.js mods/my_companion/simulator/device-preflight.js`只打印Linux静态诊断，不打开音频/Provider；`--scan`显式调用已有npm run scan（15秒上限，只识别设备），`--require-hardware`因无实体证据退出2；拒绝未知录音参数。无新增npm scripts/依赖，根package/lock原修改保持。

Phase4.8凭证失效回归补充：RealtimeSession仅在既有fatal白名单加入CREDENTIAL_EXPIRED/NONCE_UNAVAILABLE，拒绝在失效凭证上继续建连计时；没有更改状态设计/音频协议。服务端轮换清除已移除设备的连接限流记录。行为测试先复现RECONNECTING后修正为ERROR/零计时器，结果留存。

严格Server模式补充：requireNonce:true只接受带expiresAt的credentials（可存tokenHash），拒绝无期限legacy secrets；离线真实socket Bootstrap覆盖未创建Provider即取得配置。time阶段超时/退出同时关闭SNTP任务。CORES3_I2S_ANALYSIS.md补齐板型共享native owner提案、MOD-only缺口、官方影响/回滚/实机步骤；无底层修改。CODEBASE/REALTIME_PROTOCOL/APIYI/CORES3_CHECKLIST同步；设备物理八项继续UNVERIFIED。

Bootstrap缓存回归：显式再次CHECK前重新确认时间与凭证有效期，过期结果不复用为configurationReady；DeviceIdentity.assertUsable只检查状态不生成/消耗nonce。新增过期缓存红绿用例，无额外自动重试/网络调用。


### 2026-10-19 — Phase4.8 安全接入与双工预适配

- 摘要：新增显式RAM设备身份/过期轮换、strict nonce鉴权、无音频Bootstrap与WSS配置探测，普通SNTP与认证时间分层；保留安全门。
- 影响文件：app/device-identity.js、trusted-time.js、device-bootstrap.js；hardware/time-runtime.js、diagnostics.js；ai/device-channel.js、realtime-runtime.js、realtime-session.js（仅两个fatal码）；mod.js/config.js/manifest.json；server/auth.js/server.js/device-session.js/node-runtime.js；新行为测试与simulator/device-preflight.js。
- 影响：原HTTP/Companion/Provider核心/设备16k-24k协议保持；仅新增setup控制消息与严格鉴权选项。没有安全持久化、真实配对通道、认证时间验证器或新共享native I2S实现；这些限制不以测试替身替代。
- 验证：初始npm test582通过；最终数量、MOD产物/哈希、失败工具原记录、有限真实API与保护检查详见[PHASE48_ACCEPTANCE.md](PHASE48_ACCEPTANCE.md)。本轮付费请求仅Qwen Flash，两轮文本及两轮音频；原始失败未覆盖。

Phase4.8最终验证：基线582，最终npm test618（404 unit+149 simulator+65 server）、Realtime75、Server65均0失败；Biome/lint/format/diff通过，独立只读审查33/33通过且无Critical/Important。MOD111954B，SHA256与完整证据见PHASE48_ACCEPTANCE.md。1063原文件保护核对仅16授权已有文件变化，host/package/lock和5 SDK/IDF文件未改；Git可见1449文件及xsa密钥扫描无命中。真实API易4响应（2文本/2音频）均有完成/usage证据，但验收工具5尝试含2失败，原始记录保留；不称工具全通过，不报告真机延迟/成本/双工通过。
