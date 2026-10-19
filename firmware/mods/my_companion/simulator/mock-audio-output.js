export class MockAudioOutput {
  constructor({
    playbackMs,
    write = () => {},
    clock = { now: () => performance.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  } = {}) {
    this.clock = clock
    this.nextAt = null
    this.playbackMs = playbackMs
    this.log = write
    this.playedChunks = 0
    this.playedBytes = 0
    this.stopCount = 0
    this.disposed = false
    this.timer = null
  }

  write(pcm, onDone) {
    if (this.disposed || this.timer !== null) throw new Error('AUDIO_OUTPUT_BUSY')
    this.playedChunks += 1
    this.playedBytes += pcm.byteLength
    const now = this.clock.now()
    const duration = this.playbackMs ?? pcm.byteLength / 48
    // A sample clock does not acquire another full timer delay after each JS callback.
    // Rebase after an underrun; stop always discards the previous playback epoch.
    if (this.nextAt === null || now - this.nextAt >= duration) this.nextAt = now
    this.nextAt += duration
    this.timer = this.clock.set(
      () => {
        this.timer = null
        onDone()
      },
      Math.max(0, this.nextAt - now),
    )
  }

  stop() {
    this.clock.clear(this.timer)
    this.nextAt = null
    this.timer = null
    this.stopCount += 1
  }

  dispose() {
    this.stop()
    this.disposed = true
  }
}
