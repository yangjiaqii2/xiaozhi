import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioBuffer } from '../../ai/audio-buffer.js'
import { audioFormat, decodeAudio, encodeAudio, parseEvent } from '../../ai/realtime-protocol.js'

test('binary PCM preserves direction, turn, sequence and payload without base64', () => {
  const pcm = new Uint8Array([1, 0, 255, 127]).buffer
  const frame = encodeAudio(1, 7, 2, pcm, 640)
  const value = decodeAudio(frame, 1, 640)
  assert.equal(value.turnId, 7)
  assert.equal(value.sequence, 2)
  assert.deepEqual(value.pcm, pcm)
  assert.equal(frame.byteLength, pcm.byteLength + 16)
})

for (const [name, frame] of [
  ['empty', new ArrayBuffer(0)],
  ['large', new ArrayBuffer(2049)],
  ['bad header', new ArrayBuffer(20)],
]) {
  test(`reject ${name} binary frame`, () => assert.throws(() => decodeAudio(frame, 2, 1920)))
}

test('strict ready validation and malformed control messages', () => {
  const ready = { type: 'session.ready', requestId: 'r1', sessionId: 's1', audio: audioFormat }
  assert.equal(parseEvent(JSON.stringify(ready), 2048).sessionId, 's1')
  for (const value of ['{', 'null', '[]', '{"type":"eval","code":"x"}', ' '.repeat(2049)]) {
    assert.throws(() => parseEvent(value, 2048))
  }
  assert.throws(() => parseEvent(JSON.stringify({ ...ready, audio: {} }), 2048))
  assert.throws(() => parseEvent(JSON.stringify({ ...ready, requestId: 1 }), 2048))
})

test('bounded FIFO clears references and rejects byte/slot overflow', () => {
  const queue = new AudioBuffer({ maxBytes: 8, maxChunks: 2 })
  queue.push(new ArrayBuffer(4))
  queue.push(new ArrayBuffer(4))
  assert.throws(() => queue.push(new ArrayBuffer(2)), /BUFFER_OVERFLOW/)
  assert.equal(queue.bytes, 8)
  assert.equal(queue.shift().byteLength, 4)
  queue.push(new ArrayBuffer(2))
  queue.clear()
  assert.equal(queue.bytes, 0)
  assert.equal(queue.length, 0)
  assert.equal(queue.shift(), undefined)
})
