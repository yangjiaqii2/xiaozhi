import WebSocket from 'ws'
import { PCMResampler } from '../../audio.js'
import { newMetrics, numericUsage } from '../../metrics.js'
import { RealtimeProvider } from '../../provider/realtime-provider.js'
import { configFromEnvironment, protocolFor } from './model-config.js'

const failure = (code) => Object.assign(new Error(code), { code })
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128

export class ApiYiRealtimeProvider extends RealtimeProvider {
  #env
  constructor({
    config = configFromEnvironment(),
    env = process.env,
    socketFactory = (url, options) => new WebSocket(url, options),
    connectTimeoutMs = 10000,
    responseTimeoutMs = 30000,
    cancelTimeoutMs = 5000,
    idleMs = 280000,
    onMetrics = () => {},
  } = {}) {
    super()
    this.config = config
    this.protocol = protocolFor(config)
    this.#env = env
    this.socketFactory = socketFactory
    this.timeouts = { connectTimeoutMs, responseTimeoutMs, cancelTimeoutMs, idleMs }
    for (const value of Object.values(this.timeouts))
      if (!Number.isInteger(value) || value < 1 || value > 600000) throw failure('INVALID_PROVIDER_TIMEOUT')
    this.onMetrics = onMetrics
    this.metrics = newMetrics()
    this.resampler = new PCMResampler(16000, config.inputRate)
    this.timers = new Map()
    this.cancelled = new Set()
    this.completedOutputItems = new Set()
    this.cancelEvents = new Set()
    this.eventSequence = 0
    this.closed = false
    this.ready = false
    this.outputPaused = false
    this.configured = false
    this.activeResponse = null
  }

