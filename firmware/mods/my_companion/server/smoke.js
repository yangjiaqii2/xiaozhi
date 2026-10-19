import { assertStreamCompleted } from './acceptance-audio.js'
import { loadLocalConfig } from './local-config-loader.js'
import { configFromEnvironment, modelConfig } from './providers/apiyi/model-config.js'

try {
  await loadLocalConfig()
} catch {
  console.error('[Server] LOCAL_CONFIG_INVALID')
  process.exit(1)
}

// Paid calls are explicit, short and bounded. Never run as part of npm test.
if (!process.env.APIYI_API_KEY) {
  console.log('REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured')
} else {
  try {
    if (process.argv[2] === 'text') await textSmoke()
    else if (process.argv[2] === 'audio') await audioSmoke()
    else throw new Error('INVALID_SMOKE_MODE')
  } catch (error) {
    const codes = [
      'SMOKE_TIMEOUT',
      'SMOKE_VALIDATION_FAILED',
      'UPLOAD_FAILED',
      'REALTIME_NOT_READY',
      'STREAM_INCOMPLETE',
    ]
    console.error(
      `[RealProvider] ${codes.includes(error.message) ? error.message : 'TEST_FAILED'} (no credentials or raw provider response logged)`,
    )
    process.exitCode = 1
  }
}

async function textSmoke() {
  const { ApiYiRealtimeProvider } = await import('./providers/apiyi/apiyi-realtime-provider.js')
  const base = configFromEnvironment()
  const config = modelConfig(base.model, { ...base, mode: 'text', vad: 'manual', vadSilenceMs: undefined })
  const provider = new ApiYiRealtimeProvider({ config })
  let rounds = 0
  try {
    provider.on('error', ({ code }) =>
      console.error(JSON.stringify({ error: code, httpStatus: provider.lastFailure?.httpStatus ?? null })),
    )
    await provider.connect()
    const samples = Number(process.env.REALTIME_TEXT_SAMPLES ?? 2)
    if (!Number.isInteger(samples) || samples < 2 || samples > 5) throw new Error('INVALID_SAMPLE_BUDGET')
    const prompts = [
      'Remember the label ALPHA7. Reply OK.',
      'What label did I ask you to remember? Reply only the label.',
      '你好，你叫什么？用一句中文回答。',
      '今天有点累啊，你陪我聊会儿。用一句中文回答。',
      '我叫小明。请用一句简短中文回应。',
    ]
    for (const text of prompts.slice(0, samples)) {
      const requestStart = performance.now()
      const requestStartUTC = new Date().toISOString()
      const result = await new Promise((resolve, reject) => {
        let answer = ''
        let deltas = 0
        const timer = setTimeout(() => finish(new Error('SMOKE_TIMEOUT')), 20000)
        const delta = (event) => {
          if (answer.length < 2048) answer += event.delta
          deltas++
        }
        const done = (event) =>
          finish(null, {
            contextMatched: rounds !== 1 || answer.includes('ALPHA7'),
            deltas,
            usage: event.usage,
            status: event.status,
          })
        const error = () => finish(new Error('PROVIDER_FAILED'))
        function finish(error, value) {
          clearTimeout(timer)
          provider.off('text_delta', delta)
          provider.off('response_done', done)
          provider.off('error', errorHandler)
          error ? reject(error) : resolve(value)
        }
        const errorHandler = error
        provider.on('text_delta', delta)
        provider.once('response_done', done)
        provider.once('error', errorHandler)
        try {
          provider.sendText(text)
          provider.createResponse()
        } catch (error) {
          finish(error)
        }
      })
      rounds++
      console.log(
        JSON.stringify({
          evidence: 'LINUX_REAL_API',
          model: config.model,
          protocol: config.family,
          round: rounds,
          request_start: requestStartUTC,
          request_start_monotonic: requestStart,
          first_text_delta: provider.metrics.first_text_delta_time,
          response_done: performance.now(),
          TTFT:
            provider.metrics.first_text_delta_time === null
              ? null
              : provider.metrics.first_text_delta_time - requestStart,
          total_time: performance.now() - requestStart,
          ...result,
          metrics: provider.metrics,
          maxRetries: 0,
        }),
      )
      if (!result.deltas || !result.usage || !result.contextMatched) throw new Error('SMOKE_VALIDATION_FAILED')
    }
  } finally {
    provider.close()
  }
}

async function audioSmoke() {
  const path = process.env.REALTIME_WAV ?? process.argv[3]
  if (!path) {
    console.log('REAL AUDIO TEST SKIPPED: REALTIME_WAV not configured')
    return
  }
  process.env.REALTIME_WAV = path
  const { ApiYiSimulator } = await import('../simulator/apiyi-simulator.js')
  const records = []
  const sim = new ApiYiSimulator({
    port: 0,
    latencyMs: 0,
    debug: false,
    write: (line) => {
      if (line.startsWith('[Server]')) {
        const record = JSON.parse(line.slice('[Server] '.length))
        records.push(record)
        if (records.length > 64) records.shift()
      }
    },
  })
  try {
    await sim.start()
    sim.audioInput.validate()
    const upload = sim.voice()
    upload.catch(() => {})
    if (process.argv.includes('--interrupt')) {
      await sim.waitFor(() => sim.realtime.phase === 'SPEAKING', 30000)
      sim.interrupt()
      await sim.waitFor(() => records.some((v) => v.type === 'interrupted'), 6000)
    }
    const sent = await upload
    if (!sent.ok) throw new Error('UPLOAD_FAILED')
    if (!process.argv.includes('--interrupt'))
      await sim.waitFor(() => sim.realtime.phase === 'IDLE' && sim.audioOutput.bytes > 0, 30000)
    if (!process.argv.includes('--interrupt')) assertStreamCompleted(records)
    let reconnectLatency = null
    if (process.argv.includes('--reconnect')) {
      const session = sim.realtime.sessionId
      const start = performance.now()
      const peer = [...sim.aiServer.sessions.values()][0]
      peer.provider.socket.terminate()
      await sim.waitFor(() => sim.realtime.status === 'CONNECTED' && sim.realtime.sessionId !== session, 35000)
      reconnectLatency = performance.now() - start
    }
    console.log(
      JSON.stringify({
        evidence: 'LINUX_REAL_API',
        model: configFromEnvironment().model,
        device: sim.realtime.metrics,
        server: records,
        outputBytes: sim.audioOutput.bytes,
        outputFile: sim.audioOutput.path,
        reconnect_latency: reconnectLatency,
      }),
    )
  } finally {
    await sim.close()
  }
}
