import { fail } from 'my-companion/realtime-protocol'

// Wrap the actual host Microphone, not a second competing AudioIn instance.
export class AudioInput {
  constructor(microphone, { maxChunkBytes = 1280, onError = () => {} } = {}) {
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 2 || maxChunkBytes > 4096 || maxChunkBytes % 2)
      fail('INVALID_AUDIO_CONFIG')
    this.microphone = microphone
    this.maxChunkBytes = maxChunkBytes
    this.onError = onError
    this.active = false
    this.disposed = false
    this.lastError = null
    this.format = null
    this.chunks = 0
  }

  start(onChunk) {
    if (this.disposed) fail('DISPOSED')
    if (this.active) return
    const microphone = this.microphone
    if (!microphone) fail('AUDIO_INPUT_UNAVAILABLE')
    if (microphone.recording) fail('AUDIO_INPUT_BUSY')
    this.previous = microphone.onReadable
    this.active = true
    const owner = this
    this.handler = function (size) {
      if (!owner.active) return
      try {
        if (this.sampleRate !== 16000 || this.channels !== 1 || this.bitsPerSample !== 16)
          fail('UNSUPPORTED_AUDIO_FORMAT')
        owner.format ??= { sampleRate: this.sampleRate, channels: this.channels, bitsPerSample: this.bitsPerSample }
        // Callback size is already the mono byte count (SDK deliverAudioIn).
        let remaining = size - (size % 2)
        while (remaining && owner.active) {
          const count = Math.min(remaining, owner.maxChunkBytes)
          const pcm = this.read(count)
          if (!pcm) break
          owner.chunks++
          onChunk(pcm)
          remaining -= count
        }
      } catch (error) {
        owner.lastError = error.code === 'UNSUPPORTED_AUDIO_FORMAT' ? error.code : 'AUDIO_INPUT_ERROR'
        try {
          owner.stop()
        } catch {
          /* Native release failure must not escape a readable callback. */
        }
        owner.onError(owner.lastError)
      }
    }
    microphone.onReadable = this.handler
    try {
      microphone.start()
    } catch (error) {
      this.lastError = 'AUDIO_INPUT_ERROR'
      try {
        this.stop()
      } catch {
        /* Do not replace the initialization error. */
      }
      throw error
    }
  }

  stop() {
    if (!this.active) return
    this.active = false
    if (this.microphone.onReadable === this.handler) this.microphone.onReadable = this.previous
    try {
      this.microphone.stop()
    } finally {
      this.handler = this.previous = null
    }
  }

  getDiagnostics() {
    return {
      active: this.active,
      disposed: this.disposed,
      chunks: this.chunks,
      format: this.format ? { ...this.format } : null,
      lastError: this.lastError,
    }
  }

  dispose() {
    this.stop()
    this.disposed = true
    this.onError = () => {}
  }
}
