import { AudioBuffer } from 'my-companion/audio-buffer'
import { RealtimeClient } from 'my-companion/realtime-client'
import { realtimeOptions } from 'my-companion/realtime-config'
import { decodeAudio, encodeAudio, fail, parseEvent, validateStart } from 'my-companion/realtime-protocol'

// All clocks/timers/transports/audio are injected; no SDK or Node imports here.
export class RealtimeSession {
  constructor({
    options,
    runtime,
    wifi,
    input,
    output,
    onPhase = () => {},
    onStatus = () => {},
    onTextDelta = () => {},
    onEmotion = () => {},
    onAction = () => {},
    logger = { debug() {}, error() {} },
  }) {
    this.options = realtimeOptions(options)
    this.runtime = runtime
    this.wifi = wifi
    this.input = input
    this.output = output
    this.onPhase = onPhase
    this.onStatus = onStatus
    this.onTextDelta = onTextDelta
    this.onEmotion = onEmotion
    this.onAction = onAction
    this.logger = logger
    this.buffer = new AudioBuffer(this.options.buffer)
    this.timers = new Map()
    this.client = new RealtimeClient(runtime, this.options, {
      open: () => this.guard(() => this.opened()),
      message: (message) => this.guard(() => this.message(message)),
      error: (code) => this.lost(code ?? 'TRANSPORT_ERROR'),
      close: () => this.lost('SOCKET_CLOSED'),
    })
    this.status = 'STOPPED'
    this.phase = 'IDLE'
    this.running = false
    this.disposed = false
    this.playEpoch = 0
    this.lastInterruption = null
    this.lastAudioTrace = null
    this.metrics = this.newMetrics()
  }

  newMetrics() {
    return {
      connectionTime: null,
      firstInputAudioTime: null,
      firstServerResponseTime: null,
      firstOutputAudioTime: null,
      timeToFirstAudio: null,
      audioChunksReceived: 0,
      audioBytesReceived: 0,
      audioChunksSent: 0,
      audioBytesSent: 0,
      interruptionCount: 0,
      reconnectCount: 0,
      droppedChunks: 0,
      protocolErrors: 0,
    }
  }

  later(name, callback, ms) {
    if (!this.running) return
    this.clear(name)
    this.timers.set(
      name,
      this.runtime.timer.set(() => {
        this.timers.delete(name)
        if (this.running) this.guard(callback)
      }, ms),
    )
  }

  clear(name) {
    if (this.timers.has(name)) this.runtime.timer.clear(this.timers.get(name))
    this.timers.delete(name)
  }

  guard(operation) {
    try {
      return operation()
    } catch (error) {
      this.lost(error.code ?? 'REALTIME_ERROR')
    }
  }

  setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase
    this.present(this.onPhase, phase)
  }

  present(callback, value) {
    try {
      callback(value)
    } catch {
      this.logger.error('PRESENTATION_ERROR')
    }
  }

  setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.present(this.onStatus, status)
  }

  start() {
    if (this.disposed) fail('DISPOSED')
    if (this.running) return
    const start = { type: 'session.start', version: 1, deviceId: this.options.deviceId, requestId: 'validation' }
    for (const key of ['personaId', 'voiceId', 'userId']) if (this.options[key]) start[key] = this.options[key]
    validateStart(start)
    this.startMessage = start
    this.metrics = this.newMetrics()
    this.attempts = 0
    this.running = true
    this.unsubscribe = this.wifi.onStatusChanged(() => {
      if (!this.running) return
      if (!this.wifi.isConnected()) this.lost('NETWORK_DISCONNECTED')
      else if (!this.client.transport && this.status !== 'ERROR') this.guard(() => this.connect())
    })
    this.guard(() => this.connect())
  }

  connect() {
    this.clear('reconnect')
    if (!this.running || this.client.transport) return
    if (!this.wifi.isConnected()) {
      this.setStatus('DISCONNECTED')
      if (!this.running) return
      this.setStatus('RECONNECTING')
      this.later('reconnect', () => this.connect(), this.options.reconnect.maxDelayMs)
      return
    }
    this.setStatus(this.attempts ? 'RECONNECTING' : 'CONNECTING')
    if (!this.running) return
    this.connectStarted = this.runtime.now()
    this.requestId = this.runtime.id()
    this.later('connect', () => this.lost('CONNECTION_TIMEOUT'), this.options.connectionTimeoutMs)
    this.client.start()
  }

  opened() {
    this.client.send({ ...this.startMessage, requestId: this.requestId })
  }

  message(data) {
    if (data instanceof ArrayBuffer) return this.receiveAudio(data)
    let event
    try {
      event = parseEvent(data, this.options.maxControlBytes)
    } catch {
      this.metrics.protocolErrors += 1
      // One invalid event is tolerable; repeated invalid data closes the peer.
      this.invalidMessages = (this.invalidMessages ?? 0) + 1
      if (this.invalidMessages >= 3) fail('INVALID_MESSAGE')
      this.logger.error('INVALID_MESSAGE')
      return
    }
    if (event.type === 'error') {
      this.lost(event.code)
      return
    }
    if (event.type === 'session.ready') {
      if (this.status === 'CONNECTED' || event.requestId !== this.requestId) fail('SESSION_MISMATCH')
      this.clear('connect')
      this.sessionId = event.sessionId
      this.lastAudioTrace = null
      this.turnCounter = 0
      this.inputTurn = null
      this.responseTurn = null
      this.invalidMessages = 0
      this.metrics.connectionTime = this.runtime.elapsed(this.connectStarted, this.runtime.now())
      this.setStatus('CONNECTED')
      if (!this.running) return
      // Retry counter resets after a healthy heartbeat, not on a flapping handshake.
      this.pingSequence = 0
      this.pendingPing = null
      this.heartbeat()
      this.input.start((pcm) => this.guard(() => this.pushInput(pcm)))
      if (!this.running) return
      this.setPhase('LISTENING')
      this.logger.debug(`connected session=${this.sessionId}`)
      return
    }
    if (this.status !== 'CONNECTED' || event.sessionId !== this.sessionId) return
    if (event.type === 'session.pong') {
      if (event.sequence === this.pendingPing) {
        this.pendingPing = null
        this.clear('pong')
        this.attempts = 0
      }
      return
    }
    if (event.type === 'input.speech.started') {
      if (event.turnId === this.inputTurn?.id) {
        this.interrupt()
        this.setPhase('LISTENING')
      }
      return
    }
    if (event.type === 'input.speech.stopped') {
      if (event.turnId === this.inputTurn?.id) this.commitInput()
      return
    }
    if (event.turnId !== this.responseTurn?.id) return
    if (this.metrics.firstServerResponseTime === null) this.metrics.firstServerResponseTime = this.runtime.now()
    if (event.type === 'response.text.delta') this.present(this.onTextDelta, event.delta)
    else if (event.type === 'response.begin') {
      if (this.responseTurn.begun) fail('DUPLICATE_RESPONSE')
      this.responseTurn.begun = true
    } else if (event.type === 'response.done') {
      this.responseTurn.done = true
      if (this.responseTurn.trace) this.responseTurn.trace.responseDoneAt = this.runtime.now()
      this.clear('response')
      this.finishPlayback()
    } else if (event.type === 'assistant.emotion') this.present(this.onEmotion, event.emotion)
    else if (event.type === 'assistant.action') this.present(this.onAction, event.action)
  }

  heartbeat() {
    this.later(
      'heartbeat',
      () => {
        if (this.pendingPing === null) {
          this.pendingPing = ++this.pingSequence
          this.control('session.ping', { sequence: this.pendingPing })
          this.later('pong', () => this.lost('HEARTBEAT_TIMEOUT'), this.options.heartbeatTimeoutMs)
        }
        this.heartbeat()
      },
      this.options.heartbeatMs,
    )
  }

  control(type, fields = {}) {
    this.client.send({ type, sessionId: this.sessionId, ...fields })
  }

  beginInput() {
    if (this.status !== 'CONNECTED') fail('NOT_CONNECTED')
    if (this.inputTurn) return
    if (this.turnCounter === 0xffffffff) fail('TURN_LIMIT')
    this.inputTurn = { id: ++this.turnCounter, sequence: 0, lastAt: null }
    this.control('input.begin', { turnId: this.inputTurn.id })
    if (!this.responseTurn) this.setPhase('LISTENING')
    this.logger.debug('input started')
  }

  pushInput(pcm) {
    const deliveredAt = this.runtime.now()
    this.beginInput()
    if (!this.running) return false
    const turn = this.inputTurn
    const frame = encodeAudio(1, turn.id, turn.sequence + 1, pcm, this.options.maxInputChunkBytes)
    turn.firstDeliveredAt ??= deliveredAt
    turn.firstSentAt ??= this.runtime.now()
    this.client.send(frame)
    turn.sequence += 1
    turn.lastAt = this.runtime.now()
    const interrupted = this.lastInterruption
    if (
      interrupted &&
      interrupted.sessionId === this.sessionId &&
      interrupted.turnId !== turn.id &&
      interrupted.inputResumedAt === null
    )
      interrupted.inputResumedAt = turn.lastAt
    if (this.metrics.firstInputAudioTime === null) this.metrics.firstInputAudioTime = turn.lastAt
    this.metrics.audioChunksSent += 1
    this.metrics.audioBytesSent += pcm.byteLength
  }

  commitInput() {
    const turn = this.inputTurn
    if (!turn?.sequence || this.status !== 'CONNECTED') return false
    if (this.responseTurn) this.interrupt()
    this.responseTurn = { id: turn.id, lastInputAt: turn.lastAt, sequence: 0, bytes: 0, begun: false, done: false }
    this.lastAudioTrace = this.responseTurn.trace = {
      clockDomain: 'runtime_monotonic',
      requestId: this.requestId,
      sessionId: this.sessionId,
      turnId: turn.id,
      inputCapturedAt: null,
      inputDeliveredAt: turn.firstDeliveredAt,
      inputSentAt: turn.firstSentAt,
      inputLastSentAt: turn.lastAt,
      serverReceivedAt: null,
      providerReceivedAt: null,
      providerFirstAudioAt: null,
      serverSentAt: null,
      deviceFirstAudioAt: null,
      playbackStartedAt: null,
      acousticOutputAt: null,
      responseDoneAt: null,
      playbackCompletedAt: null,
    }
    this.metrics.timeToFirstAudio = null
    this.inputTurn = null
    this.setPhase('THINKING')
    if (!this.running) return false
    this.control('audio.input.commit', { turnId: turn.id, sequence: turn.sequence })
    this.later('response', () => this.lost('RESPONSE_TIMEOUT'), this.options.responseTimeoutMs)
    return true
  }

  receiveAudio(frame) {
    if (this.status !== 'CONNECTED') return
    const audio = decodeAudio(frame, 2, this.options.maxOutputChunkBytes)
    const turn = this.responseTurn
    if (!turn || audio.turnId !== turn.id || turn.done) {
      this.metrics.droppedChunks += 1
      return
    }
    if (!turn.begun) fail('AUDIO_BEFORE_RESPONSE')
    if (audio.sequence !== turn.sequence + 1) {
      this.metrics.droppedChunks += 1
      // Reliable WebSocket cannot reorder. Do not play a response with a hole.
      if (audio.sequence > turn.sequence + 1) this.interrupt()
      return
    }
    this.buffer.push(audio.pcm)
    turn.sequence = audio.sequence
    turn.bytes += audio.pcm.byteLength
    this.metrics.audioChunksReceived += 1
    this.metrics.audioBytesReceived += audio.pcm.byteLength
    if (turn.sequence === 1) {
      const now = this.runtime.now()
      if (turn.trace) turn.trace.deviceFirstAudioAt = now
      if (this.metrics.firstOutputAudioTime === null) this.metrics.firstOutputAudioTime = now
      if (this.metrics.firstServerResponseTime === null) this.metrics.firstServerResponseTime = now
      this.metrics.timeToFirstAudio = this.runtime.elapsed(turn.lastInputAt, now)
      this.setPhase('SPEAKING')
      this.logger.debug(`first output audio ttfa=${this.metrics.timeToFirstAudio}ms`)
      this.later('jitter', () => this.pump(), this.options.jitterMs)
    } else if (!this.timers.has('jitter')) this.pump()
    this.later('response', () => this.lost('RESPONSE_TIMEOUT'), this.options.responseTimeoutMs)
  }

  pump() {
    if (this.playing || !this.responseTurn) return
    const pcm = this.buffer.shift()
    if (!pcm) return this.finishPlayback()
    this.playing = true
    const epoch = this.playEpoch
    this.later('playback', () => this.lost('PLAYBACK_TIMEOUT'), this.options.playbackTimeoutMs)
    if (this.responseTurn.trace) this.responseTurn.trace.playbackStartedAt ??= this.runtime.now()
    this.output.write(pcm, (error) => {
      if (epoch !== this.playEpoch || !this.running) return
      this.clear('playback')
      if (error) return this.lost('AUDIO_OUTPUT_ERROR')
      this.playing = false
      this.guard(() => this.pump())
    })
  }

  finishPlayback() {
    if (!this.responseTurn?.done || this.playing || this.buffer.length) return
    if (this.responseTurn.trace) this.responseTurn.trace.playbackCompletedAt = this.runtime.now()
    this.logger.debug(`output completed chunks=${this.responseTurn.sequence} bytes=${this.responseTurn.bytes}`)
    this.responseTurn = null
    this.setPhase('IDLE')
  }

  interrupt() {
    if (!this.responseTurn) return false
    const turnId = this.responseTurn.id
    const timing = {
      requestId: this.requestId,
      sessionId: this.sessionId,
      turnId,
      interruptInvokedAt: this.runtime.now(),
      epochInvalidatedAt: null,
      stopInvokedAt: null,
      stopReturnedAt: null,
      bufferClearedAt: null,
      inputResumedAt: null,
    }
    this.lastInterruption = timing
    this.responseTurn = null
    this.clear('response')
    this.clearPlayback(timing)
    this.metrics.interruptionCount += 1
    this.setPhase('INTERRUPTED')
    if (!this.running || this.status !== 'CONNECTED') return true
    this.control('response.cancel', { turnId })
    this.control('audio.output.clear', { turnId })
    this.setPhase('LISTENING')
    this.logger.debug('interrupted')
    return true
  }

  clearPlayback(timing) {
    ++this.playEpoch
    if (timing) timing.epochInvalidatedAt = this.runtime.now()
    this.clear('playback')
    this.clear('jitter')
    this.playing = false
    if (timing) timing.stopInvokedAt = this.runtime.now()
    try {
      this.output.stop()
    } finally {
      if (timing) timing.stopReturnedAt = this.runtime.now()
      this.buffer.clear()
      if (timing) timing.bufferClearedAt = this.runtime.now()
    }
  }

  releaseConnection() {
    for (const name of [...this.timers.keys()]) this.clear(name)
    // Release independent resources even when one native adapter throws.
    for (const release of [() => this.client.stop(), () => this.input.stop(), () => this.clearPlayback()]) {
      try {
        release()
      } catch {
        this.logger.error('RESOURCE_RELEASE_ERROR')
      }
    }
    this.inputTurn = null
    this.responseTurn = null
    this.sessionId = null
    this.setPhase('IDLE')
  }

  lost(code) {
    if (!this.running || this.status === 'ERROR') return
    // Multiple socket callbacks must not spend retry budget twice.
    if (!this.client.transport && this.timers.has('reconnect')) return
    this.lastError = code
    this.releaseConnection()
    this.setStatus('DISCONNECTED')
    if (!this.running) return
    this.logger.error(code)
    const fatal = [
      'INSECURE_TRANSPORT',
      'TIME_UNVERIFIED',
      'WSS_UNAVAILABLE',
      'INVALID_ENDPOINT',
      'DEVICE_UNAUTHORIZED',
      'CREDENTIAL_EXPIRED',
      'NONCE_UNAVAILABLE',
    ]
    if (fatal.includes(code) || this.attempts >= this.options.reconnect.maxAttempts) {
      this.setStatus('ERROR')
      return
    }
    this.setStatus('RECONNECTING')
    this.attempts += 1
    this.metrics.reconnectCount += 1
    const delay = Math.min(
      this.options.reconnect.initialDelayMs * 2 ** (this.attempts - 1),
      this.options.reconnect.maxDelayMs,
    )
    this.logger.debug(`reconnect attempt=${this.attempts}`)
    this.later('reconnect', () => this.connect(), delay)
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.releaseConnection()
    this.setStatus('STOPPED')
  }

  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    for (const resource of [this.client, this.input, this.output]) {
      try {
        resource.dispose()
      } catch {
        this.logger.error('RESOURCE_RELEASE_ERROR')
      }
    }
    this.onPhase = this.onStatus = this.onTextDelta = this.onEmotion = this.onAction = () => {}
  }
}
