import assert from 'node:assert/strict'
import test from 'node:test'
import { batchProviderInput } from '../acceptance-audio.js'

for (const duration of [20, 40, 60]) {
  test(`acceptance ${duration}ms provider batches preserve PCM and flush before commit`, () => {
    const sent = []
    const provider = { send: (event) => sent.push(event) }
    const batch = batchProviderInput(provider, duration)
    const expected = []
    for (let n = 0; n < 7; n++) {
      const pcm = Buffer.alloc(640, n)
      expected.push(pcm)
      provider.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
    }
    provider.send({ type: 'input_audio_buffer.commit' })
    assert.equal(sent.at(-1).type, 'input_audio_buffer.commit')
    assert.deepEqual(
      Buffer.concat(sent.slice(0, -1).map((e) => Buffer.from(e.audio, 'base64'))),
      Buffer.concat(expected),
    )
    assert(batch.metrics.maxPendingBytes <= 1920)
    assert.equal(batch.metrics.messages, Math.ceil(7 / (duration / 20)))
  })
}

test('40ms output remains a paced, sequenced binary stream within the existing v1 limit', async () => {
  const { OutputStream } = await import('../output-stream.js')
  const { decodeAudio } = await import('../../ai/realtime-protocol.js')
  const frames = []
  const stream = new OutputStream({
    chunkBytes: 1920,
    send: (frame) => frames.push(decodeAudio(frame, 2, 1920)),
    onDrain() {},
    onError() {
      assert.fail('unexpected error')
    },
  })
  try {
    stream.begin(1)
    stream.push(Buffer.alloc(3840))
    assert.equal(frames.length, 1, 'first frame forwards before generation is complete')
    assert.equal(frames[0].pcm.byteLength, 1920)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(frames.length, 2)
    assert.equal(frames[1].sequence, 2)
    assert.throws(() => new OutputStream({ chunkBytes: 2880 }))
  } finally {
    stream.clear()
  }
})

test('partial audio followed by idle/error cannot pass the audio smoke', async () => {
  const { assertStreamCompleted } = await import('../acceptance-audio.js')
  assert.throws(
    () =>
      assertStreamCompleted([
        { type: 'audio', bytes: 19200 },
        { type: 'error', code: 'PROVIDER_PROTOCOL_ERROR' },
        { type: 'idle' },
      ]),
    /STREAM_INCOMPLETE/,
  )
  assert.doesNotThrow(() => assertStreamCompleted([{ type: 'stream_completed' }]))
})
