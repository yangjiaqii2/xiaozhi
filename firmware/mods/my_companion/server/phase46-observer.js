// Linux-only bounded acceptance observer. Never stores audio, text or credentials.
export class Phase46Observer {
  constructor() {
    this.turns = new Map()
    this.providers = []
    this.errors = []
    this.trials = []
    this.now = () => performance.now()
  }
  turn(sim, id, sessionId = sim.realtime.sessionId) {
    if (!id || !sessionId) return null
    const key = `${sessionId}:${id}`
    if (!this.turns.has(key)) {
      if (this.turns.size >= 64) throw new Error('METRIC_LIMIT')
      this.turns.set(key, {
        requestId: sim.realtime.requestId,
        sessionId,
        turnId: id,
        trial: this.trials.length,
        firstInputAt: null,
        lastInputAt: null,
        committedAt: null,
        responseCreatedAt: null,
        firstAudioAt: null,
        lastAudioAt: null,
        outputItemDoneAt: null,
        providerDoneAt: null,
        playbackCompletedAt: null,
        firstPlaybackAt: null,
        firstCandidateAt: null,
        detectorEnteredAt: null,
        detectedAt: null,
        stopInvokedAt: null,
        stopReturnedAt: null,
        bufferClearedAt: null,
        cancelSentAt: null,
        cancelWrittenAt: null,
        cancelAcknowledgedAt: null,
        listeningAt: null,
        inputResumedAt: null,
        newInputTurnId: null,
        cancelled: false,
        providerBytes: 0,
        deviceBytes: 0,
        scheduledBytes: 0,
        completedBytes: 0,
        oldLeakBytes: 0,
        lateDroppedBytes: 0,
        queuePeakBytes: 0,
        queuePeakBacklogMs: 0,
        pressureCount: 0,
        usage: null,
        cancelReason: null,
      })
    }
    return this.turns.get(key)
  }
  attach(sim) {
    this.sim = sim
    const rt = sim.realtime
    const hook = (owner, name, handler) => {
      const original = owner[name].bind(owner)
      owner[name] = (...args) => handler(original, ...args)
    }
    sim.voiceOptions.onActivity = (event) => {
      const t = this.turn(sim, event.turnId, event.sessionId)
      if (t)
        Object.assign(t, {
          firstCandidateAt: event.firstCandidateAt,
          detectorEnteredAt: event.detectorEnteredAt,
          detectedAt: event.detectedAt,
        })
    }
    hook(rt, 'pushInput', (original, pcm) => {
      const id = rt.inputTurn?.id ?? rt.turnCounter + 1
      const t = this.turn(sim, id)
      const at = this.now()
      if (t) {
        t.firstInputAt ??= at
        t.lastInputAt = at
      }
      if (
        this.lastInterrupted &&
        this.lastInterrupted.sessionId === rt.sessionId &&
        id !== this.lastInterrupted.turnId
      ) {
        this.lastInterrupted.inputResumedAt ??= at
        this.lastInterrupted.newInputTurnId ??= id
      }
      return original(pcm)
    })
    hook(rt, 'commitInput', (original) => {
      const t = this.turn(sim, rt.inputTurn?.id)
      if (t) {
        t.committedAt = this.now()
        t.trial = this.trials.length
      }
      return original()
    })
    hook(rt, 'interrupt', (original) => {
      const t = this.turn(sim, rt.responseTurn?.id)
      if (!t) return original()
      this.interruptTurn = t
      t.detectedAt ??= this.now()
      t.cancelled = true
      try {
        return original()
      } finally {
        this.lastInterrupted = t
        this.interruptTurn = null
      }
    })
    hook(sim.audioOutput, 'stop', (original) => {
      const t = this.interruptTurn
      if (t) t.stopInvokedAt = this.now()
      try {
        return original()
      } finally {
        if (t) t.stopReturnedAt = this.now()
      }
    })
    hook(rt.buffer, 'clear', (original) => {
      const result = original()
      if (this.interruptTurn) {
        this.interruptTurn.bufferClearedAt = this.now()
        this.interruptTurn.remainingBufferBytes = rt.buffer.bytes
      }
      return result
    })
    hook(rt, 'setPhase', (original, phase) => {
      if (phase === 'LISTENING' && this.interruptTurn) this.interruptTurn.listeningAt = this.now()
      return original(phase)
    })
    hook(rt, 'receiveAudio', (original, frame) => {
      const id = new DataView(frame).getUint32(4)
      const t = this.turn(sim, id)
      const before = rt.metrics.droppedChunks
      const result = original(frame)
      if (t) {
        t.deviceBytes += frame.byteLength - 16
        if (rt.metrics.droppedChunks > before) t.lateDroppedBytes += frame.byteLength - 16
      }
      return result
    })
    hook(sim.audioOutput, 'write', (original, pcm, done) => {
      const t = this.turn(sim, rt.responseTurn?.id)
      if (t) {
        t.firstPlaybackAt ??= this.now()
        t.scheduledBytes += pcm.byteLength
        if (t.cancelled) t.oldLeakBytes += pcm.byteLength
      }
      return original(pcm, (error) => {
        if (t && !t.cancelled && !error) {
          t.lastChunkPlayedAt = this.now()
          t.completedBytes += pcm.byteLength
        }
        done(error)
      })
    })
    hook(rt, 'finishPlayback', (original) => {
      const turn = rt.responseTurn
      const t = this.turn(sim, turn?.id)
      const result = original()
      if (turn?.done && !rt.responseTurn && t) t.playbackCompletedAt = this.now()
      return result
    })
    const factory = sim.aiServer.options.providerFactory
    sim.aiServer.options.providerFactory = (...args) => {
      const provider = factory(...args)
      this.providers.push(provider)
      const peer = [...sim.aiServer.sessions.values()][0]
      const sessionId = peer.sessionId
      const byResponse = new Map()
      const get = (id) => byResponse.get(id) ?? null
      hook(provider, 'message', (original, event, started) => {
        const id = event.response_id ?? event.response?.id
        if (event.type === 'response.created') {
          const t = this.turn(sim, peer.response?.id, sessionId)
          if (t) {
            t.responseCreatedAt = this.now()
            t.providerResponseId = id
            byResponse.set(id, t)
          }
        }
        const t = get(id)
        if (t && event.type === 'response.output_item.done') t.outputItemDoneAt = this.now()
        return original(event, started)
      })
      provider.on('audio_delta', ({ responseId, pcm }) => {
        const t = get(responseId)
        if (t) {
          t.firstAudioAt ??= this.now()
          t.lastAudioAt = this.now()
          t.providerBytes += pcm.length
          t.queuePeakBytes = Math.max(t.queuePeakBytes, peer.output.bytes + pcm.length)
          t.queuePeakBacklogMs = t.queuePeakBytes / 48
        }
      })
      provider.on('response_done', ({ responseId, usage }) => {
        const t = get(responseId)
        if (t) {
          t.providerDoneAt = this.now()
          t.usage = usage
        }
      })
      provider.on('interrupted', ({ responseId, reason }) => {
        const t = get(responseId)
        if (t) {
          t.cancelAcknowledgedAt = this.now()
          t.cancelReason = reason
        }
      })
      provider.on('error', ({ code }) => {
        if (this.errors.length < 32) this.errors.push({ code, at: this.now(), sessionId })
      })
      const socketFactory = provider.socketFactory
      provider.socketFactory = (...params) => {
        const socket = socketFactory(...params)
        hook(socket, 'send', (original, data, ...options) => {
          let t
          try {
            if (typeof data === 'string' && JSON.parse(data).type === 'response.cancel')
              t = get(provider.cancelPending?.id)
          } catch {}
          if (t) t.cancelSentAt = this.now()
          return original(data, ...options)
        })
        return socket
      }
      const previous = peer.output.onPressure
      peer.output.onPressure = (paused) => {
        const t = get(peer.response?.providerId)
        if (paused && t) t.pressureCount++
        return previous(paused)
      }
      return provider
    }
  }
  startTrial(record) {
    this.trials.push({ requestId: record.requestId, sample: record.sample, mode: record.mode })
  }
  async waitForRelease() {
    await Promise.all(
      this.providers.map(
        (provider) =>
          new Promise((resolve) => {
            const socket = provider.socket
            if (!socket || socket.readyState === 3) {
              resolve()
              return
            }
            const done = () => {
              clearTimeout(timer)
              socket.off('close', done)
              resolve()
            }
            const timer = setTimeout(done, 1250)
            socket.once('close', done)
          }),
      ),
    )
  }
  finish() {
    const sim = this.sim
    const rt = sim.realtime
    const resources = {
      sessionTimers: rt.timers.size,
      bufferBytes: rt.buffer.bytes,
      inputHandlerReleased: sim.audioInput.onChunk === null,
      outputTimerReleased: sim.audioOutput.timer === null,
      serverSessions: sim.aiServer.sessions.size,
      providerTimers: this.providers.map((p) => p.timers.size),
      providerClosed: this.providers.every((p) => p.closed),
      providerSocketStates: this.providers.map((p) => p.socket?.readyState ?? null),
      providerListeners: this.providers.map((p) =>
        p.eventNames().reduce((sum, name) => sum + p.listenerCount(name), 0),
      ),
    }
    const turns = [...this.turns.values()]
    const result = {
      schema: 46,
      evidence: 'LINUX_REAL_API',
      model: this.providers[0]?.config.model ?? null,
      activityMode: process.env.REALTIME_ACTIVITY_HINT ?? 'provider',
      trials: this.trials,
      turns,
      errors: this.errors,
      resources,
      providerConnectionAttempts: this.providers.length,
      unobserved: {
        providerInternalDetection: 'UNVERIFIED',
        microphoneCapture: 'UNVERIFIED',
        acousticStop: 'UNVERIFIED',
      },
    }
    this.sim = null
    this.providers = []
    return result
  }
}
