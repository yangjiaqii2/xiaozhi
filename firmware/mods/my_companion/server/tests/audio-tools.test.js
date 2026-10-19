import assert from 'node:assert/strict'
import { closeSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decodeAudio } from '../../ai/realtime-protocol.js'
import { OutputStream } from '../output-stream.js'
import { ServerTools } from '../tools.js'
import { openWav, WavAudioInput, WavAudioOutput, wavHeader } from '../wav.js'

test('output is paced as binary PCM chunks before complete generation and bounded by byte budget', async () => {
  const frames = []
  let drained
  const done = new Promise((resolve) => {
    drained = resolve
  })
  const stream = new OutputStream({
    send: (frame) => frames.push(decodeAudio(frame, 2, 1920)),
    onDrain: drained,
    onError() {
      assert.fail('unexpected send error')
    },
    maxBytes: 3840,
  })
  stream.begin(3)
  stream.push(Buffer.alloc(2880))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].sequence, 1)
  assert.equal(frames[0].turnId, 3)
  assert.equal(stream.bytes, 1920)
  assert.throws(() => stream.push(Buffer.alloc(2880)), /BACKPRESSURE/)
  await done
  assert.equal(frames.length, 3)
  assert.equal(stream.bytes, 0)
  stream.clear()
  stream.clear()
  assert.equal(stream.timer, null)
})

test('cancelled output never invokes stale timer sends; send backpressure is reported', async () => {
  const frames = []
  const errors = []
  const stream = new OutputStream({
    send: (frame) => frames.push(frame),
    onDrain() {},
    onError: (code) => errors.push(code),
  })
  stream.begin(1)
  stream.push(Buffer.alloc(2880))
  stream.clear()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(frames.length, 1)
  stream.begin(2)
  stream.send = () => {
    throw new Error('blocked')
  }
  stream.push(Buffer.alloc(960))
  assert.deepEqual(errors, ['DEVICE_BACKPRESSURE'])
  stream.clear()
})

test('WAV reads real file incrementally, validates format, writes a valid streaming output file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'companion-wav-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const inputPath = path.join(dir, 'in.wav')
  const outputPath = path.join(dir, 'out.wav')
  await writeFile(inputPath, Buffer.concat([wavHeader(2560, 16000), Buffer.alloc(2560)]))
  const source = openWav(inputPath)
  assert.equal(source.length, 2560)
  closeSync(source.fd)
  const input = new WavAudioInput(inputPath)
  const chunks = []
  input.validate()
  input.start((pcm) => chunks.push(pcm.byteLength))
  await input.utterance({ silenceMs: 0 })
  assert.deepEqual(chunks, [640, 640, 640, 640])
  input.dispose()
  assert.equal(input.timers.size, 0)
  const output = new WavAudioOutput(outputPath)
  output.write(new ArrayBuffer(960), () => {})
  const partial = await readFile(outputPath)
  assert.equal(partial.readUInt32LE(40), 960, 'file is readable before complete response')
  output.stop()
  output.dispose()
  output.dispose()
  const bytes = await readFile(outputPath)
  assert.equal(bytes.readUInt32LE(24), 24000)
  assert.equal(bytes.length, 1004)
  await writeFile(inputPath, Buffer.concat([wavHeader(640, 24000), Buffer.alloc(640)]))
  assert.throws(() => openWav(inputPath), /WAV_REQUIRES/)
})

test('tool interface only invokes registered handlers, bounds output and observes cancellation', async () => {
  const tools = new ServerTools(
    {
      echo: async (args) => ({ text: args.text }),
      huge: () => 'x'.repeat(9000),
      wait: (_args, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    },
    20,
  )
  const controller = new AbortController()
  assert.equal(await tools.execute('echo', '{"text":"ok"}', controller.signal), '{"text":"ok"}')
  assert.equal(await tools.execute('__proto__', '{}', controller.signal), '{"error":"TOOL_UNAVAILABLE"}')
  await assert.rejects(tools.execute('huge', '{}', controller.signal), /TOOL_RESULT_TOO_LARGE/)
  await assert.rejects(tools.execute('wait', '{}', controller.signal))
  const pending = tools.execute('wait', '{}', controller.signal)
  controller.abort()
  await assert.rejects(pending)
})
