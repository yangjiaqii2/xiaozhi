# CoreS3到货验收清单（Phase4.8）

当前设备未到货，下表所有实体操作实际结果均NOT_TESTED。不要填Linux/Mock结果。发现FAIL保留日志，停止相应有风险步骤，其他只读检查仍可执行。

第一条命令（只扫描，不刷写）：

```bash
cd /home/yang/code/myapp/xiaozhi/stack-chan/firmware
source /home/yang/.local/share/xs-dev-export.sh
npm run scan
```

本轮执行提示No available devices found，即使退出0也不算发现设备。确认实体host兼容后才执行MOD刷写，不运行host deploy/debug重刷底层。

**执行门槛**：当前只有只读Drawer、显式门控的Voice START/STOP/interrupt，没有绕过门控的单向音频“假测试按钮”。B/C阶段需要在现有adapter边界接入已证明独占的受控诊断harness；当前host没有公开全局audio lease，不能仅把readiness三个布尔值设true就称为已完成验证。A05/A06/B/C阻塞时，在CORES3_I2S_ANALYSIS.md所列范围做证据和用户决策，D/E不得盲目继续。此清单列出实际操作与标准，未实现的安全前置步骤不会被伪装成可直接运行的按钮。

为每次实体运行创建新的日志目录，例如docs/results/cores3-YYYYMMDDTHHMMSS（不含凭证/PCM原始隐私）。用既有设备串口/xsbug日志通道保存trace；Server日志单独保存，不直接相减不同机器时间戳。下表日志名是到货后应保存的位置，本轮并不存在。

## A 基础连接

| 编号 | 操作步骤 | 预期结果 | 通过标准 | 实际结果 | 日志位置 | 需要实体设备 |
|---|---|---|---|---|---|---|
| A01 | USB接入后执行npm run scan | 识别实际串口设备 | 有唯一目标；无设备提示不算硬件成功 | NOT_TESTED | `cores3-run/A01.log` | 是 |
| A02 | 确认兼容host已装好后执行npm run mod -- mods/my_companion/manifest.json，再启动设备 | MOD加载成功 | MOD入口诊断mod.loaded=PASS；预期板型不等于探测板型 | NOT_TESTED | `cores3-run/A02.log` | 是 |
| A03 | 手动打开Drawer Companion: diagnostics (read only) | 逐项输出状态/证据/时间/原因/下一步 | 无录音/播放/上传任务，离线项明确UNKNOWN或UNVERIFIED | NOT_TESTED | `cores3-run/A03.log` | 是 |
| A04 | 在原host设置配置AP；观察网络状态并打开诊断 | 真实AP连接 | 实际获得网络且Controller CONNECTED；不以Linux联网替代 | NOT_TESTED | `cores3-run/A04.log` | 是 |
| A05 | 验证时间来源，断电后重新获取，测试错误日期拒绝 | 有可信时间证据 | 认证来源/可核对证据齐全；仅SNTP或日期阈值不能通过 | NOT_TESTED | `cores3-run/A05.log` | 是 |
| A06 | 用自有Server CA链测试有效/过期/域名错误证书 | 有效证书连接，错误证书拒绝 | verify=true，错误时间/证书不降级；记录具体失败阶段 | NOT_TESTED | `cores3-run/A06.log` | 是 |
| A07 | 通过受支持凭证回调提供设备token；再试错误token | 正确设备鉴权，错误token401 | 错误请求无Provider连接；凭证不进入日志/固件源码 | NOT_TESTED | `cores3-run/A07.log` | 是 |
| A08 | 默认配置手动点击Voice START | 安全拒绝且不初始化音频 | REALTIME_DISABLED；即便enabled也不能跳过时间/双工/所有权门控 | NOT_TESTED | `cores3-run/A08.log` | 是 |

## B 单向音频

| 编号 | 操作步骤 | 预期结果 | 通过标准 | 实际结果 | 日志位置 | 需要实体设备 |
|---|---|---|---|---|---|---|
| B01 | 先完成音频独占证明；以用户触发的受控adapter检查启动Mic，2秒后stop/dispose | 仅本地计数，输入16k mono S16LE | 无网络上传/整句缓存；实测格式和持续callback，结束释放 | NOT_TESTED | `cores3-run/B01.log` | 是 |
| B02 | 对Mic连续输入、静音及大小不同回调检查有界分片 | 每片<=1280B，持续处理 | 记录实际回调间隔/字节数/丢片；不假定硬件20ms | NOT_TESTED | `cores3-run/B02.log` | 是 |
| B03 | 释放Mic后，用户触发受控AudioOutput检查短24k mono S16LE音频 | 短声音可测且无Mic上传 | 外部录音验证输出/失真，callback仅代表函数阶段 | NOT_TESTED | `cores3-run/B03.log` | 是 |
| B04 | 播放中stop，再调用stop/dispose | 立即使旧callback失效并释放 | JS pending/timer/buffer清空，native/声学停止单独测量 | NOT_TESTED | `cores3-run/B04.log` | 是 |
| B05 | 在受控测试台复现初始化失败 | 失败安全清理 | 无第二个所有者/后台任务；native失败内部资源必须现场确认 | NOT_TESTED | `cores3-run/B05.log` | 是 |

