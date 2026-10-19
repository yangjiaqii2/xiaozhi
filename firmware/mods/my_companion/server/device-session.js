import { randomUUID } from 'node:crypto'
import { audioFormat, decodeAudio, identifier, validateStart } from '../ai/realtime-protocol.js'
import { arrayBuffer } from './audio.js'
import { OutputStream } from './output-stream.js'

export class DeviceSession {
  constructor(
    socket,
    identity,
    { providerFactory, tools, log, onClose, maxRetries = 2, retryDelayMs = 250, maxSessionMs = 1800000 },
  ) {
    this.socket = socket
    this.identity = identity
    this.providerFactory = providerFactory
    this.tools = tools
    this.log = (record) => {
      try {
        log(record)
      } catch {}
    }
    this.onClose = onClose
    this.maxRetries = maxRetries
    this.retryDelayMs = retryDelayMs
    this.sessionId = randomUUID()
    this.ready = false
    this.closed = false
    this.lastTurn = 0
    this.metrics = {
      E2E_TTFA: null,
      first_input_time: null,
      first_playable_audio_time: null,
      input_audio_bytes: 0,
      output_audio_bytes: 0,
      reconnect_latency: null,
    }
    this.budget = 64000
    this.budgetAt = performance.now()
    this.abortController = new AbortController()
    this.output = new OutputStream({
      send: (data) => {
        this.send(data)
        this.metrics.first_playable_audio_time ??= performance.now()
        if (this.metrics.E2E_TTFA === null && this.metrics.first_input_time !== null)
          this.metrics.E2E_TTFA = this.metrics.first_playable_audio_time - this.metrics.first_input_time
        this.metrics.output_audio_bytes += data.byteLength - 16
      },
      canSend: (bytes) => !this.closed && this.socket.readyState === 1 && this.socket.bufferedAmount + bytes <= 49152,
      onPressure: (paused) => {
        this.provider?.setOutputPaused?.(paused)
        this.log({
          type: 'output_pressure',
          requestId: this.requestId,
          turnId: this.response?.id ?? null,
          paused,
          queue: this.output?.snapshot() ?? null,
        })
      },
      onDrain: () => this.drained(),
      onError: (code) => this.fail(code),
    })
    this.handshakeTimer = setTimeout(() => this.fail('SESSION_TIMEOUT'), 35000)
    this.lifeTimer = setTimeout(() => this.fail('SESSION_EXPIRED'), maxSessionMs)
    socket.on('message', (bytes, binary) => {
      if (this.closed) return
      try {
        binary ? this.audio(arrayBuffer(bytes)) : this.control(JSON.parse(bytes.toString('utf8')))
      } catch {
        this.fail('INVALID_MESSAGE')
      }
    })
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
  }

  send(value) {
    if (this.closed || this.socket.readyState !== 1 || this.socket.bufferedAmount > 65536)
      throw new Error('DEVICE_BACKPRESSURE')
    this.socket.send(value instanceof ArrayBuffer ? value : JSON.stringify(value), (error) => {
      if (error) this.close()
    })
  }
  event(type, turnId, fields = {}) {
    this.send({ type, sessionId: this.sessionId, ...(turnId ? { turnId } : {}), ...fields })
  }

  control(event) {
    const now = performance.now()
    if (!this.controlRate || now - this.controlRate.start > 1000) this.controlRate = { start: now, count: 0 }
    if (++this.controlRate.count > 100) {
      this.fail('RATE_LIMIT')
      return
    }
    if (event?.type === 'device.config.get') {
      if (this.started || !identifier(event.requestId) || this.configRequested) throw new Error('INVALID_MESSAGE')
      this.configRequested = true
      this.send({
        type: 'device.config',
        requestId: event.requestId,
        config: { deviceId: this.identity.deviceId, persona: {}, features: { voiceChat: true, vision: false } },
      })
      return
    }
    if (event?.type === 'session.start') {
      validateStart(event)
      if (this.started || event.deviceId !== this.identity.deviceId) {
        this.fail('DEVICE_UNAUTHORIZED')
        return
      }
      this.started = true
      this.requestId = event.requestId
      // persona/user hints from the device cannot change authenticated identity.
      void this.connectProvider().catch(() => this.fail('PROVIDER_UNAVAILABLE'))
      return
    }
    if (!this.ready || event?.sessionId !== this.sessionId) throw new Error('INVALID_SESSION')
    if (event.type === 'session.ping') {
      if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error('INVALID_PING')
      this.event('session.pong', null, { sequence: event.sequence })
      return
    }
    if (!Number.isInteger(event.turnId) || event.turnId < 1 || event.turnId > 0xffffffff)
      throw new Error('INVALID_TURN')
    if (event.type === 'input.begin') {
      if (this.input || event.turnId <= this.lastTurn) throw new Error('INVALID_TURN')
      this.lastTurn = event.turnId
      this.input = { id: event.turnId, sequence: 0, committed: false, firstAt: null }
      if (!this.response) {
        this.metrics.first_input_time = null
        this.metrics.first_playable_audio_time = null
        this.metrics.E2E_TTFA = null
      }
    } else if (event.type === 'audio.input.commit') {
      if (event.turnId !== this.input?.id || !this.input.sequence || event.sequence !== this.input.sequence)
        throw new Error('INVALID_COMMIT')
      if (this.provider.config.vad === 'manual') {
        if (this.response) throw new Error('RESPONSE_BUSY')
        this.response = {
          id: this.input.id,
          sequence: 0,
          begun: false,
          done: false,
          toolCount: 0,
          firstAt: this.input.firstAt,
          abort: new AbortController(),
        }
        this.provider.commitInput()
        this.provider.createResponse()
      } else if (!this.input.committed) {
        // Device cannot force an upstream manual commit in automatic VAD mode.
        throw new Error('WAIT_FOR_SERVER_VAD')
      }
      this.input = null
    } else if (event.type === 'response.cancel' || event.type === 'audio.output.clear') {
      if (this.response?.id === event.turnId) this.cancel()
    } else throw new Error('INVALID_MESSAGE')
  }

