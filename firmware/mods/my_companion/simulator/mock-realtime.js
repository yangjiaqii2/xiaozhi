import { audioFormat, decodeAudio, encodeAudio, identifier, uint, validateStart } from '../ai/realtime-protocol.js'
import { acceptWebSocket } from './mock-websocket.js'

export const realtimeScenarios = [
  'normal',
  'invalid-message',
  'large-chunk',
  'sequence-error',
  'buffer-overflow',
  'unknown-emotion',
  'unknown-action',
  'no-ready',
  'no-pong',
  'no-output',
]

// Attaches to the existing MockServer HTTP listener; no second terminal/port.
export class MockRealtimeServer {
  constructor(server, { firstAudioDelayMs = 500, outputIntervalMs = 20, outputChunks = 3, scenario = 'normal' } = {}) {
    for (const value of [firstAudioDelayMs, outputIntervalMs]) {
      if (!Number.isInteger(value) || value < 0 || value > 60000) throw new Error('INVALID_REALTIME_FIXTURE')
    }
    if (
      !Number.isInteger(outputChunks) ||
      outputChunks < 1 ||
      outputChunks > 64 ||
      !realtimeScenarios.includes(scenario)
    )
      throw new Error('INVALID_REALTIME_FIXTURE')
    this.options = { firstAudioDelayMs, outputIntervalMs, outputChunks }
    this.scenario = scenario
    this.server = server
    this.peers = new Set()
    this.serial = 0
    this.stats = {
      connections: 0,
      inputChunks: 0,
      inputBytes: 0,
      outputChunks: 0,
      cancelEvents: 0,
      clearEvents: 0,
      completedTurns: 0,
    }
    this.upgrade = (request, socket, head) => {
      if (this.peers.size >= 4) return socket.destroy()
      const peer = { timers: new Set(), sessionId: null, input: null, response: null }
      peer.wire = acceptWebSocket(
        request,
        socket,
        head,
        (message) => {
          try {
            this.message(peer, message)
          } catch {
            peer.wire?.close()
          }
        },
        () => {
          this.cancel(peer)
          this.peers.delete(peer)
        },
      )
      if (peer.wire) this.peers.add(peer)
    }
    server.on('upgrade', this.upgrade)
  }

  send(peer, value) {
    peer.wire.send(JSON.stringify(value))
  }
  event(peer, type, turnId, fields = {}) {
    this.send(peer, { type, sessionId: peer.sessionId, turnId, ...fields })
  }

  later(peer, callback, ms) {
    const id = setTimeout(() => {
      peer.timers.delete(id)
      callback()
    }, ms)
    peer.timers.add(id)
  }

  cancel(peer) {
    for (const id of peer.timers) clearTimeout(id)
    peer.timers.clear()
    peer.response = null
  }

  message(peer, message) {
    if (message instanceof ArrayBuffer) {
      const audio = decodeAudio(message, 1, 1280)
      if (!peer.sessionId || audio.turnId !== peer.input?.id || audio.sequence !== peer.input.sequence + 1)
        throw new Error('INVALID_INPUT_SEQUENCE')
      peer.input.sequence = audio.sequence
      this.stats.inputChunks += 1
      this.stats.inputBytes += audio.pcm.byteLength
      // Fixture server VAD: activity in the NEXT input turn interrupts output.
      if (audio.sequence === 1) this.event(peer, 'input.speech.started', audio.turnId)
      return
    }
    const event = JSON.parse(message)
    if (event.type === 'session.start') {
      validateStart(event)
      if (peer.sessionId) throw new Error('DUPLICATE_SESSION')
      peer.sessionId = `session-${++this.serial}`
      this.stats.connections += 1
      if (this.scenario !== 'no-ready')
        this.send(peer, {
          type: 'session.ready',
          requestId: event.requestId,
          sessionId: peer.sessionId,
          audio: audioFormat,
        })
      return
    }
    if (!identifier(peer.sessionId) || event.sessionId !== peer.sessionId) throw new Error('INVALID_SESSION')
    if (event.type === 'session.ping') {
      if (!uint(event.sequence)) throw new Error('INVALID_PING')
      if (this.scenario !== 'no-pong')
        this.send(peer, {
          type: 'session.pong',
          sessionId: peer.sessionId,
          sequence: event.sequence,
        })
      return
    }
    if (!uint(event.turnId)) throw new Error('INVALID_TURN')
    if (event.type === 'input.begin') {
      if (peer.input || event.turnId <= (peer.lastTurn ?? 0)) throw new Error('INVALID_TURN')
      peer.lastTurn = event.turnId
      peer.input = { id: event.turnId, sequence: 0 }
    } else if (event.type === 'audio.input.commit') {
      if (!peer.input?.sequence || event.turnId !== peer.input.id || event.sequence !== peer.input.sequence)
        throw new Error('INVALID_COMMIT')
      peer.input = null
      this.respond(peer, event.turnId)
    } else if (event.type === 'response.cancel') {
      this.stats.cancelEvents += 1
      if (peer.response === event.turnId) this.cancel(peer)
    } else if (event.type === 'audio.output.clear') this.stats.clearEvents += 1
    else throw new Error('INVALID_EVENT')
  }

  respond(peer, turnId) {
    this.cancel(peer)
    peer.response = turnId
    this.event(peer, 'response.begin', turnId)
    if (this.scenario === 'invalid-message') peer.wire.send('{broken')
    if (this.scenario === 'no-output') return
    const total = this.scenario === 'buffer-overflow' ? 24 : this.options.outputChunks
    const interval = this.scenario === 'buffer-overflow' ? 0 : this.options.outputIntervalMs
    for (let index = 1; index <= total; index++) {
      this.later(
        peer,
        () => {
          if (peer.response !== turnId) return
          const bytes = this.scenario === 'large-chunk' ? 8192 : 960
          const sequence = this.scenario === 'sequence-error' && index === 2 ? 99 : index
          peer.wire.send(encodeAudio(2, turnId, sequence, new ArrayBuffer(bytes), 8192))
          this.stats.outputChunks += 1
          if (index === 1) {
            this.event(peer, 'assistant.emotion', turnId, {
              emotion: this.scenario === 'unknown-emotion' ? 'xxx' : 'happy',
            })
            this.event(peer, 'assistant.action', turnId, {
              action: this.scenario === 'unknown-action' ? 'xxx' : 'look_around',
            })
          }
          if (index === total) {
            this.event(peer, 'response.done', turnId)
            peer.response = null
            this.stats.completedTurns += 1
          }
        },
        this.options.firstAudioDelayMs + (index - 1) * interval,
      )
    }
  }

  disconnectPeers() {
    for (const peer of this.peers) peer.wire.close()
  }

  close() {
    this.server.off('upgrade', this.upgrade)
    for (const peer of this.peers) {
      this.cancel(peer)
      peer.wire.close()
    }
    this.peers.clear()
  }
}
