import assert from 'node:assert/strict'
import test from 'node:test'
import { PCMResampler } from '../audio.js'
import { DeviceAuth } from '../auth.js'
import { modelConfig, protocolFor } from '../providers/apiyi/model-config.js'

for (const model of [
  'qwen3.5-omni-flash-realtime',
  'qwen3.5-omni-plus-realtime',
  'gpt-realtime-2.1-mini',
  'gpt-realtime-2.1',
]) {
  test(`${model}: independent family schema, voice and VAD`, () => {
    const config = modelConfig(model)
    const protocol = protocolFor(config)
    const session = protocol.configure({ ...config, vad: 'semantic_vad', mode: 'audio' }).session
    if (config.family === 'omni') {
      assert.equal(config.inputRate, 16000)
      assert.equal(session.voice, 'Tina')
      assert.deepEqual(session.modalities, ['text', 'audio'])
      assert.equal(session.turn_detection.type, 'semantic_vad')
      assert.equal(session.output_modalities, undefined)
    } else {
      assert.equal(config.inputRate, 24000)
      assert.equal(session.type, 'realtime')
      assert.deepEqual(session.output_modalities, ['audio'])
      assert.equal(session.audio.output.voice, 'marin')
      assert.equal(session.audio.input.format.rate, 24000)
      assert.equal(session.voice, undefined)
    }
    assert.equal(config.outputRate, 24000)
  })
}

test('manual/text mode and configurable voice have distinct valid fields', () => {
  for (const model of ['gpt-realtime-2.1', 'qwen3.5-omni-flash-realtime']) {
    const cfg = modelConfig(model, { voice: 'Ethan', vad: 'manual', mode: 'text' })
    const session = protocolFor(cfg).configure(cfg).session
    assert.equal(cfg.family === 'omni' ? session.turn_detection : session.audio.input.turn_detection, null)
    assert.deepEqual(cfg.family === 'omni' ? session.modalities : session.output_modalities, ['text'])
  }
  assert.throws(() => modelConfig('arbitrary-model'))
  assert.throws(() => modelConfig('gpt-realtime-2.1', { vad: 'made_up' }))
})

test('streaming resampling is invariant to chunk boundaries and retains only fixed state', () => {
  const pcm = Buffer.alloc(640)
  for (let n = 0; n < 320; n++) pcm.writeInt16LE(Math.round(Math.sin(n / 8) * 10000), n * 2)
  const whole = new PCMResampler(16000, 24000)
  const expected = whole.push(pcm)
  const split = new PCMResampler(16000, 24000)
  const pieces = []
  for (let offset = 0; offset < pcm.length; offset += 14) pieces.push(split.push(pcm.subarray(offset, offset + 14)))
  assert.deepEqual(Buffer.concat(pieces), expected)
  assert(expected.length >= 956 && expected.length <= 960)
  assert.throws(() => split.push(Buffer.alloc(3)))
})

test('device token rotation authenticates identities, never deviceId alone', () => {
  const auth = new DeviceAuth([
    { deviceId: 'robot-001', tokens: ['a'.repeat(32), 'b'.repeat(32)], instructions: 'private persona' },
  ])
  assert.equal(
    auth.authenticate({ 'x-device-id': 'robot-001', authorization: `Bearer ${'a'.repeat(32)}` }).deviceId,
    'robot-001',
  )
  assert.equal(
    auth.authenticate({ 'x-device-id': 'robot-001', authorization: `Bearer ${'b'.repeat(32)}` }).deviceId,
    'robot-001',
  )
  assert.equal(auth.authenticate({ 'x-device-id': 'robot-001' }), null)
  assert.equal(auth.authenticate({ 'x-device-id': 'other', authorization: `Bearer ${'a'.repeat(32)}` }), null)
  assert.equal(auth.authenticate({ 'x-device-id': 'robot-001', authorization: 'Bearer wrong' }), null)
})

test('explicit server VAD silence duration is placed in the correct family schema', () => {
  for (const model of ['qwen3.5-omni-flash-realtime', 'gpt-realtime-2.1-mini']) {
    const config = modelConfig(model, { vad: 'server_vad', vadSilenceMs: 300 })
    const session = protocolFor(config).configure(config).session
    const vad = config.family === 'omni' ? session.turn_detection : session.audio.input.turn_detection
    assert.equal(vad.silence_duration_ms, 300)
    assert.throws(() => modelConfig(model, { vad: 'server_vad', vadSilenceMs: 0 }))
    assert.throws(() => modelConfig(model, { vad: 'semantic_vad', vadSilenceMs: 300 }))
  }
})
