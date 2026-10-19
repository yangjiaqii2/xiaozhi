import { fail } from 'my-companion/realtime-protocol'

// AudioOut constructor is injected by audio-runtime. Only one bounded PCM chunk
// is in the native queue; the session owns its bounded JS jitter buffer.
export class AudioOutput {
  constructor(AudioOut, { maxChunkBytes = 1920 } = {}) {
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 2 || maxChunkBytes > 4096 || maxChunkBytes % 2)
      fail('INVALID_AUDIO_CONFIG')
    this.AudioOut = AudioOut
    this.maxChunkBytes = maxChunkBytes
    this.generation = 0
    this.disposed = false
    this.audio = null
    this.pending = null
    this.lastError = null
    this.completedChunks = 0
  }

  write(pcm, onDone) {
    if (this.disposed) fail('DISPOSED')
    if (this.pending) fail('AUDIO_OUTPUT_BUSY')
    if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > this.maxChunkBytes)
      fail('INVALID_AUDIO_CHUNK')
    try {
      if (!this.audio) {
        const AudioOut = this.AudioOut
        this.audio = new AudioOut({ streams: 1, sampleRate: 24000, numChannels: 1, bitsPerSample: 16 })
        this.audio.enqueue(0, AudioOut.Volume, 256)
        this.audio.callback = (id) => {
          if (id !== this.generation || !this.pending) return
          const callback = this.pending
          this.pending = null
          this.samples = null
          this.completedChunks++
          callback()
        }
      }
      this.samples = new SharedArrayBuffer(pcm.byteLength)
      new Uint8Array(this.samples).set(new Uint8Array(pcm))
      this.pending = onDone
      this.audio.enqueue(0, this.AudioOut.RawSamples, this.samples)
      this.audio.enqueue(0, this.AudioOut.Callback, ++this.generation)
      this.audio.start()
    } catch (error) {
      this.lastError = 'AUDIO_OUTPUT_ERROR'
      try {
        this.stop()
      } catch {
        /* Release as far as the native API permits. */
      }
      throw error
    }
  }

  getDiagnostics() {
    return {
      initialized: this.audio !== null,
      pending: this.pending !== null,
      pendingBytes: this.samples?.byteLength ?? 0,
      completedChunks: this.completedChunks,
      disposed: this.disposed,
      lastError: this.lastError,
    }
  }

  stop() {
    ++this.generation
    const audio = this.audio
    this.audio = null
    this.pending = null
    try {
      if (audio) {
        audio.stop()
        audio.enqueue(0, this.AudioOut.Flush)
      }
    } finally {
      try {
        audio?.close()
      } finally {
        this.samples = null
      }
    }
  }

  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
  }
}
