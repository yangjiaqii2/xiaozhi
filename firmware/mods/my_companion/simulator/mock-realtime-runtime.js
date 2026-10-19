import { fail } from '../ai/realtime-protocol.js'
import { timer } from './runtime.js'

// Actual local TCP/WebSocket transport; production never imports this module.
export function createMockRealtimeRuntime() {
  let serial = 0
  const connections = new Set()
  return {
    timer,
    now: () => performance.now(),
    elapsed: (start, end) => end - start,
    id: () => `sim-${++serial}`,
    connections,
    connect(href, events, limits) {
      const url = new URL(href)
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password)
        fail('INVALID_SIMULATOR_ENDPOINT')
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      connections.add(socket)
      let closed = false
      const handlers = {
        open: () => {
          if (!closed) events.open()
        },
        message: ({ data }) => {
          if (closed) return
          const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
          const maximum = typeof data === 'string' ? limits.maxControlBytes : limits.maxOutputChunkBytes + 16
          if (bytes > maximum) events.error('MESSAGE_TOO_LARGE')
          else events.message(data)
        },
        error: () => {
          if (!closed) events.error('WEBSOCKET_ERROR')
        },
        close: () => {
          connections.delete(socket)
          if (!closed) events.close()
        },
      }
      for (const [key, handler] of Object.entries(handlers)) socket.addEventListener(key, handler)
      return {
        send(data) {
          if (closed || socket.readyState !== WebSocket.OPEN) fail('NOT_CONNECTED')
          const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
          if (socket.bufferedAmount + bytes > limits.maxPendingSendBytes) fail('SEND_BACKPRESSURE')
          socket.send(data)
        },
        close() {
          if (closed) return
          closed = true
          for (const [key, handler] of Object.entries(handlers)) socket.removeEventListener(key, handler)
          socket.addEventListener('error', () => {}, { once: true })
          connections.delete(socket)
          socket.close()
        },
      }
    },
  }
}
