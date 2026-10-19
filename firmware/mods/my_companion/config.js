import { realtimeDefaults } from 'my-companion/realtime-config'

// Configure the device's Wi-Fi with the host settings UI. Never commit real credentials.
export default {
  realtime: realtimeDefaults,
  server: {
    baseUrl: '',
    deviceId: '',
    token: '',
    testPath: '/api/device/config',
    testProtocol: 'deviceConfig',
    timeoutMs: 10000,
    maxResponseBytes: 32768,
    maxRequestBytes: 8192,
    retry: { enabled: true, maxAttempts: 2, initialDelayMs: 1000, maxDelayMs: 5000 },
    tls: { minUnixTimeMs: 1704067200000 },
  },
  network: {
    enabled: true,
    pollMs: 500,
    connectionTimeoutMs: 15000,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 60000 },
  },
  bootstrap: { timeoutMs: 10000, timeHost: 'pool.ntp.org' },
  device: { name: '' },
  persona: { name: '', personality: [], speakingStyle: '', voiceId: '', initiativeLevel: 0 },
  features: { voiceChat: false, vision: false, emotionAnalysis: false },
  simulation: { holdMs: 5000, tickMs: 100 },
  motion: { enabled: true, yawRadians: 0.08, pitchRadians: 0.06, durationSeconds: 0.5 },
  debug: { enabled: true },
}