## C 实时双工

| 编号 | 操作步骤 | 预期结果 | 通过标准 | 实际结果 | 日志位置 | 需要实体设备 |
|---|---|---|---|---|---|---|
| C01 | 外部逻辑分析仪记录RX单开时BCK/LR/MCLK | 与预期16k输入配置一致 | 实际波形/采样与codec状态记录，不用manifest替代 | NOT_TESTED | `cores3-run/C01.log` | 是 |
| C02 | 依次RX→TX和TX→RX启动，分别测共享时钟与实际采样 | 两方向均保持正确格式与持续流 | 无GPIO冲突/采集变速/输出错频；有证据才可评估解除双工门控 | NOT_TESTED | `cores3-run/C02.log` | 是 |
| C03 | 两方向同时持续30秒，关联SDK日志与有界队列 | 同步可用且没有任务饿死 | 无native错误/失真/溢出；峰值、堆占用、丢片均记录 | NOT_TESTED | `cores3-run/C03.log` | 是 |
| C04 | 暂停下游消费后恢复，再断开 | 临时背压可恢复；持续不可消费明确取消 | 不扩容、不静默丢当前有效PCM；资源与SID隔离 | NOT_TESTED | `cores3-run/C04.log` | 是 |
| C05 | 测扬声器→Mic回声，静音/键盘/风扇与真人插话 | 区分能量提示的误触发风险 | 无真实AEC证据则不默认开启PCM提示；不得调高门限掩盖 | NOT_TESTED | `cores3-run/C05.log` | 是 |

## D 真实实时对话

| 编号 | 操作步骤 | 预期结果 | 通过标准 | 实际结果 | 日志位置 | 需要实体设备 |
|---|---|---|---|---|---|---|
| D01 | 前述安全门证据完整且适配器接入后，手动Voice START（mic+upload+playback） | 持续分片上传并逐片播放 | 不等整句/response.done；凭证仍仅在自有Server侧管理 | NOT_TESTED | `cores3-run/D01.log` | 是 |
| D02 | 正常一句话后保持安静，外部录音同步客户端/Server账本 | 记录真实声学首声音 | 同机时钟才相减，跨机器不可观测时刻null；无外部测量不通过 | NOT_TESTED | `cores3-run/D02.log` | 是 |
| D03 | 机器人播放时真人插话 | 本地stop不依赖云ACK | stop函数与声学停止分别记录，旧轮音频0泄漏 | NOT_TESTED | `cores3-run/D03.log` | 是 |
| D04 | 取消后立即新一句，至少3轮并保留1次长回复 | 新轮可用且长回复完整消费 | turn/sequence/SID不混合，最终播放与生成结束分别记录 | NOT_TESTED | `cores3-run/D04.log` | 是 |
| D05 | 重复START/STOP/关闭Companion 10次 | 单连接、资源可释放 | 计时器/监听器/音频任务/heap不持续累积 | NOT_TESTED | `cores3-run/D05.log` | 是 |

## E 异常恢复

| 编号 | 操作步骤 | 预期结果 | 通过标准 | 实际结果 | 日志位置 | 需要实体设备 |
|---|---|---|---|---|---|---|
| E01 | 真实AP断开再恢复 | 错误明确并有限重连 | 新SID重配音色/VAD/格式，旧音频不进入新会话 | NOT_TESTED | `cores3-run/E01.log` | 是 |
| E02 | Server主动断开Provider WSS | 有限恢复或达到上限退出 | 不无限重试；每次首次失败与重试均保留 | NOT_TESTED | `cores3-run/E02.log` | 是 |
| E03 | 故障注入连接/首包/输出停滞 | 分类超时，释放资源 | 不常驻THINKING/SPEAKING；不降低TLS校验 | NOT_TESTED | `cores3-run/E03.log` | 是 |
| E04 | 连续取消与结束事件交错，注入旧Session迟到包 | 旧包和旧callback丢弃 | 新turn不被迟到cancel误伤，旧音频泄漏0 | NOT_TESTED | `cores3-run/E04.log` | 是 |
| E05 | 停止后重启设备，再手动启动 | 重新证明时间/凭证与连接 | 未证实时不沿用上次“已验证”标记，默认无后台录音 | NOT_TESTED | `cores3-run/E05.log` | 是 |
| E06 | 保存各模型usage与可核对账单 | 区分token与实际费用 | 缺失usage/null，未对账成本NOT_TESTED，不按usage编造扣款 | NOT_TESTED | `cores3-run/E06.log` | 是 |

