import { encodeAudio } from '../ai/realtime-protocol.js'
import { arrayBuffer } from './audio.js'

const nativeClock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
}

// First frame is immediate. Playback pacing is not a device delivery ACK.
// The PCM cap is unchanged; high/low water marks throttle the upstream socket.
export class OutputStream {
  constructor({
    send,
    onDrain,
    onError,
    maxBytes = 192000,
    chunkBytes = 960,
    canSend = () => true,
    onPressure = () => {},
    clock = nativeClock,
    stallTimeoutMs = 5000,
  }) {
    if (
      !Number.isInteger(chunkBytes) ||
      chunkBytes < 2 ||
      chunkBytes > 1920 ||
      chunkBytes % 2 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < chunkBytes ||
      maxBytes > 192000 ||
      !Number.isInteger(stallTimeoutMs) ||
      stallTimeoutMs < 1 ||
      stallTimeoutMs > 30000
    )
      throw new Error('INVALID_OUTPUT_CHUNK')
    Object.assign(this, { send, onDrain, onError, maxBytes, chunkBytes, canSend, onPressure, clock, stallTimeoutMs })
    this.highWater = Math.min(48000, Math.floor(maxBytes / 2))
    this.lowWater = Math.floor(this.highWater / 2)
    this.pressured = false
    this.queue = []
    this.stats = {
      peakBytes: 0,
      peakFrames: 0,
      pressureCount: 0,
      stalledCount: 0,
      sentBytes: 0,
      producedBytes: 0,
      maxPauseMs: 0,
    }
    this.clear()
  }
  begin(turnId) {
    this.clear()
    this.turnId = turnId
    this.sequence = 0
  }
  snapshot() {
    return {
      ...this.stats,
      bytes: this.bytes,
      frames: this.queue.length,
      backlogMs: this.bytes / 48,
      paused: this.pressured,
    }
  }
  pressure(blocked = false) {
    const wanted = blocked || this.bytes >= this.highWater || (this.pressured && this.bytes > this.lowWater)
    if (wanted === this.pressured) return
    this.pressured = wanted
    if (wanted) {
      this.stats.pressureCount++
      this.pauseAt = this.clock.now()
    } else {
      this.stats.maxPauseMs = Math.max(this.stats.maxPauseMs, this.clock.now() - this.pauseAt)
      this.pauseAt = null
    }
    this.onPressure(wanted)
  }
  push(pcm) {
    if (
      !this.turnId ||
      !Buffer.isBuffer(pcm) ||
      !pcm.length ||
      pcm.length % 2 ||
      this.bytes + pcm.length > this.maxBytes
    ) {
      const error = new Error('OUTPUT_BACKPRESSURE')
      error.details = { ...this.snapshot(), incomingBytes: pcm?.length ?? null }
      throw error
    }
    for (let offset = 0; offset < pcm.length; offset += this.chunkBytes) {
      const piece = pcm.subarray(offset, offset + this.chunkBytes)
      this.queue.push(piece)
      this.bytes += piece.length
    }
    this.stats.producedBytes += pcm.length
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes)
    this.stats.peakFrames = Math.max(this.stats.peakFrames, this.queue.length)
    this.pressure()
    if (this.timer === null) this.pump()
  }
  later(ms) {
    this.timer = this.clock.set(() => this.pump(), ms)
  }
  pump() {
    this.timer = null
    const pcm = this.queue[0]
    if (!pcm) {
      this.stalledAt = null
      this.pressure()
      this.onDrain()
      return
    }
    let blocked = false
    try {
      if (!this.canSend(pcm.length + 16)) blocked = true
      else this.send(encodeAudio(2, this.turnId, this.sequence + 1, arrayBuffer(pcm), 1920))
    } catch (error) {
      if (error.code === 'DEVICE_BACKPRESSURE' || error.message === 'DEVICE_BACKPRESSURE') blocked = true
      else {
        this.clear()
        this.onError('DEVICE_BACKPRESSURE')
        return
      }
    }
    if (blocked) {
      this.stalledAt ??= this.clock.now()
      this.pressure(true)
      if (this.clock.now() - this.stalledAt >= this.stallTimeoutMs) {
        this.stats.stalledCount++
        this.clear()
        this.onError('OUTPUT_CONSUMER_STALLED')
      } else this.later(20)
      return
    }
    this.stalledAt = null
    this.queue.shift()
    this.bytes -= pcm.length
    this.sequence++
    this.stats.sentBytes += pcm.length
    this.pressure()
    // Absolute deadlines avoid accumulating timer rounding/encoding overhead.
    const now = this.clock.now()
    this.nextAt = Math.max(this.nextAt ?? now, now - pcm.length / 48) + pcm.length / 48
    this.later(Math.max(1, this.nextAt - now))
  }
  clear() {
    if (this.timer != null) this.clock.clear(this.timer)
    this.timer = null
    this.queue.length = 0
    this.bytes = 0
    this.turnId = null
    this.sequence = 0
    this.stalledAt = this.nextAt = null
    if (this.pressured) {
      this.stats.maxPauseMs = Math.max(this.stats.maxPauseMs, this.clock.now() - this.pauseAt)
      this.pressured = false
      this.onPressure(false)
    }
    this.pauseAt = null
  }
}
