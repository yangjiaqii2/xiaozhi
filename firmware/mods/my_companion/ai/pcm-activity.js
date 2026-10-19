// PCM activity hint only. Does not classify speech, perform turn detection or AEC.
// Fixed 10ms windows at the existing 16k mono S16LE device format; O(1) storage.
export class PCMActivity {
  constructor({ rms = 0.02, range = 0.08, attackMs = 40 } = {}) {
    if (
      !(rms > 0 && rms < 1 && range > 0 && range < 2) ||
      !Number.isInteger(attackMs) ||
      attackMs < 20 ||
      attackMs > 200 ||
      attackMs % 10
    )
      throw new Error('INVALID_ACTIVITY_CONFIG')
    this.threshold = (rms * 32768) ** 2
    this.range = range * 32768
    this.attackWindows = attackMs / 10
    this.reset()
  }
  reset() {
    this.count = this.sum = this.squares = this.run = 0
    this.min = 32768
    this.max = -32768
    this.latched = false
  }
  push(pcm) {
    if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength > 4096 || pcm.byteLength % 2)
      throw new Error('INVALID_AUDIO_CHUNK')
    const view = new DataView(pcm)
    let candidate = false
    let triggered = false
    for (let n = 0; n < pcm.byteLength; n += 2) {
      const value = view.getInt16(n, true)
      this.sum += value
      this.squares += value * value
      this.count++
      this.min = Math.min(this.min, value)
      this.max = Math.max(this.max, value)
      if (this.count !== 160) continue
      const variance = this.squares / 160 - (this.sum / 160) ** 2
      const voiced = variance >= this.threshold && this.max - this.min >= this.range
      this.run = voiced ? Math.min(this.attackWindows, this.run + 1) : 0
      if (this.run === 1) candidate = true
      if (!this.latched && this.run >= this.attackWindows) {
        this.latched = true
        triggered = true
      }
      this.count = this.sum = this.squares = 0
      this.min = 32768
      this.max = -32768
    }
    return { candidate, triggered, run: this.run }
  }
}
