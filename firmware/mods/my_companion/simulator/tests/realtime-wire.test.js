import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { acceptWebSocket } from '../mock-websocket.js'

function fixture() {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.writableLength = 0
  socket.writes = []
  socket.write = (data) => {
    socket.writes.push(data)
    return true
  }
  socket.destroy = () => {
    socket.destroyed = true
    socket.emit('close')
  }
  socket.end = socket.destroy
  const messages = []
  const wire = acceptWebSocket(
    {
      method: 'GET',
      url: '/api/realtime',
      headers: {
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    },
    socket,
    Buffer.alloc(0),
    (data) => messages.push(data),
    () => {},
  )
  return { socket, messages, wire }
}

function masked(text, opcode = 1) {
  const data = Buffer.from(text)
  const frame = Buffer.alloc(6 + data.length)
  frame[0] = 0x80 | opcode
  frame[1] = 0x80 | data.length
  const mask = [1, 2, 3, 4]
  frame.set(mask, 2)
  for (let n = 0; n < data.length; n++) frame[6 + n] = data[n] ^ mask[n % 4]
  return frame
}

test('local mock WS validates RFC handshake and handles partial TCP plus coalesced frames', () => {
  const { socket, messages } = fixture()
  assert(socket.writes[0].includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='))
  const frame = masked('你好')
  socket.emit('data', frame.subarray(0, 3))
  socket.emit('data', Buffer.concat([frame.subarray(3), masked('next')]))
  assert.deepEqual(messages, ['你好', 'next'])
})

test('local mock WS answers ping and closes unmasked/fragmented/oversize frames', () => {
  const { socket } = fixture()
  socket.emit('data', masked('ping', 9))
  assert.equal(socket.writes[1][0], 0x8a)
  for (const frame of [Buffer.from([0x81, 0]), Buffer.from([1, 0x80]), Buffer.from([0x82, 0xfe, 0xff, 0xff])]) {
    const { socket } = fixture()
    socket.emit('data', frame)
    assert.equal(socket.destroyed, true)
  }
})
