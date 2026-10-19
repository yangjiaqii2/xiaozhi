import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioInput } from '../../hardware/audio-input.js'
import { AudioOutput } from '../../hardware/audio-output.js'

for (const stage of ['volume', 'samples', 'start'])
  test(`native output ${stage} failure releases all owned references before returning`, () => {
    let closed = 0
    class Native {
      static Volume = 1
      static RawSamples = 2
      static Callback = 3
      static Flush = 4
      enqueue(_stream, kind) {
        if ((stage === 'volume' && kind === 1) || (stage === 'samples' && kind === 2)) throw new Error('native failure')
      }
      start() {
        if (stage === 'start') throw new Error('native failure')
      }
      stop() {}
      close() {
        closed++
      }
    }
    const out = new AudioOutput(Native)
    assert.throws(
      () => out.write(new ArrayBuffer(960), () => assert.fail('must not complete failed playback')),
      /native failure/,
    )
    assert.equal(out.audio, null)
    assert.equal(out.pending, null)
    assert.equal(out.samples, null)
    assert.equal(closed, 1)
    assert.equal(out.getDiagnostics().lastError, 'AUDIO_OUTPUT_ERROR')
    out.dispose()
  })

test('native input initialization and stop failures restore callback ownership and expose no raw error', () => {
  const previous = () => {}
  const mic = {
    onReadable: previous,
    start() {
      throw new Error('private native detail')
    },
    stop() {
      throw new Error('close failed')
    },
  }
  const input = new AudioInput(mic)
  assert.throws(() => input.start(() => assert.fail()), /private native detail/)
  assert.equal(mic.onReadable, previous)
  assert.equal(input.active, false)
  assert.equal(input.handler, null)
  assert.equal(input.getDiagnostics().lastError, 'AUDIO_INPUT_ERROR')
  assert.equal(JSON.stringify(input.getDiagnostics()).includes('private'), false)
})
