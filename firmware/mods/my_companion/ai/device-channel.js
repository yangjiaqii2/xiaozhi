// One authenticated, audio-free setup connection. Caller owns bounded timeout/cancel.
export function openDeviceChannel({ runtime, url, limits }) {
  let transport,
    stopped = false,
    opened = false,
    request,
    readyResolve,
    readyReject,
    configResolve,
    configReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Attach a handler immediately so synchronous adapter errors cannot be unhandled.
  ready.catch(() => {})
  const finish = (code) => {
    if (stopped) return
    stopped = true
    const error = new Error(code)
    readyReject(error)
    configReject?.(error)
    const owned = transport
    transport = null
    try {
      owned?.close()
    } catch {}
  }
  const events = {
    open() {
      if (!stopped) {
        opened = true
        readyResolve()
      }
    },
    error(code) {
      finish(
        ['DEVICE_UNAUTHORIZED', 'TLS_OR_WEBSOCKET_ERROR', 'NETWORK_ERROR'].includes(code)
          ? code
          : 'TLS_OR_WEBSOCKET_ERROR',
      )
    },
    close() {
      finish('NETWORK_DISCONNECTED')
    },
    message(text) {
      if (stopped) return
      try {
        if (!request || typeof text !== 'string' || text.length > limits.maxControlBytes) throw new Error()
        const event = JSON.parse(text)
        if (
          event.type !== 'device.config' ||
          event.requestId !== request ||
          !event.config ||
          Array.isArray(event.config)
        )
          throw new Error()
        configResolve(event.config)
        configResolve = configReject = null
      } catch {
        finish('INVALID_PROTOCOL')
      }
    },
  }
  try {
    transport = runtime.connect(url, events, limits)
    if (stopped) {
      transport?.close()
      transport = null
    }
  } catch (error) {
    finish(
      [
        'DEVICE_UNAUTHORIZED',
        'CREDENTIAL_EXPIRED',
        'NONCE_UNAVAILABLE',
        'TIME_UNVERIFIED',
        'INSECURE_TRANSPORT',
        'INVALID_ENDPOINT',
        'WSS_UNAVAILABLE',
      ].includes(error?.code)
        ? error.code
        : 'TLS_OR_WEBSOCKET_ERROR',
    )
  }
  return {
    ready,
    getConfig() {
      if (stopped || !opened || request) return Promise.reject(new Error('CONFIG_UNAVAILABLE'))
      request = runtime.id()
      const pending = new Promise((resolve, reject) => {
        configResolve = resolve
        configReject = reject
      })
      try {
        transport.send(JSON.stringify({ type: 'device.config.get', requestId: request }))
      } catch {
        finish('CONFIG_UNAVAILABLE')
      }
      return pending
    },
    close: () => finish('CANCELLED'),
  }
}
