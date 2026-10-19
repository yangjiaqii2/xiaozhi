import { createHash } from 'node:crypto'

// Loopback fixture only, not a general Internet-facing WS server. Supports RFC6455
// masked, unfragmented client messages, ping/pong/close, partial TCP reads. Rejects
// fragmentation/extensions/64-bit lengths; bounded before payload allocation.
export function acceptWebSocket(request, socket, head, onMessage, onClose) {
  const key = request.headers['sec-websocket-key']
  if (
    request.method !== 'GET' ||
    request.url !== '/api/realtime' ||
    request.headers.upgrade?.toLowerCase() !== 'websocket' ||
    request.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  const pending = Buffer.alloc(4110)
  let length = 0
  let closed = false
  function send(value, opcode) {
    if (closed || socket.destroyed) return
    const data = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    if (data.length > 32768 || socket.writableLength + data.length > 65536) return socket.destroy()
    const frame = Buffer.alloc((data.length < 126 ? 2 : 4) + data.length)
    frame[0] = 0x80 | (opcode ?? (typeof value === 'string' ? 1 : 2))
    if (data.length < 126) frame[1] = data.length
    else {
      frame[1] = 126
      frame.writeUInt16BE(data.length, 2)
    }
    data.copy(frame, frame.length - data.length)
    socket.write(frame)
  }
  function consume() {
    while (length >= 2) {
      const opcode = pending[0] & 15
      if ((pending[0] & 0xf0) !== 0x80 || !(pending[1] & 0x80) || ![1, 2, 8, 9, 10].includes(opcode))
        throw new Error('INVALID_WS_FRAME')
      let size = pending[1] & 127
      let offset = 2
      if (size === 127) throw new Error('WS_TOO_LARGE')
      if (size === 126) {
        if (length < 4) return
        size = pending.readUInt16BE(2)
        offset = 4
      }
      if (size > 4096 || (opcode >= 8 && size > 125)) throw new Error('WS_TOO_LARGE')
      if (length < offset + 4 + size) return
      const data = Buffer.alloc(size)
      for (let i = 0; i < size; i++) data[i] = pending[offset + 4 + i] ^ pending[offset + (i % 4)]
      const used = offset + 4 + size
      pending.copyWithin(0, used, length)
      length -= used
      if (opcode === 8) {
        send(data, 8)
        socket.end()
        return
      }
      if (opcode === 9) send(data, 10)
      else if (opcode === 1) onMessage(new TextDecoder('utf-8', { fatal: true }).decode(data))
      else if (opcode === 2) onMessage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    }
  }
  function receive(chunk) {
    try {
      let offset = 0
      while (offset < chunk.length && !closed) {
        const size = Math.min(pending.length - length, chunk.length - offset)
        if (!size) throw new Error('WS_TOO_LARGE')
        chunk.copy(pending, length, offset, offset + size)
        length += size
        offset += size
        consume()
      }
    } catch {
      socket.destroy()
    }
  }
  socket.on('data', receive)
  socket.on('error', () => {})
  socket.once('close', () => {
    closed = true
    onClose()
  })
  if (head.length) queueMicrotask(() => receive(head))
  return { send, close: () => socket.destroy() }
}
