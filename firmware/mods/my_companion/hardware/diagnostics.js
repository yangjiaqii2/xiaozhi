import Time from 'time'

const observe = (read, fallback = null) => {
  try {
    return read() ?? fallback
  } catch {
    return fallback
  }
}
const count = (value, max = 1e12) => (Number.isFinite(value) && value >= 0 && value <= max ? value : null)

// Read-only: never create AudioIn/AudioOut, acquire I2S, record or play audio.
// Build metadata describes the expected target, not detected physical hardware.
export function diagnosticSnapshot({
  robot,
  companion,
  realtime,
  transport,
  voice,
  identity,
  time,
  bootstrap,
  modLoaded,
  clock = { now: () => Time.ticks },
} = {}) {
  let recording = null
  try {
    const value = robot?.audio?.microphone?.recording
    if (typeof value === 'boolean') recording = value
  } catch {}
  const metrics = {}
  for (const key of [
    'timeToFirstAudio',
    'audioChunksReceived',
    'audioBytesReceived',
    'interruptionCount',
    'reconnectCount',
  ]) {
    const value = realtime?.metrics?.[key]
    metrics[key] = typeof value === 'number' && value >= 0 && value <= 1e12 ? value : null
  }
  const allowed = ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'ERROR']
  const status = observe(() => companion?.wifi?.getStatus?.())
  const timing = realtime?.lastInterruption
  const elapsed = (start, end) => {
    if (typeof start !== 'number' || typeof end !== 'number') return null
    try {
      const value = realtime.runtime.elapsed(start, end)
      return Number.isFinite(value) && value >= 0 && value <= 600000 ? value : null
    } catch {
      return null
    }
  }
  const phases = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'INTERRUPTED']
  const error = realtime?.lastError ?? voice?.lastError
  const snapshot = {
    build: { firmwareSourceVersion: '1.1.0', expectedBoard: 'm5stackchan_cores3', detectedBoard: 'UNKNOWN' },
    wifi: allowed.includes(status) ? status : 'UNKNOWN',
    clock: 'TIME_UNVERIFIED',
    tlsCA: 'UNVERIFIED',
    microphone: { recording, initialization: recording === true ? 'ACTIVE' : 'UNKNOWN' },
    speaker: { initialization: 'UNKNOWN' },
    input: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' },
    output: { sampleRate: 24000, channels: 1, encoding: 'pcm_s16le' },
    i2s: { inputController: 1, outputController: 1, sharedBCK: 34, sharedLR: 33, status: 'AUDIO_DUPLEX_UNVERIFIED' },
    realtime: [...allowed, 'STOPPED'].includes(realtime?.status) ? realtime.status : 'UNKNOWN',
    phase: phases.includes(realtime?.phase) ? realtime.phase : 'UNKNOWN',
    interruptionLatency: {
      interruptCallToStopMs: elapsed(timing?.interruptInvokedAt, timing?.stopInvokedAt),
      stopCallDurationMs: elapsed(timing?.stopInvokedAt, timing?.stopReturnedAt),
      interruptCallToBufferClearMs: elapsed(timing?.interruptInvokedAt, timing?.bufferClearedAt),
      inputResumeMs: elapsed(timing?.interruptInvokedAt, timing?.inputResumedAt),
      acousticStop: 'UNVERIFIED',
    },
    hardwareValidation: {
      playbackInterruption: 'UNVERIFIED',
      longReply: 'UNVERIFIED',
      continuousTurns: 'UNVERIFIED',
      networkRecovery: 'UNVERIFIED',
      restartReconnect: 'UNVERIFIED',
    },
    lastError: [
      'TIME_UNVERIFIED',
      'AUDIO_DUPLEX_UNVERIFIED',
      'AUDIO_OWNERSHIP_UNVERIFIED',
      'VOICE_START_FAILED',
      'VOICE_RELEASE_FAILED',
      'EXPLICIT_START_REQUIRED',
      'READINESS_UNKNOWN',
      'NETWORK_DISCONNECTED',
      'CONNECTION_TIMEOUT',
      'RESPONSE_TIMEOUT',
      'PLAYBACK_TIMEOUT',
      'AUDIO_INPUT_ERROR',
      'AUDIO_OUTPUT_ERROR',
      'BUFFER_OVERFLOW',
      'SEND_BACKPRESSURE',
      'TLS_OR_WEBSOCKET_ERROR',
      'DEVICE_UNAUTHORIZED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_TIMEOUT',
      'RATE_LIMIT',
      'SOCKET_CLOSED',
      'INVALID_MESSAGE',
      'UNSUPPORTED_AUDIO_FORMAT',
      'INSECURE_TRANSPORT',
      'REALTIME_DISABLED',
    ].includes(error)
      ? error
      : null,
    metrics,
    acousticLatency: 'UNVERIFIED',
  }
  const ticks = count(observe(() => clock.now()))
  const checkedAt = { clock: 'local_monotonic', ticks }
  const input = observe(() => realtime?.input?.getDiagnostics?.() ?? realtime?.input?.input?.getDiagnostics?.())
  const output = observe(() => realtime?.output?.getDiagnostics?.())
  const wire = observe(() => transport?.getDiagnostics?.())
  snapshot.queues = {
    inputBytes: null, // SDK native ring fill is not exposed to JS.
    pendingSendBytes: null, // writable credit is not native/TCP queue occupancy.
    outputBytes: count(realtime?.buffer?.bytes, 65536),
    outputChunks: count(realtime?.buffer?.length, 64),
    outputCapacityBytes: count(realtime?.buffer?.maxBytes, 65536),
    outputBacklogMs: count(realtime?.buffer?.bytes, 65536) === null ? null : realtime.buffer.bytes / 48,
    nativeOutputPendingBytes: count(output?.pendingBytes, 4096),
  }
  const turnId = (id) => (Number.isInteger(id) && id >= 1 && id <= 0xffffffff ? id : null)
  const opaqueId = (id) => (typeof id === 'string' && /^(?:rt-\d+-\d+|[a-f0-9-]{16,64})$/i.test(id) ? id : null)
  snapshot.turns = {
    sessionId: opaqueId(realtime?.sessionId),
    requestId: opaqueId(realtime?.requestId),
    phase: snapshot.phase,
    input: turnId(realtime?.inputTurn?.id),
    response: turnId(realtime?.responseTurn?.id),
    playbackEpoch: count(realtime?.playEpoch),
    interruptedTurn: turnId(timing?.turnId),
  }
  snapshot.resources = {
    sessionTimers: count(realtime?.timers?.size ?? voice?.lastRelease?.sessionTimers, 32),
    lastStoppedBufferBytes: count(voice?.lastRelease?.bufferBytes, 65536),
    inputActive: typeof input?.active === 'boolean' ? input.active : null,
    outputPending: typeof output?.pending === 'boolean' ? output.pending : null,
    socketOwned:
      typeof wire?.socketOwned === 'boolean'
        ? wire.socketOwned
        : typeof voice?.lastRelease?.socketOwned === 'boolean'
          ? voice.lastRelease.socketOwned
          : null,
    nativeRelease: 'UNVERIFIED',
  }
  snapshot.transport = wire
    ? {
        state: ['NOT_TESTED', 'CONNECTING', 'CONNECTED', 'CLOSED', 'FAIL'].includes(wire.state)
          ? wire.state
          : 'UNKNOWN',
        verificationRequired: wire.verificationRequired === true,
        explicitCAConfigured: wire.explicitCAConfigured === true,
        handshakeObserved: wire.handshakeObserved === true,
        builtInCAStore: 'UNKNOWN',
      }
    : null
  const checks = []
  const add = (id, item, status, evidence, reason, nextStep, value = null) => {
    checks.push({ id, item, status, evidence, checkedAt, reason, nextStep, value })
  }
  add(
    'build.target',
    '构建版本及目标',
    'PASS',
    'MOD build metadata',
    '仅说明编译目标，不探测实体板',
    '与设备启动日志核对',
    snapshot.build,
  )
  add(
    'mod.loaded',
    'MOD入口已执行',
    modLoaded === true ? 'PASS' : 'UNKNOWN',
    'onContextCreated observation',
    modLoaded === true ? '当前入口已执行' : '未收到入口执行证据',
    '设备启动后手动打开Drawer诊断',
  )
  const state = observe(() => companion?.state?.current)
  const states = [
    'IDLE',
    'LISTENING',
    'THINKING',
    'SPEAKING',
    'HAPPY',
    'SAD',
    'ANGRY',
    'CARING',
    'EXCITED',
    'SURPRISED',
  ]
  add(
    'companion.state',
    'Companion状态',
    states.includes(state) ? 'PASS' : 'UNKNOWN',
    'CompanionState.current',
    '运行时字段观察，不代表音频功能验证',
    '核对实际状态日志',
    states.includes(state) ? state : null,
  )
  add(
    'wifi.controller',
    '网络控制器状态',
    snapshot.wifi === 'UNKNOWN'
      ? 'UNKNOWN'
      : snapshot.wifi === 'ERROR'
        ? 'FAIL'
        : snapshot.wifi === 'CONNECTED'
          ? 'PASS'
          : 'NOT_TESTED',
    'WiFiController.getStatus()',
    '只观察管理状态，不替代实体AP测试',
    '验证AP断开/恢复',
    snapshot.wifi,
  )
  add(
    'wifi.driver',
    '网络驱动来源',
    'UNVERIFIED',
    'hardware/network-runtime.js → network-manager/NetworkService',
    '静态源码存在，不代表当前驱动已运行',
    '在设备检查NetworkService和IP日志',
  )
  add(
    'transport.policy',
    'WSS安全策略',
    wire?.verificationRequired === true ? 'PASS' : 'UNKNOWN',
    'RealtimeRuntime.getDiagnostics()',
    '策略要求不是TLS握手成功证据',
    '保留verify=true与TIME_UNVERIFIED',
    snapshot.transport,
  )
  add(
    'transport.connection',
    'Realtime连接',
    snapshot.realtime === 'CONNECTED' ? 'PASS' : snapshot.realtime === 'ERROR' ? 'FAIL' : 'NOT_TESTED',
    'RealtimeSession.status',
    '仅当前Session状态',
    '在安全门通过后手动启动',
    snapshot.realtime,
  )
  add(
    'audio.input.adapter',
    '输入适配器',
    input?.lastError ? 'FAIL' : input?.chunks > 0 ? 'PASS' : 'NOT_TESTED',
    'AudioInput readable callbacks',
    '仅成功读取片计数，物理质量另验',
    '显式执行单向输入检查',
    { chunks: count(input?.chunks), formatObserved: !!input?.format },
  )
  add(
    'audio.output.adapter',
    '输出适配器',
    output?.lastError ? 'FAIL' : output?.completedChunks > 0 ? 'PASS' : 'NOT_TESTED',
    'AudioOutput completion callbacks',
    '回调不等于声学输出',
    '显式执行单向输出检查',
    { completedChunks: count(output?.completedChunks) },
  )
  add(
    'audio.format',
    '设备协议音频格式',
    'PASS',
    'audio-input/output adapters and REALTIME_PROTOCOL',
    '预期16k输入/24k输出，不假装是硬件实测',
    '对比实际采样与外部测量',
    { input: snapshot.input, output: snapshot.output },
  )
  add(
    'audio.queues',
    '有界队列占用',
    snapshot.queues.outputBytes === null ? 'UNKNOWN' : 'PASS',
    'AudioBuffer.bytes/length and owned output samples',
    'native输入/DMA和TCP积压未公开，保留null',
    '记录峰值与慢消费者日志',
    snapshot.queues,
  )
  add(
    'audio.turns',
    '轮次与打断',
    realtime ? 'PASS' : 'NOT_TESTED',
    'RealtimeSession turns/playEpoch/lastInterruption',
    '只读本地关联，不跨机器相减',
    '测试旧轮迟到包与新轮恢复',
    snapshot.turns,
  )
  add(
    'resources',
    '资源释放观察',
    realtime || voice?.lastRelease ? 'PASS' : 'NOT_TESTED',
    'owned timers/buffer/adapter references',
    '只代表JS引用状态，native资源释放仍待实机验证',
    '停止后确认timer/buffer为0',
    snapshot.resources,
  )
  add(
    'errors',
    '最近错误与重连',
    snapshot.lastError?.endsWith('_UNVERIFIED') ? 'UNVERIFIED' : snapshot.lastError ? 'FAIL' : 'NOT_TESTED',
    'RealtimeSession.lastError/metrics',
    '历史错误不代表当前连接一定失败',
    '结合当前SID与连接状态分析',
    { code: snapshot.lastError, reconnectCount: snapshot.metrics.reconnectCount },
  )
  add(
    'latency.local',
    '本地打断阶段',
    timing ? 'PASS' : 'NOT_TESTED',
    'same-runtime monotonic interruption events',
    '函数时刻不等于声学停止',
    '与外部声学测量关联',
    snapshot.interruptionLatency,
  )
  for (const [id, label, evidence, next] of [
    ['microphone', 'CoreS3麦克风', '实际设备PCM采集尚未执行', '单向采集验证格式、持续性和失真'],
    ['speaker', 'CoreS3扬声器', '实际设备声学输出尚未执行', '单向播放并用外部录音测量'],
    ['duplex', 'I2S全双工', 'I2S1/BCK34/LR33，16k/24k；源码不能证明兼容', '核对时钟、协议槽位与两种初始化顺序'],
    ['wifi', '真实Wi-Fi', '没有实体AP连接证据', '验证实体AP连接及断网恢复'],
    ['tls', 'TLS/CA', 'MOD未获得真实CoreS3证书验证证据', '验证CA、正确/过期证书与错误时间拒绝'],
    ['time', '可信设备时间', 'SNTP/日期阈值不是认证时间证明', '验证可信时间来源，保留TIME_UNVERIFIED'],
    ['acousticFirst', '真实声学首音频', '无实体设备或外部声学测量', '外部录音对齐用户停止与首声'],
    ['acousticStop', '真实声学停止', '无实体设备或外部声学测量', '外部录音对齐打断与实际静音'],
  ])
    add(`hardware.${id}`, label, 'UNVERIFIED', evidence, '本轮无真实设备证据', next)
  add(
    'voice.gates',
    '设备语音启动前置条件',
    'UNVERIFIED',
    'DeviceVoice readiness/default realtime.enabled',
    '可信时间/双工/host独占证据尚未接入，不能用布尔配置假装验证',
    '先完成CoreS3清单A/B/C，不自动录音或上传',
    { enabled: voice?.options?.enabled === true, activityHint: voice ? voice.activity === true : null },
  )
  add('billing', '实际账单成本', 'NOT_TESTED', '无可核对账单', 'usage不等于实际扣款', '对账后独立记录')
  const stage = realtime?.lastAudioTrace
  snapshot.audioStages = null
  if (stage) {
    const events = {}
    for (const key of [
      'inputCapturedAt',
      'inputDeliveredAt',
      'inputSentAt',
      'inputLastSentAt',
      'serverReceivedAt',
      'providerReceivedAt',
      'providerFirstAudioAt',
      'serverSentAt',
      'deviceFirstAudioAt',
      'playbackStartedAt',
      'acousticOutputAt',
      'responseDoneAt',
      'playbackCompletedAt',
    ])
      events[key] = count(stage[key])
    snapshot.audioStages = {
      clockDomain: 'runtime_monotonic',
      requestId: opaqueId(stage.requestId),
      sessionId: opaqueId(stage.sessionId),
      turnId: turnId(stage.turnId),
      ...events,
    }
  }
  add(
    'latency.audio',
    '当前或最近一轮音频阶段',
    stage ? 'PASS' : 'NOT_TESTED',
    'RealtimeSession bounded lastAudioTrace',
    '仅同runtime时间，远端和声学阶段不可观测则null',
    '结合Server日志关联SID/turn，不跨机器相减',
    snapshot.audioStages,
  )
  const credential = observe(() => identity?.getDiagnostics?.())
  const timeStatus = observe(() => time?.getDiagnostics?.())
  const boot = observe(() => bootstrap?.getDiagnostics?.())
  const stages = {}
  for (const name of ['network', 'time', 'credentials', 'wss', 'config', 'audio']) {
    const status = boot?.stages?.[name]
    stages[name] = ['RUNNING', 'PASS', 'FAIL', 'UNVERIFIED'].includes(status) ? status : 'NOT_TESTED'
  }
  snapshot.security = {
    identity: {
      configured: credential?.configured === true,
      blocked: credential?.blocked === true,
      revision: count(credential?.revision),
      storage: 'VOLATILE_RAM',
      encryptedPersistence: 'UNVERIFIED',
    },
    time: {
      readable: timeStatus?.readable === true,
      synchronized: timeStatus?.synchronized === true,
      trusted: timeStatus?.trusted === true,
      pending: timeStatus?.pending === true,
    },
    bootstrap: {
      pending: boot?.pending === true,
      configurationReady: boot?.configurationReady === true,
      channelOwned: boot?.channelOwned === true,
      audioStarted: false,
      stages,
    },
  }
  add(
    'security.credentials',
    '设备凭证状态',
    credential?.blocked ? 'FAIL' : credential?.configured ? 'PASS' : 'NOT_TESTED',
    'DeviceIdentity private credential metadata',
    '仅表示RAM中已provision，不证明加密存储或设备鉴权成功',
    '由受控本地provisioner注入有期限设备凭证；不存厂商Key',
    snapshot.security.identity,
  )
  add(
    'security.time',
    '时间状态分层',
    timeStatus?.trusted === true ? 'PASS' : 'UNVERIFIED',
    'TrustedTime authenticated evidence verifier',
    'SNTP同步不等于认证时间；物理验证状态另列',
    '接入受信验证器与新鲜证据，否则保留TIME_UNVERIFIED',
    snapshot.security.time,
  )
  add(
    'security.bootstrap',
    '无音频初始化检查',
    boot?.configurationReady ? 'PASS' : 'NOT_TESTED',
    'DeviceBootstrap bounded stages',
    '配置成功不开放全双工，不自动录音上传',
    '手动执行Bootstrap检查；失败先解决对应前置条件',
    snapshot.security.bootstrap,
  )
  snapshot.checks = checks
  return snapshot
}
