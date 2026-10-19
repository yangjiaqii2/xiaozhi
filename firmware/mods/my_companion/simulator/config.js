import production from '../config.js'

export const scenarios = Object.freeze([
  '200',
  '400',
  '401',
  '404',
  '429',
  '500',
  '503',
  'timeout',
  'invalid-json',
  'large-response',
  'invalid-protocol',
  'wrong-request-id',
  'unknown-emotion',
  'unknown-action',
])

export function simulatorConfig(options = {}) {
  const mockServer = {
    port: options.port ?? 8787,
    latencyMs: options.latencyMs ?? 500,
    scenario: options.scenario ?? '200',
  }
  for (const [value, maximum] of [
    [mockServer.port, 65535],
    [mockServer.latencyMs, 60000],
  ]) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error('INVALID_SIMULATOR_CONFIG')
  }
  if (!scenarios.includes(mockServer.scenario)) throw new Error('INVALID_SCENARIO')
  return {
    ...production,
    server: {
      ...production.server,
      deviceId: 'robot-001',
      baseUrl: '',
      token: '',
      timeoutMs: options.timeoutMs ?? 1500,
      retry: { enabled: true, maxAttempts: 2, initialDelayMs: 100, maxDelayMs: 200 },
    },
    persona: { ...production.persona, name: '小七' },
    network: {
      enabled: true,
      pollMs: 10,
      connectionTimeoutMs: 500,
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 200 },
    },
    debug: { enabled: options.debug ?? true },
    conversation: {
      deviceId: 'robot-001',
      path: '/api/chat',
      idempotentServer: true,
      retry: { enabled: true, maxAttempts: 2, delayMs: options.retryDelayMs ?? 100 },
    },
    speakingMs: options.speakingMs ?? 250,
    mockServer,
  }
}

export function environmentOptions(env = process.env) {
  return {
    port: env.MOCK_PORT === undefined ? 8787 : Number(env.MOCK_PORT),
    latencyMs: env.MOCK_LATENCY_MS === undefined ? 500 : Number(env.MOCK_LATENCY_MS),
    scenario: env.MOCK_SCENARIO ?? '200',
    realtimeServer: {
      firstAudioDelayMs: Number(env.MOCK_FIRST_AUDIO_DELAY_MS ?? 500),
      scenario: env.MOCK_REALTIME_SCENARIO ?? 'normal',
    },
  }
}