  timer(name, callback, ms) {
    this.clear(name)
    if (this.closed) return
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name)
        callback()
      }, ms),
    )
  }
  clear(name) {
    clearTimeout(this.timers.get(name))
    this.timers.delete(name)
  }
  activity() {
    this.timer('idle', () => this.fail('PROVIDER_IDLE'), this.timeouts.idleMs)
  }

  connect() {
    if (this.closed) return Promise.reject(failure('PROVIDER_CLOSED'))
    if (this.connecting) return this.connecting
    const key = this.#env.APIYI_API_KEY
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) {
      this.emit('error', { code: 'APIYI_KEY_MISSING' })
      return Promise.reject(failure('APIYI_KEY_MISSING'))
    }
    const started = performance.now()
    this.connecting = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.timer('connect', () => this.fail('PROVIDER_CONNECT_TIMEOUT'), this.timeouts.connectTimeoutMs)
    try {
      this.socket = this.socketFactory(
        `wss://api.apiyi.com/v1/realtime?model=${encodeURIComponent(this.config.model)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
          handshakeTimeout: this.timeouts.connectTimeoutMs,
          maxPayload: 512 * 1024,
          maxFragments: 64,
          perMessageDeflate: false,
          followRedirects: false,
          rejectUnauthorized: true,
        },
      )
      this.socket.on('open', () => {
        this.metrics.connection_time = performance.now() - started
        this.activity()
      })
      this.socket.on('message', (bytes, binary) => {
        if (this.closed) return
        try {
          if (binary || bytes.length > 512 * 1024) throw failure('PROVIDER_INVALID_MESSAGE')
          this.message(JSON.parse(bytes.toString('utf8')), started)
        } catch (error) {
          const codes = ['PROVIDER_OVERLAP', 'PROVIDER_INVALID_AUDIO', 'PROVIDER_INVALID_TEXT']
          this.fail('PROVIDER_INVALID_MESSAGE', {
            reason: codes.includes(error?.code) ? error.code : 'INVALID_UPSTREAM_FRAME',
          })
        }
      })
      this.socket.on('unexpected-response', (_request, response) => {
        response.resume()
        this.fail([401, 403].includes(response.statusCode) ? 'PROVIDER_AUTH_ERROR' : 'PROVIDER_UPGRADE_ERROR', {
          httpStatus: Number.isInteger(response.statusCode) ? response.statusCode : null,
        })
      })
      this.socket.on('error', () => this.fail('PROVIDER_NETWORK_ERROR'))
      this.socket.on('close', () => {
        if (!this.closed) this.fail('PROVIDER_DISCONNECTED')
      })
    } catch {
      this.fail('PROVIDER_NETWORK_ERROR')
    }
    return this.connecting
  }

  setOutputPaused(paused) {
    if (this.closed || this.outputPaused === paused) return
    this.outputPaused = paused
    if (paused) this.socket.pause()
    else this.socket.resume()
  }

  send(event) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw failure('PROVIDER_NOT_CONNECTED')
    const text = JSON.stringify(event)
    if (Buffer.byteLength(text) > 65536 || this.socket.bufferedAmount + Buffer.byteLength(text) > 131072)
      throw failure('PROVIDER_BACKPRESSURE')
    this.socket.send(text, (error) => {
      if (error) this.fail('PROVIDER_NETWORK_ERROR')
    })
    this.activity()
  }

  configureSession() {
    if (this.configured) throw failure('PROVIDER_ALREADY_CONFIGURED')
    this.configured = true
    this.send(this.protocol.configure(this.config))
  }

  message(event, started) {
    this.activity()
    // Qwen automatic VAD can deliver output_item.done before speech_started.
    // Retain only bounded response IDs so a later cancel does not await a lost ACK.
    if (event.type === 'response.output_item.done' && event.response_id === this.activeResponse) {
      this.completedOutputItems.add(event.response_id)
      if (this.completedOutputItems.size > 32)
        this.completedOutputItems.delete(this.completedOutputItems.values().next().value)
    }
    if (event.type === 'error') {
      // Automatic VAD may already have cancelled generation. An error linked to
      // our cancel request must not tear down the next turn after its done ack.
      if (this.cancelEvents.has(event.error?.event_id)) return
      if (this.cancelPending) return // bounded by the existing cancel watchdog
      this.fail('PROVIDER_REJECTED')
    } else if (event.type === 'session.created') this.configureSession()
    else if (event.type === 'session.updated') {
      if (!this.configured || this.ready) return
      this.ready = true
      this.clear('connect')
      this.metrics.session_ready_time = performance.now() - started
      this.resolveReady(this)
      this.emit('session_ready', { audio: { inputRate: this.config.inputRate, outputRate: this.config.outputRate } })
    } else if (event.type === 'input_audio_buffer.speech_started')
      this.emit('speech_started', { itemId: event.item_id })
    else if (event.type === 'input_audio_buffer.speech_stopped') this.emit('speech_stopped', { itemId: event.item_id })
    else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (typeof event.delta === 'string' && event.delta.length <= 4096)
        this.emit('input_transcript_delta', { delta: event.delta })
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (typeof event.transcript === 'string' && event.transcript.length <= 16384)
        this.emit('input_transcript_done', { text: event.transcript })
    } else if (event.type === 'response.created') {
      const id = event.response?.id
      if (this.cancelled.has(id)) return
      if (!validId(id) || this.cancelPending || this.activeResponse) throw failure('PROVIDER_OVERLAP')
      this.activeResponse = id
      this.metrics.response_start = performance.now()
      this.metrics.first_text_delta_time = this.metrics.first_audio_delta_time = this.metrics.TTFA = null
      this.metrics.total_response_time = null
      this.timer('response', () => this.fail('PROVIDER_RESPONSE_TIMEOUT'), this.timeouts.responseTimeoutMs)
      this.emit('response_started', { responseId: id })
    } else if (event.type === 'response.output_item.done' && this.cancelPending?.id === event.response_id)
      this.finishCancel('output_item.done')
    else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (
        event.response_id === this.activeResponse &&
        validId(event.item.call_id) &&
        typeof event.item.name === 'string' &&
        event.item.name.length <= 64 &&
        typeof event.item.arguments === 'string' &&
        event.item.arguments.length <= 8192
      )
        this.emit('function_call', {
          responseId: event.response_id,
          callId: event.item.call_id,
          name: event.item.name,
          arguments: event.item.arguments,
        })
    } else if (event.type === 'response.done') {
      const id = event.response?.id
      if (this.cancelPending?.id === id) {
        this.finishCancel('response.done')
        return
      }
      if (!this.activeResponse || id !== this.activeResponse || this.cancelled.has(id)) return
      this.clear('response')
      this.activeResponse = null
      this.metrics.total_response_time = performance.now() - this.metrics.response_start
      this.metrics.usage = numericUsage(event.response?.usage)
      this.emit('response_done', { responseId: id, usage: this.metrics.usage, status: event.response?.status })
      this.onMetrics({ ...this.metrics })
    } else if (
      this.activeResponse &&
      event.response_id === this.activeResponse &&
      !this.cancelled.has(event.response_id)
    ) {
      this.timer('response', () => this.fail('PROVIDER_RESPONSE_TIMEOUT'), this.timeouts.responseTimeoutMs)
      if (event.type === this.protocol.audioDelta) {
        if (
          typeof event.delta !== 'string' ||
          !event.delta.length ||
          event.delta.length > 350000 ||
          event.delta.length % 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)
        )
          throw failure('PROVIDER_INVALID_AUDIO')
        const pcm = Buffer.from(event.delta, 'base64')
        if (!pcm.length || pcm.length % 2 || pcm.length > 256000) throw failure('PROVIDER_INVALID_AUDIO')
        if (this.metrics.first_audio_delta_time === null) {
          this.metrics.first_audio_delta_time = performance.now()
          this.metrics.TTFA = this.metrics.first_audio_delta_time - this.metrics.response_start
        }
        this.metrics.output_audio_bytes += pcm.length
        this.emit('audio_delta', { responseId: event.response_id, pcm })
      } else if ([this.protocol.textDelta, this.protocol.transcriptDelta].includes(event.type)) {
        if (typeof event.delta !== 'string' || event.delta.length > 16384) throw failure('PROVIDER_INVALID_TEXT')
        this.metrics.first_text_delta_time ??= performance.now()
        this.emit('text_delta', { responseId: event.response_id, delta: event.delta })
      }
    }
  }

  sendAudioChunk(pcm) {
    if (!this.ready || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 1280)
      throw failure('PROVIDER_INVALID_INPUT')
    const audio = this.resampler.push(pcm)
    if (audio.length) this.send({ type: 'input_audio_buffer.append', audio: audio.toString('base64') })
    this.metrics.first_input_time ??= performance.now()
    this.metrics.input_audio_bytes += audio.length
  }

  sendText(text) {
    if (!this.ready || typeof text !== 'string' || !text.trim() || text.length > 2048) throw failure('INVALID_TEXT')
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
  }
  commitInput() {
    if (this.config.vad !== 'manual') throw failure('MANUAL_COMMIT_DISABLED')
    this.send({ type: 'input_audio_buffer.commit' })
  }
  createResponse() {
    this.send({ type: 'response.create' })
  }

  cancelResponse() {
    if (this.cancelPending) return this.cancelPending.promise
    if (!this.activeResponse) {
      this.metrics.interruption_latency = null
      this.emit('interrupted', { responseId: null, reason: 'inactive' })
      return Promise.resolve({ reason: 'inactive' })
    }
    const id = this.activeResponse
    this.setOutputPaused(false)
    this.activeResponse = null
    this.cancelled.add(id)
    if (this.cancelled.size > 32) this.cancelled.delete(this.cancelled.values().next().value)
    this.clear('response')
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    this.cancelPending = { id, started: performance.now(), promise, resolve }
    // The old generation is already acknowledged. A new automatic response may
    // already exist remotely; an unscoped cancel here would cancel that new turn.
    if (this.completedOutputItems.has(id)) {
      this.finishCancel('output_item.done_before_cancel')
      return promise
    }
    const eventId = `cancel-${++this.eventSequence}`
    this.cancelEvents.add(eventId)
    if (this.cancelEvents.size > 32) this.cancelEvents.delete(this.cancelEvents.values().next().value)
    this.timer(
      'cancel',
      () => {
        this.finishCancel('timeout')
        // Unknown upstream generation state: reconnect, never mix in a new turn.
        this.fail('PROVIDER_CANCEL_TIMEOUT')
      },
      this.timeouts.cancelTimeoutMs,
    )
    try {
      // Minimal common cancel schema confirmed in Omni docs; response ID stays
      // local for isolation, rather than sending an unconfirmed Omni field.
      this.send({ type: 'response.cancel', event_id: eventId })
    } catch {
      this.fail('PROVIDER_NETWORK_ERROR')
    }
    return promise
  }

  finishCancel(reason) {
    const pending = this.cancelPending
    if (!pending) return
    this.cancelPending = null
    this.clear('cancel')
    this.metrics.interruption_latency =
      reason === 'output_item.done_before_cancel' ? null : performance.now() - pending.started
    pending.resolve({ reason })
    this.emit('interrupted', { responseId: pending.id, reason })
  }

  sendFunctionResult(callId, output) {
    if (!validId(callId) || typeof output !== 'string' || output.length > 8192) throw failure('INVALID_TOOL_RESULT')
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } })
  }

  fail(code, details = {}) {
    if (this.closed) return
    this.lastFailure = { code, ...details }
    this.emit('error', { code })
    this.close()
    this.emit('disconnected', { code })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.ready = false
    for (const name of [...this.timers.keys()]) this.clear(name)
    this.rejectReady?.(failure('PROVIDER_UNAVAILABLE'))
    this.finishCancel('closed')
    const socket = this.socket
    if (socket?.readyState === WebSocket.OPEN && typeof socket.close === 'function') {
      socket.resume()
      socket.close(1000)
      const closing = setTimeout(() => socket.terminate(), 1000)
      closing.unref?.()
      socket.once('close', () => clearTimeout(closing))
    } else socket?.terminate()
    this.resampler.reset()
    this.completedOutputItems.clear()
    this.activeResponse = null
  }
}