  audio(frame) {
    if (!this.ready) throw new Error('NOT_READY')
    const packet = decodeAudio(frame, 1, 1280)
    if (!this.input || packet.turnId !== this.input.id || packet.sequence !== this.input.sequence + 1)
      throw new Error('INVALID_SEQUENCE')
    const now = performance.now()
    this.budget = Math.min(64000, this.budget + (now - this.budgetAt) * 32)
    this.budgetAt = now
    if (packet.pcm.byteLength > this.budget) throw new Error('INPUT_RATE_LIMIT')
    this.budget -= packet.pcm.byteLength
    this.input.sequence = packet.sequence
    this.input.firstAt ??= now
    this.metrics.first_input_time ??= now
    this.metrics.input_audio_bytes += packet.pcm.byteLength
    this.provider.sendAudioChunk(Buffer.from(packet.pcm))
  }

  async connectProvider() {
    const started = performance.now()
    for (let attempt = 0; attempt <= this.maxRetries && !this.closed; attempt++) {
      const provider = this.providerFactory(this.identity, (metrics) => {
        if (!this.closed) this.log({ type: 'metrics', provider: metrics, server: { ...this.metrics } })
      })
      this.provider = provider
      this.providerAttempt = attempt + 1
      let code = 'PROVIDER_UNAVAILABLE'
      this.bindProvider(provider, (value) => {
        code = value
      })
      try {
        await provider.connect()
        if (this.closed || provider !== this.provider) {
          provider.close()
          return
        }
        this.ready = true
        clearTimeout(this.handshakeTimer)
        this.metrics.reconnect_latency = attempt ? performance.now() - started : null
        this.event('session.ready', null, { requestId: this.requestId, audio: audioFormat })
        this.log({
          type: 'session_ready',
          model: provider.config.model,
          protocol: provider.config.family,
          attempts: attempt + 1,
        })
        return
      } catch {
        provider.close()
        provider.removeAllListeners()
        provider.on('error', () => {})
        if (this.closed) return
        if (
          ['PROVIDER_AUTH_ERROR', 'APIYI_KEY_MISSING', 'PROVIDER_REJECTED'].includes(code) ||
          attempt === this.maxRetries
        )
          break
        this.log({
          type: 'provider_retry',
          requestId: this.requestId,
          sessionId: this.sessionId,
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs: this.retryDelayMs * 2 ** attempt,
        })
        await new Promise((resolve) => {
          this.retryResolve = resolve
          this.retryTimer = setTimeout(
            () => {
              this.retryResolve = null
              resolve()
            },
            this.retryDelayMs * 2 ** attempt,
          )
        })
      }
    }
    if (!this.closed) this.fail('PROVIDER_UNAVAILABLE')
  }

