import { fail } from 'my-companion/realtime-protocol'
import Time from 'time'
import Timer from 'timer'
import URL from 'url'

// Bounded ECMA-419 WebSocket adapter. Do not use SDK WebSocket.js, which joins
// incoming fragments without a cap and queues outbound messages without a cap.
export function createRealtimeRuntime({ isTimeTrusted = () => false, ca, deviceCredentials } = {}) {
  let serial = 0
  const diagnostic = {
    state: 'NOT_TESTED',
    verificationRequired: true,
    timeAttested: null,
    explicitCAConfigured: !!ca,
    handshakeObserved: false,
    socketOwned: false,
    lastError: null,
  }
  const reject = (code) => {
    diagnostic.state = 'FAIL'
    diagnostic.lastError = code
    fail(code)
  }
  return {
    timer: Timer,
    now: () => Time.ticks,
    elapsed: (start, end) => Time.delta(start, end),
    id: () => `rt-${Time.ticks}-${++serial}`,
    getDiagnostics: () => ({ ...diagnostic }),
    connect(href, events, limits) {
      diagnostic.state = 'CONNECTING'
      diagnostic.handshakeObserved = false
      let url
      try {
        url = new URL(href)
      } catch {
        reject('INVALID_ENDPOINT')
      }
      if (url.protocol !== 'wss:') reject('INSECURE_TRANSPORT')
      if (url.username || url.password || url.hash || !url.hostname) reject('INVALID_ENDPOINT')
      diagnostic.timeAttested = isTimeTrusted() === true
      if (!diagnostic.timeAttested || Date.now() < 1704067200000) reject('TIME_UNVERIFIED')
      const config = globalThis.device?.network?.wss
      if (!config?.io || !config.socket?.io) reject('WSS_UNAVAILABLE')
      let headers
      if (deviceCredentials) {
        const credentials = deviceCredentials()
        if (
          typeof credentials?.deviceId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(credentials.deviceId) ||
          typeof credentials.token !== 'string' ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(credentials.token)
        )
          reject('DEVICE_UNAUTHORIZED')
        headers = [
          ['X-Device-Id', credentials.deviceId],
          ['Authorization', `Bearer ${credentials.token}`],
        ]
        if (credentials.nonce !== undefined || credentials.issuedAt !== undefined) {
          if (
            typeof credentials.nonce !== 'string' ||
            !/^[A-Za-z0-9_-]{32,128}$/.test(credentials.nonce) ||
            !Number.isSafeInteger(credentials.issuedAt) ||
            credentials.issuedAt < 0
          )
            reject('DEVICE_UNAUTHORIZED')
          headers.push(['X-Device-Nonce', credentials.nonce], ['X-Device-Issued-At', String(credentials.issuedAt)])
        }
      }
      let stopped = false
      let opened = false
      let writable = 0
      let length = 0
      let binary
      let fragment
      let dns
      let socket
      const close = () => {
        if (stopped) return
        stopped = true
        diagnostic.socketOwned = false
        if (diagnostic.state !== 'FAIL') diagnostic.state = 'CLOSED'
        try {
          dns?.close()
        } finally {
          try {
            socket?.close()
          } finally {
            dns = socket = fragment = null
          }
        }
      }
      const error = (code) => {
        diagnostic.state = 'FAIL'
        diagnostic.lastError = code
        close()
        events.error(code)
      }
      // The SDK WebSocket constructor keeps its Resolver private and does not
      // close it during DNS. Retain it here and suppress late DNS callbacks.
      class OwnedResolver {
        constructor(options) {
          dns = new config.dns.io(options)
        }
        resolve(options) {
          dns.resolve({
            ...options,
            onResolved: (...args) => {
              if (!stopped) options.onResolved(...args)
            },
            onError: () => {
              if (!stopped) options.onError()
            },
          })
        }
      }
      try {
        diagnostic.socketOwned = true
        socket = new config.io({
          ...config,
          host: url.hostname,
          port: Number(url.port || 443),
          path: `${url.pathname || '/'}${url.search}`,
          headers,
          dns: { ...config.dns, io: OwnedResolver },
          socket: {
            ...config.socket,
            tls: {
              ...config.socket.tls,
              host: url.hostname,
              verify: true,
              minimumVersion: 'TLSv1.2',
              ...(ca ? { ca } : {}),
            },
          },
          onWritable(count) {
            if (stopped || !count) return
            writable = count
            if (!opened) {
              opened = true
              diagnostic.state = 'CONNECTED'
              diagnostic.handshakeObserved = true
              events.open()
            }
          },
          onReadable(count, options) {
            if (stopped) return
            try {
              const maximum = options.binary ? limits.maxOutputChunkBytes + 16 : limits.maxControlBytes
              if (count > maximum - length || (length && binary !== options.binary)) fail('MESSAGE_TOO_LARGE')
              if (!length) {
                fragment = new Uint8Array(maximum)
                binary = options.binary
              }
              fragment.set(new Uint8Array(this.read(count)), length)
              length += count
              if (options.more) return
              const result = fragment.buffer.slice(0, length)
              fragment = null
              length = 0
              events.message(binary ? result : String.fromArrayBuffer(result))
            } catch {
              error('TRANSPORT_MESSAGE_ERROR')
            }
          },
          onClose() {
            close()
            events.close()
          },
          onError() {
            error('TLS_OR_WEBSOCKET_ERROR')
          },
        })
      } catch (error) {
        diagnostic.state = 'FAIL'
        diagnostic.lastError = 'TLS_OR_WEBSOCKET_ERROR'
        close()
        throw error
      }
      return {
        send(data) {
          if (stopped || !opened) fail('NOT_CONNECTED')
          const binary = data instanceof ArrayBuffer
          const bytes = binary ? data : ArrayBuffer.fromString(data)
          const maximum = binary ? limits.maxInputChunkBytes + 16 : limits.maxControlBytes
          if (bytes.byteLength > maximum || bytes.byteLength > writable) fail('SEND_BACKPRESSURE')
          writable = socket.write(bytes, { binary })
        },
        close,
      }
    },
  }
}
