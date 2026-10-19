// Explicit, bounded, paid Linux acceptance. Never imported by the MOD or npm test.

import { createHash } from 'node:crypto'
import { closeSync, readSync } from 'node:fs'
import { decodeAudio } from '../ai/realtime-protocol.js'
import { ApiYiSimulator } from '../simulator/apiyi-simulator.js'
import { batchProviderInput } from './acceptance-audio.js'
import { arrayBuffer } from './audio.js'
import { loadLocalConfig } from './local-config-loader.js'
import { activeSessionError, ProgressDeadline, TurnCompletion } from './progress-deadline.js'
import { openWav } from './wav.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => performance.now()
const safeError = (error) => (/^[A-Z][A-Z_]{1,63}$/.test(error?.code ?? '') ? error.code : 'ACCEPTANCE_FAILED')

export async function audioAcceptance({
  paths,
  mode = 'normal',
  chunkMs = 20,
  providerChunkMs = 20,
  outputChunkMs = 20,
  completionTimeoutMs = 25000,
  progressDeadline,
  onSimulator = () => {},
  onTrial = () => {},
} = {}) {
  if (
    !Number.isInteger(completionTimeoutMs) ||
    completionTimeoutMs < 1000 ||
    completionTimeoutMs > 60000 ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 6 ||
    ![20, 40].includes(chunkMs) ||
    ![20, 40].includes(outputChunkMs) ||
    ![20, 40, 60].includes(providerChunkMs) ||
    !['normal', 'interrupt', 'reconnect', 'graceful-reconnect', 'network-reconnect', 'voice-interrupt'].includes(mode)
  )
    throw new Error('INVALID_ACCEPTANCE_BUDGET')
  if (mode === 'voice-interrupt' && ![2, 3].includes(paths.length)) throw new Error('INVALID_ACCEPTANCE_BUDGET')
  for (const path of paths) {
    const wav = openWav(path)
    closeSync(wav.fd)
    if (wav.length > 640000) throw new Error('ACCEPTANCE_WAV_EXCEEDS_20_SECONDS')
  }
  const records = []
  let current
  let provider
  let startupError = null
  let peer
  let batch
  let upstreamConnections = 0
  let audioHashes
  const completion = new TurnCompletion()
  const sim = new ApiYiSimulator({
    port: 0,
    latencyMs: 0,
    debug: false,
    write: (line) => {
      if (!current || !line.startsWith('[Server] ')) return
      const record = JSON.parse(line.slice(9))
      if (record.type === 'protocol_failure') current.server_failure = record.code
      if (record.type === 'error') current.server_error = record.code
      if (record.type === 'stream_completed') {
        stamp('stream_completed')
        current.queue = record.queue ?? null
      }
    },
  })
  const eventLog = (type, fields = {}) => {
    if (current && current.events.length < 64) current.events.push({ type, at: now(), ...fields })
  }
  const stamp = (key) => {
    if (current && current[key] == null) current[key] = now()
  }
  const watch = (p) => {
    provider = p
    batch = batchProviderInput(p, providerChunkMs)
    const originalFactory = p.socketFactory
    p.socketFactory = (...args) => {
      const socket = originalFactory(...args)
      upstreamConnections++
      const wireSend = socket.send.bind(socket)
      socket.send = (data, ...options) => {
        try {
          if (typeof data === 'string' && JSON.parse(data).type === 'response.cancel') stamp('response_cancel_wire')
        } catch {}
        return wireSend(data, ...options)
      }
      socket.on('message', (data, binary) => {
        if (binary) return
        try {
          const e = JSON.parse(data.toString())
          if (e.type === 'session.updated') {
            const vad = e.session?.turn_detection ?? e.session?.audio?.input?.turn_detection
            p.acceptedConfig = {
              vad: ['server_vad', 'semantic_vad'].includes(vad?.type) ? vad.type : null,
              silence_duration_ms: Number.isInteger(vad?.silence_duration_ms) ? vad.silence_duration_ms : null,
            }
          }
          if (!current) return
          if (e.type === 'error') {
            const code = e.error?.code
            const allowed = [
              'invalid_request_error',
              'invalid_value',
              'integer_below_min_value',
              'unsupported_value',
              'server_error',
              'rate_limit_exceeded',
              'insufficient_quota',
              'invalid_api_key',
            ]
            current.provider_error_code = allowed.includes(code) ? code : 'UPSTREAM_ERROR'
            const param = e.error?.param
            const params = [
              'session.turn_detection',
              'session.input_audio_format',
              'session.voice',
              'session.modalities',
              'session.audio.input.format.rate',
            ]
            current.provider_error_param = params.includes(param) ? param : null
          }
          if (e.type === 'response.output_item.done') {
            stamp('output_item_done')
            eventLog('output_item_done', { responseId: e.response_id ?? null })
          }
          if (e.type === 'response.done') stamp('response_done_event')
          if (e.type === 'input_audio_buffer.committed') stamp('input_committed_ack')
          if (e.type === p.protocol.audioDelta && e.response_id && p.cancelled.has(e.response_id)) {
            current.old_audio_dropped_chunks++
            current.old_audio_dropped_bytes += typeof e.delta === 'string' ? Buffer.byteLength(e.delta, 'base64') : 0
          }
        } catch {
          /* raw payload is never printed */
        }
      })
      return socket
    }
    p.on('error', ({ code }) => {
      startupError = code
      if (current) {
        if (current.reconnect_start) current.induced_disconnect = code
        else current.error = code
        current.failure_reason = p.lastFailure?.reason ?? null
      }
    })
    p.on('speech_started', () => {
      stamp('speech_started')
      eventLog('speech_started')
    })
    p.on('speech_stopped', () => {
      stamp('speech_stopped')
      eventLog('speech_stopped')
    })
    p.on('response_started', ({ responseId }) => {
      eventLog('response_created', { responseId })
      stamp('response_start')
      if (current?.interrupt_detected) stamp('new_turn_started')
    })
    p.on('audio_delta', ({ pcm }) => {
      audioHashes?.provider.update(pcm)
      const first = current?.T4 == null
      stamp('T4')
      if (current) {
        if (first) current.provider_TTFA = p.metrics.TTFA
        if (current.new_turn_started) current.new_turn_provider_TTFA ??= p.metrics.TTFA
        current.provider_audio_chunks++
        current.provider_output_bytes += pcm.length
      }
    })
    p.on('response_done', (e) => {
      eventLog('response_done', { responseId: e.responseId })
      stamp('response_done')
      if (current) {
        current.usage = e.usage
        current.response_status = e.status
      }
    })
    p.on('interrupted', ({ reason }) => {
      eventLog('cancel_settled', { reason })
      stamp('cancel_ack')
      if (current) current.cancel_reason = reason
    })
    const cancel = p.cancelResponse.bind(p)
    p.cancelResponse = () => {
      stamp('response_cancel')
      return cancel()
    }
    return p
  }
  try {
    await sim.start()
    onSimulator(sim)
    sim.realtime.options.reconnect.maxAttempts = 2
    const factory = sim.aiServer.options.providerFactory
    sim.aiServer.options.providerFactory = (...args) => watch(factory(...args))
    const connect = sim.realtimeRuntime.connect.bind(sim.realtimeRuntime)
    sim.realtimeRuntime.connect = (url, events, limits) =>
      connect(
        url,
        {
          ...events,
          message(data) {
            if (data instanceof ArrayBuffer) {
              stamp('T6')
              if (current) {
                current.device_audio_chunks++
                current.device_audio_bytes += data.byteLength - 16
                audioHashes?.device.update(Buffer.from(data, 16))
              }
            }
            events.message(data)
          },
        },
        limits,
      )
    const bufferPush = sim.realtime.buffer.push.bind(sim.realtime.buffer)
    sim.realtime.buffer.push = (pcm) => {
      if (current)
        current.max_client_buffer_bytes = Math.max(
          current.max_client_buffer_bytes ?? 0,
          sim.realtime.buffer.bytes + pcm.byteLength,
        )
      return bufferPush(pcm)
    }
    const finishPlayback = sim.realtime.finishPlayback.bind(sim.realtime)
    sim.realtime.finishPlayback = () => {
      const turn = sim.realtime.responseTurn
      finishPlayback()
      if (turn?.done && !sim.realtime.responseTurn) {
        completion.complete(sim.realtime.sessionId, turn.id)
        stamp('output_playback_completed')
      }
    }
    const later = sim.realtime.later.bind(sim.realtime)
    sim.realtime.later = (name, callback, ms) => {
      if (name === 'jitter') stamp('simulator_playback_scheduled')
      return later(name, callback, ms)
    }
    const commit = sim.realtime.commitInput.bind(sim.realtime)
    sim.realtime.commitInput = () => {
      stamp('input_commit')
      return commit()
    }
    const write = sim.audioOutput.write.bind(sim.audioOutput)
    sim.audioOutput.write = (pcm, done) => {
      stamp('T7')
      if (current) current.played_audio_bytes += pcm.byteLength
      audioHashes?.playback.update(Buffer.from(pcm))
      if (current?.interrupt_detected && sim.realtime.responseTurn?.id === current.old_turn) {
        current.old_audio_leaked_chunks++
        current.old_audio_leaked_bytes += pcm.byteLength
      }
      return write(pcm, done)
    }
    const interrupt = sim.realtime.interrupt.bind(sim.realtime)
    sim.realtime.interrupt = () => {
      const turnId = sim.realtime.responseTurn?.id
      if (turnId != null) completion.cancel(sim.realtime.sessionId, turnId)
      if (current?.mode === 'voice-interrupt' && sim.realtime.responseTurn) {
        stamp('interrupt_detected')
        current.old_turn ??= sim.realtime.responseTurn.id
      }
      return interrupt()
    }
    const stop = sim.audioOutput.stop.bind(sim.audioOutput)
    sim.audioOutput.stop = () => {
      if (current?.interrupt_detected) stamp('speaker_stop')
      return stop()
    }
    const ready = await sim.connectRealtime()
    if (!ready.ok) throw Object.assign(new Error(), { code: startupError ?? ready.code ?? 'PROVIDER_CONNECT_FAILED' })
    const hookPeer = () => {
      peer = [...sim.aiServer.sessions.values()][0]
      peer.output.chunkBytes = outputChunkMs * 48
      const audio = peer.audio.bind(peer)
      peer.audio = (frame) => {
        if (current?.last_speech_sequence != null) {
          const packet = decodeAudio(frame, 1, 1280)
          if (packet.turnId === current.input_turn && packet.sequence === current.last_speech_sequence)
            current.T1 = now()
        }
        return audio(frame)
      }
      const push = peer.output.push.bind(peer.output)
      peer.output.push = (pcm) => {
        stamp('T4')
        const result = push(pcm)
        if (current) current.max_server_queue_bytes = Math.max(current.max_server_queue_bytes ?? 0, peer.output.bytes)
        return result
      }
      const send = peer.output.send.bind(peer.output)
      peer.output.send = (data) => {
        stamp('T5')
        return send(data)
      }
    }
    hookPeer()
    for (let n = 0; n < (mode === 'voice-interrupt' ? 1 : paths.length); n++) {
      current = {
        evidence: 'LINUX_REAL_API',
        measurement_version: '46.1',
        completion_scope: 'last_wav_turn_or_observed_cancellation_successor',
        flow_revision: 'sample_clock_and_completed_cancel_guard',
        simulator_clock: 'sample_deadline',
        model: provider.config.model,
        protocol: provider.config.family,
        vad: provider.config.vad,
        vad_silence_ms: provider.config.vadSilenceMs ?? null,
        accepted_config: provider.acceptedConfig,
        mode,
        usage_scope: mode === 'voice-interrupt' ? 'post_interruption_response' : 'single_response',
        sample: n + 1,
        completion_timeout_ms: completionTimeoutMs,
        requestId: sim.realtime.requestId,
        input_first_chunk: null,
        input_commit: null,
        simulator_playback_scheduled: null,
        chunk_ms: chunkMs,
        provider_chunk_ms: providerChunkMs,
        output_chunk_ms: outputChunkMs,
        connection_time: provider.metrics.connection_time,
        session_ready_time: provider.metrics.session_ready_time,
        T0: null,
        T1: null,
        T2: null,
        T3: null,
        T4: null,
        T5: null,
        T6: null,
        T7: null,
        provider_audio_chunks: 0,
        provider_output_bytes: 0,
        device_audio_chunks: 0,
        device_audio_bytes: 0,
        played_audio_bytes: 0,
        old_audio_dropped_chunks: 0,
        old_audio_dropped_bytes: 0,
        old_audio_leaked_chunks: 0,
        old_audio_leaked_bytes: 0,
        usage: null,
        events: [],
        error: null,
      }
      audioHashes = { provider: createHash('sha256'), device: createHash('sha256'), playback: createHash('sha256') }
      const trialSessionId = sim.realtime.sessionId
      const sessionError = () => activeSessionError(sim.realtime, trialSessionId)
      records.push(current)
      onTrial(current, sim)
      const sentBefore = sim.realtime.metrics.audioBytesSent
      const cpu = process.cpuUsage()
      const started = now()
      const uploading = upload(paths[n])
      // Attach rejection immediately: interruption/disconnection can stop an in-flight input.
      uploading.catch(() => {})
      if (mode === 'interrupt') {
        await until(() => current.T7 != null || current.error, 20000)
        if (!current.error) {
          current.interrupt_detected = now()
          current.cancel_active = Boolean(provider.activeResponse)
          current.old_turn = sim.realtime.responseTurn?.id
          current.cancelled_response_id = provider.activeResponse
          sim.interrupt()
          await until(() => current.cancel_ack != null || current.error, 6000)
          await wait(150)
        }
      }
      if (mode === 'voice-interrupt') {
        await until(() => current.T7 != null || current.error || current.server_error, 20000)
        if (!current.error && !current.server_error) {
          current.old_turn = sim.realtime.responseTurn?.id
          current.stop_initial_upload = true
          await uploading
          current.user_barge_input_start = now()
          await upload(paths[1], true)
          await until(() => current.cancel_ack != null || current.error || current.server_error, 6000)
          if (paths[2] && !current.error && !current.server_error) {
            current.followup_input_start = now()
            await upload(paths[2], true)
          }
        }
      }
      await uploading
      if (mode !== 'interrupt')
        await until(
          () =>
            (sim.realtime.phase === 'IDLE' && completion.isComplete()) ||
            current.error ||
            current.server_error ||
            sessionError(),
          completionTimeoutMs,
          progressDeadline
            ? { ...progressDeadline, read: () => sim.audioOutput.playedBytes + sim.realtime.metrics.audioBytesReceived }
            : undefined,
        )
      current.completion_expected = completion.expected
      current.completion_observed = [...completion.completed]
      current.completion_cancelled = [...completion.cancelled]
      if (mode !== 'interrupt' && !completion.isComplete())
        current.error ??= current.server_error ?? sessionError() ?? 'STREAM_INCOMPLETE'
      if (['reconnect', 'graceful-reconnect', 'network-reconnect'].includes(mode) && !current.error) {
        current.provider_TTFA ??= provider.metrics.TTFA
        const oldSession = sim.realtime.sessionId
        current.reconnect_start = now()
        if (mode === 'graceful-reconnect') provider.socket.close(1000)
        else if (mode === 'network-reconnect') {
          sim.companion.wifi.disconnect()
          await wait(250)
          sim.companion.wifi.connect()
        } else provider.socket.terminate()
        await until(() => sim.realtime.status === 'CONNECTED' && sim.realtime.sessionId !== oldSession, 35000)
        current.reconnect_latency = now() - current.reconnect_start
        current.session_changed = sim.realtime.sessionId !== oldSession
        current.session_reconfigured = provider.ready && provider.configured
        hookPeer()
      }
      current.audio_sha256 =
        mode === 'normal'
          ? Object.fromEntries(Object.entries(audioHashes).map(([name, hash]) => [name, hash.copy().digest('hex')]))
          : null
      current.input_audio_bytes = sim.realtime.metrics.audioBytesSent - sentBefore
      current.provider_TTFA ??= provider.metrics.TTFA
      current.provider_batch_max_bytes = batch.metrics.maxPendingBytes
      current.first_audio_before_done =
        mode !== 'voice-interrupt' && current.T5 != null && current.response_done != null
          ? current.T5 < current.response_done
          : null
      current.E2E_TTFA = difference(current.T7, current.T0)
      current.server_forward_latency = difference(current.T5, current.T4)
      current.device_buffer_latency = difference(current.T7, current.T6)
      current.vad_end_to_first_audio = difference(current.T4, current.speech_stopped)
      current.upload_to_commit_ack = difference(current.input_committed_ack, current.T0)
      current.barge_detection_latency = difference(current.interrupt_detected, current.user_barge_input_start)
      current.interrupt_latency = difference(current.speaker_stop, current.interrupt_detected)
      current.total_time = now() - started
      current.cpu = process.cpuUsage(cpu)
      current.queue ??= peer.output.snapshot()
      // Only single-response normal trials have unambiguous per-turn attribution.
      current.timeline =
        mode === 'normal'
          ? {
              requestId: current.requestId,
              turnId: current.input_turn ?? null,
              input_first_chunk: current.input_first_chunk,
              input_last_chunk: current.T0,
              input_commit: current.input_commit,
              provider_response_created: current.response_start ?? null,
              provider_first_audio_delta: current.T4,
              server_first_audio_received: current.T4,
              server_first_audio_sent: current.T5,
              simulator_first_audio_received: current.T6,
              simulator_playback_scheduled: current.simulator_playback_scheduled,
              simulator_playback_started: current.T7,
              response_done: current.response_done ?? null,
              output_playback_completed: current.output_playback_completed ?? null,
              provider_remote_received_input: null,
              provider_remote_first_audio: null,
            }
          : null
      current.provider_TTFA_v45 = mode === 'normal' ? difference(current.T4, current.response_start) : null
      current.response_latency_v45 = mode === 'normal' ? difference(current.response_done, current.T0) : null
      current.playback_completion_latency = difference(current.output_playback_completed, current.T0)
      current.output_queue_bytes = peer.output.bytes
      current.buffered_bytes = sim.realtime.buffer.bytes
      current.provider_connection_attempts = upstreamConnections
      current.reconnect_count = sim.realtime.metrics.reconnectCount
      current.protocol_errors = sim.realtime.metrics.protocolErrors
      delete current.cancelled_response_id
      console.log(JSON.stringify(current))
      if (current.error) {
        process.exitCode = 1
        break
      }
    }
  } catch (error) {
    const code = safeError(error)
    if (current) {
      current.queue = peer?.output?.snapshot() ?? null
      current.output_queue_bytes = peer?.output?.bytes ?? null
      current.provider_connection_attempts = upstreamConnections
      current.session_error = sim.realtime.lastError ?? null
      current.error ??= code
      console.log(JSON.stringify(current))
    } else console.log(JSON.stringify({ evidence: 'LINUX_REAL_API', error: code, mode }))
    process.exitCode = 1
  } finally {
    await sim.close()
  }
  return records

  async function upload(path, secondary = false) {
    const wav = openWav(path)
    const size = chunkMs * 32
    const manual = provider.config.vad === 'manual'
    const total = Math.ceil(wav.length / size) * size + (manual ? 0 : 2000 * 32)
    try {
      for (let offset = 0; offset < total; offset += size) {
        if (!secondary && current.stop_initial_upload) return
        if (!sim.audioInput.onChunk || current.error) throw Object.assign(new Error(), { code: 'INPUT_STOPPED' })
        const pcm = Buffer.alloc(size)
        if (offset < wav.length) {
          const length = Math.min(size, wav.length - offset)
          if (readSync(wav.fd, pcm, 0, length, wav.offset + offset) !== length) throw new Error('WAV_READ_FAILED')
        }
        if (!secondary && offset === 0) stamp('input_first_chunk')
        if (!secondary && offset < wav.length && offset + size >= wav.length) {
          current.T0 = now()
          current.last_speech_sequence = (sim.realtime.inputTurn?.sequence ?? 0) + 1
          current.input_turn = sim.realtime.inputTurn?.id ?? sim.realtime.turnCounter + 1
        }
        current.transport_input_last_chunk = now()
        sim.audioInput.onChunk(arrayBuffer(pcm))
        if (offset < wav.length && offset + size >= wav.length)
          completion.expect(sim.realtime.sessionId, sim.realtime.inputTurn?.id ?? sim.realtime.turnCounter)
        await wait(chunkMs)
      }
      batch.flush()
      if (manual) sim.realtime.commitInput()
    } finally {
      closeSync(wav.fd)
    }
  }
}
function difference(a, b) {
  return a == null || b == null ? null : a - b
}
async function until(check, timeoutMs, progressOptions) {
  const progress = progressOptions ? new ProgressDeadline(progressOptions) : null
  let fingerprint = progressOptions?.read()
  const end = now() + timeoutMs
  while (!check()) {
    if (progress) {
      const value = progressOptions.read()
      if (value !== fingerprint) {
        progress.progress()
        fingerprint = value
      }
      const code = progress.check()
      if (code) throw Object.assign(new Error(), { code })
    } else if (now() >= end) throw Object.assign(new Error(), { code: 'ACCEPTANCE_TIMEOUT' })
    await wait(5)
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  try {
    await loadLocalConfig()
    if (!process.env.APIYI_API_KEY) console.log('REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured')
    else
      await audioAcceptance({
        paths: process.argv.slice(2),
        mode: process.env.ACCEPTANCE_MODE ?? 'normal',
        chunkMs: Number(process.env.ACCEPTANCE_CHUNK_MS ?? 20),
        providerChunkMs: Number(process.env.ACCEPTANCE_PROVIDER_CHUNK_MS ?? 20),
        outputChunkMs: Number(process.env.ACCEPTANCE_OUTPUT_CHUNK_MS ?? 20),
        completionTimeoutMs: Number(process.env.ACCEPTANCE_COMPLETION_TIMEOUT_MS ?? 25000),
      })
  } catch {
    console.error('[Acceptance] CONFIGURATION_FAILED')
    process.exitCode = 1
  }
}