  bindProvider(provider, connectingError) {
    const safe = (operation) => (event) => {
      if (this.closed || provider !== this.provider) return
      try {
        operation(event)
      } catch (error) {
        const codes = ['OUTPUT_BACKPRESSURE', 'UNASSIGNED_RESPONSE', 'INVALID_TOOL_CALL', 'DEVICE_BACKPRESSURE']
        this.log({
          type: 'protocol_failure',
          code: codes.includes(error?.message) ? error.message : 'PROVIDER_PROTOCOL_ERROR',
        })
        if (error?.details)
          this.log({ type: 'output_pressure_fatal', turnId: this.response?.id ?? null, queue: error.details })
        this.fail(error?.message === 'OUTPUT_BACKPRESSURE' ? 'OUTPUT_CAPACITY_EXCEEDED' : 'PROVIDER_PROTOCOL_ERROR')
      }
    }
    provider.on(
      'error',
      safe(({ code }) => {
        connectingError(code)
        this.log({
          type: 'provider_failure',
          requestId: this.requestId,
          sessionId: this.sessionId,
          turnId: this.response?.id ?? null,
          code: typeof code === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(code) ? code : 'PROVIDER_UNAVAILABLE',
          stage: this.ready ? 'stream' : 'connect',
          attempt: this.providerAttempt,
          queue: this.output.snapshot(),
        })
        if (this.ready) this.fail('PROVIDER_UNAVAILABLE')
      }),
    )
    provider.on(
      'disconnected',
      safe(() => {
        if (this.ready) this.fail('PROVIDER_UNAVAILABLE')
      }),
    )
    provider.on(
      'interrupted',
      safe(({ reason }) =>
        this.log({ type: 'interrupted', reason, interruption_latency: provider.metrics.interruption_latency }),
      ),
    )
    provider.on(
      'speech_started',
      safe(() => {
        if (!this.input) return
        this.event('input.speech.started', this.input.id)
        if (this.response) this.cancel()
      }),
    )
    provider.on(
      'speech_stopped',
      safe(() => {
        if (!this.input || this.input.committed) return
        if (this.response) this.cancel()
        this.input.committed = true
        this.response = {
          id: this.input.id,
          begun: false,
          done: false,
          toolCount: 0,
          firstAt: this.input.firstAt,
          abort: new AbortController(),
        }
        this.event('input.speech.stopped', this.input.id)
      }),
    )
    provider.on(
      'response_started',
      safe(({ responseId }) => {
        if (!this.response) throw new Error('UNASSIGNED_RESPONSE')
        this.response.providerId = responseId
        if (!this.response.begun) {
          this.response.begun = true
          this.metrics.first_input_time = this.response.firstAt
          this.metrics.first_playable_audio_time = this.metrics.E2E_TTFA = null
          this.output.begin(this.response.id)
          this.event('response.begin', this.response.id)
        }
      }),
    )
    provider.on(
      'audio_delta',
      safe(({ responseId, pcm }) => {
        if (this.response?.providerId === responseId) this.output.push(pcm)
      }),
    )
    provider.on(
      'text_delta',
      safe(({ responseId, delta }) => {
        if (this.response?.providerId !== responseId) return
        for (let n = 0; n < delta.length; n += 400)
          this.event('response.text.delta', this.response.id, { delta: delta.slice(n, n + 400) })
      }),
    )
    provider.on(
      'function_call',
      safe((call) => {
        if (this.response?.providerId !== call.responseId || this.pendingTool) throw new Error('INVALID_TOOL_CALL')
        this.pendingTool = call
      }),
    )
    provider.on(
      'response_done',
      safe(({ responseId, status }) => {
        if (this.response?.providerId !== responseId) return
        if (status && !['completed', 'cancelled'].includes(status)) {
          this.fail('PROVIDER_RESPONSE_FAILED')
          return
        }
        if (this.pendingTool) {
          void this.runTool()
          return
        }
        this.response.done = true
        this.drained()
      }),
    )
  }

  async runTool() {
    const turn = this.response
    const call = this.pendingTool
    this.pendingTool = null
    try {
      if (++turn.toolCount > 4) throw new Error('TOOL_LIMIT')
      const output = await this.tools.execute(call.name, call.arguments, turn.abort.signal)
      if (this.closed || this.response !== turn) return
      this.provider.sendFunctionResult(call.callId, output)
      this.provider.createResponse()
    } catch {
      if (!this.closed && this.response === turn) this.fail('TOOL_FAILED')
    }
  }

  drained() {
    if (!this.response?.done || this.output.timer || this.output.bytes) return
    this.event('response.done', this.response.id)
    this.log({
      type: 'stream_completed',
      requestId: this.requestId,
      sessionId: this.sessionId,
      turnId: this.response.id,
      server: { ...this.metrics },
      queue: this.output.snapshot(),
    })
    this.response = null
  }
  cancel() {
    this.output.clear()
    this.response?.abort.abort()
    this.response = null
    this.pendingTool = null
    void this.provider.cancelResponse().catch(() => this.fail('PROVIDER_UNAVAILABLE'))
  }
  fail(code) {
    if (this.closed) return
    const failureQueue = this.output.snapshot()
    try {
      this.event('error', null, { code })
    } catch {}
    if (this.response || this.provider?.activeResponse) {
      this.output.clear()
      void this.provider.cancelResponse().catch(() => {})
    }
    this.log({
      type: 'error',
      code,
      requestId: this.requestId,
      sessionId: this.sessionId,
      turnId: this.response?.id ?? null,
      queue: failureQueue,
    })
    this.close(false)
  }
  close(immediate = true) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.handshakeTimer)
    clearTimeout(this.lifeTimer)
    clearTimeout(this.retryTimer)
    this.retryResolve?.()
    this.retryResolve = null
    this.abortController.abort()
    this.response?.abort.abort()
    this.output.clear()
    this.provider?.close()
    this.provider?.removeAllListeners()
    this.provider?.on('error', () => {})
    if (immediate) this.socket.terminate()
    else this.socket.close(1011, 'SESSION_FAILED')
    this.onClose()
  }
}
