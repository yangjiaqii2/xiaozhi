// Synthesized PCM fixture, not a microphone or speech recognition implementation.
export class MockAudioInput {
  constructor() {
    this.onChunk = null
    this.timers = new Map()
    this.chunks = 0
    this.disposed = false
  }

  start(onChunk) {
    if (this.disposed) throw new Error('DISPOSED')
    this.onChunk ??= onChunk
  }

  async utterance({ chunks = 4, intervalMs = 20, bytes = 640 } = {}) {
    if (
      !Number.isInteger(chunks) ||
      chunks < 1 ||
      chunks > 100 ||
      !Number.isInteger(intervalMs) ||
      intervalMs < 0 ||
      intervalMs > 1000 ||
      !Number.isInteger(bytes) ||
      bytes < 2 ||
      bytes > 4096 ||
      bytes % 2
    )
      throw new Error('INVALID_AUDIO_FIXTURE')
    for (let n = 0; n < chunks; n++) {
      if (!this.onChunk) return false
      // A small sine-wave fixture makes payload nonempty and repeatable.
      const pcm = new ArrayBuffer(bytes)
      const samples = new DataView(pcm)
      for (let i = 0; i < bytes / 2; i++) samples.setInt16(i * 2, Math.sin(i / 8) * 1000, true)
      this.onChunk(pcm)
      this.chunks += 1
      if (n < chunks - 1)
        await new Promise((resolve) => {
          const id = setTimeout(() => {
            this.timers.delete(id)
            resolve()
          }, intervalMs)
          this.timers.set(id, resolve)
        })
    }
    return Boolean(this.onChunk)
  }

  stop() {
    this.onChunk = null
    for (const [id, resolve] of this.timers) {
      clearTimeout(id)
      resolve()
    }
    this.timers.clear()
  }

  dispose() {
    this.stop()
    this.disposed = true
  }
}
