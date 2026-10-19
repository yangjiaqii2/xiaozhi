import { randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { timer } from '../simulator/runtime.js'

// Device→own server transport. It never knows a Provider key or vendor URL.
export function createDeviceRuntime(credentials) {
  return {
    timer,
    now: () => performance.now(),
    elapsed: (a, b) => b - a,
    id: () => randomUUID(),
    connect(href, events, limits) {
      const url = new URL(href)
      if (
        !(url.protocol === 'wss:' || (url.protocol === 'ws:' && url.hostname === '127.0.0.1')) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Object.assign(new Error('INSECURE_TRANSPORT'), { code: 'INSECURE_TRANSPORT' })
      const identity = credentials()
      const socket = new WebSocket(url, {
        headers: {
          'X-Device-Id': identity.deviceId,
          Authorization: `Bearer ${identity.token}`,
          'X-Device-Nonce': identity.nonce ?? randomBytes(16).toString('hex'),
          'X-Device-Issued-At': String(identity.issuedAt ?? Date.now()),
        },
        rejectUnauthorized: true,
        followRedirects: false,
        handshakeTimeout: limits.connectionTimeoutMs,
        maxPayload: Math.max(limits.maxControlBytes, limits.maxOutputChunkBytes + 16),
        perMessageDeflate: false,
        maxFragments: 16,
      })
      let closed = false
      const open = () => {
        if (!closed) events.open()
      }
      const message = (data, binary) => {
        if (closed) return
        const max = binary ? limits.maxOutputChunkBytes + 16 : limits.maxControlBytes
        if (data.length > max) {
          events.error('MESSAGE_TOO_LARGE')
          return
        }
        events.message(
          binary ? data.buffer.slice(data.byteOffset, data.byteOffset + data.length) : data.toString('utf8'),
        )
      }
      const error = () => {
        if (!closed) events.error('NETWORK_ERROR')
      }
      const close = () => {
        if (!closed) events.close()
      }
      socket.on('open', open)
      socket.on('message', message)
      socket.on('error', error)
      socket.on('close', close)
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        if (!closed) events.error(response.statusCode === 401 ? 'DEVICE_UNAUTHORIZED' : 'SERVER_UNAVAILABLE')
      })
      return {
        send(data) {
          if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('NOT_CONNECTED')
          const length = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
          if (length + socket.bufferedAmount > limits.maxPendingSendBytes) throw new Error('SEND_BACKPRESSURE')
          socket.send(data)
        },
        close() {
          if (closed) return
          closed = true
          socket.off('open', open)
          socket.off('message', message)
          socket.off('close', close)
          socket.terminate()
        },
      }
    },
  }
}
