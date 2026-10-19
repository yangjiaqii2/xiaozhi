export const realtimeDefaults = Object.freeze({
  enabled: false,
  url: '',
  deviceId: '',
  personaId: '',
  voiceId: '',
  userId: '',
  connectionTimeoutMs: 5000,
  responseTimeoutMs: 15000,
  playbackTimeoutMs: 2000,
  heartbeatMs: 10000,
  heartbeatTimeoutMs: 30000,
  maxControlBytes: 2048,
  maxInputChunkBytes: 1280,
  maxOutputChunkBytes: 1920,
  maxPendingSendBytes: 4096,
  jitterMs: 20,
  buffer: Object.freeze({ maxBytes: 7680, maxChunks: 8 }),
  reconnect: Object.freeze({ initialDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 8 }),
})

export function realtimeOptions(options = {}) {
  const result = {
    ...realtimeDefaults,
    ...options,
    buffer: { ...realtimeDefaults.buffer, ...options.buffer },
    reconnect: { ...realtimeDefaults.reconnect, ...options.reconnect },
  }
  for (const key of [
    'connectionTimeoutMs',
    'responseTimeoutMs',
    'playbackTimeoutMs',
    'heartbeatMs',
    'heartbeatTimeoutMs',
    'maxControlBytes',
    'maxInputChunkBytes',
    'maxOutputChunkBytes',
    'maxPendingSendBytes',
  ]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 600000)
      throw new Error('INVALID_REALTIME_CONFIG')
  }
  if (
    result.maxControlBytes > 4096 ||
    result.maxInputChunkBytes > 4096 ||
    result.maxOutputChunkBytes > 4096 ||
    !Number.isInteger(result.jitterMs) ||
    result.jitterMs < 0 ||
    result.jitterMs > 100 ||
    result.heartbeatTimeoutMs <= result.heartbeatMs
  )
    throw new Error('INVALID_REALTIME_CONFIG')
  for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts']) {
    if (!Number.isInteger(result.reconnect[key]) || result.reconnect[key] < 1)
      throw new Error('INVALID_REALTIME_CONFIG')
  }
  if (
    result.reconnect.maxAttempts > 32 ||
    result.reconnect.maxDelayMs > 600000 ||
    result.reconnect.initialDelayMs > result.reconnect.maxDelayMs
  )
    throw new Error('INVALID_REALTIME_CONFIG')
  return result
}