八项最终物理验收状态分别填CoreS3麦克风、扬声器、I2S全双工、真实WiFi、TLS/CA、可信时间、真实声学首音频、真实声学停止；未测一律UNVERIFIED，不能批量以BUILD SUCCESS改成PASS。日志、外部录音/仪器测量与requestId/sessionId/turnId应能互相核对。


## Phase4.8 六阶段门槛（优先按此执行）

| 阶段 | 前置条件 | 明确操作/复用编号 | 通过证据 | 失败停止条件 | 实际/日志 |
|---|---|---|---|---|---|
| 1 识别连接 | USB与供电安全，无音频任务 | 执行npm run scan；对应A01 | 识别唯一目标而非仅exit0 | 无设备/目标不符，停止刷写 | NOT_TESTED；cores3-run/stage1.log |
| 2 固件/MOD/网络/安全 | 兼容host已安装，设备凭证经受控本地配对 | A02～A08；只读Drawer；手动Setup CHECK/STOP | 明确Wi-Fi/认证时间证据/CA域名验证/鉴权，Bootstrap阶段可追踪 | 时间/CA/凭证任何未通过，禁止Voice START；普通SNTP不算可信 | NOT_TESTED；stage2.log |
| 3 单向音频 | 第2阶段安全检查，真实host音频独占证明，受控harness | B01～B05；用户分别触发Mic与扬声器，不同时开 | 格式、首片、持续性、退出释放；录音先明确告知，默认不上传 | 无所有权、初始化/native错误、格式不符，停止音频 | NOT_TESTED；stage3.log |
| 4 I2S双工 | 单向通过、codec/WS/BCK/MCLK方案评审和保护性harness | C01～C05；两种初始化顺序、逻辑分析仪 | 两方向实际速率/无失真/有界队列及回声风险记录 | 任一时钟/槽位/资源不兼容，不盲目开放完整双工 | NOT_TESTED；stage4.log |
| 5 真实Realtime | 前4阶段及真实Server WSS/鉴权通过，才评估门控证据 | D01～D02，用户明确Voice START会mic+upload+playback | 首片即时流式、同轮关联，外部声学测量 | 无首片/背压不恢复/TLS失败立即STOP，不降级 | NOT_TESTED；stage5.log |
| 6 稳定性恢复 | 第5阶段通过，有限真实请求预算 | D03～D05、E01～E06 | 打断/新轮/长回复/断网重配/重启/零旧音频与释放 | 保留首次失败及重试日志，达到上限停止 | NOT_TESTED；stage6.log |

上述所有阶段都需要真实设备。现有详细A～E表仍逐项填写actual/log；不存在无需前置证明就直接开启双工的“一键通过”。

### 可直接执行的Linux静态预检（不等于真机验收）

```bash
node --import ./mods/my_companion/simulator/register.js mods/my_companion/simulator/device-preflight.js
# 显式扫描USB，需先source已有SDK环境；无录音/播放/上传
node --import ./mods/my_companion/simulator/register.js mods/my_companion/simulator/device-preflight.js --scan
```

无实体证据时输出UNVERIFIED，正常报告exit0不是硬件通过；可加--require-hardware使这种状态exit2。未知参数拒绝，不支持偷偷录音选项。不新增/虚构npm脚本。真正设备运行日志来自Drawer只读诊断，静态脚本不会远程读取实体状态。

### 凭证与时间补充验收

| 编号 | 操作 | 通过标准 | 实际/日志 | 设备 |
|---|---|---|---|---|
| S01 | 本地受控provisioner显式调用configureDevice注入RAM设备凭证及nonce源 | 无源码/manifest/固件常量Key；未确认拒绝；断电后不伪称持久保存 | NOT_TESTED；S01.log | 是 |
| S02 | strict Server记录分别测试缺失/错误/过期/ID不匹配/旧token | 401或固定鉴权错误，无Provider创建；已连接凭证过期主动关闭 | NOT_TESTED；S02.log | 是 |
| S03 | 旋转后重连、重复nonce、错误时间、重复连接 | 旧token/重放拒绝；新nonce与新凭证可配置，旧Session释放 | NOT_TESTED；S03.log | 是 |
| S04 | 手动Setup CHECK观察普通SNTP成功/超时/断网，再STOP | 只同步不trusted，TIME_UNVERIFIED；无遗留计时器/语音任务 | NOT_TESTED；S04.log | 是 |
| S05 | 接入真实验证器后提供有效/过期/伪造时间证据；错误CA/主机名 | 新鲜认证证据才放行；证书错误拒绝、无WS降级 | NOT_TESTED；S05.log | 是 |
| S06 | 中途STOP、断网、换凭证、重复CHECK | 单连接/无后台音频；晚回调不能恢复旧配置/任务 | NOT_TESTED；S06.log | 是 |

当前受控provisioner实体通道、认证时间验证器、可靠设备nonce源、加密持久化、全局audio lease、I2S共享owner/现场证据仍待接入。configureDevice是本地适配边界，不是声称设备已具备配对UI/安全串口协议。任何人不应把readiness/duplexValidated/timeTrusted直接改true代替验证。
