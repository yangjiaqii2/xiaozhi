// A causal linear interpolator for the only conversion required here (16k→24k).
// Fixed one-sample history; no per-turn file/audio accumulation. Output is delayed
// by one input sample so results are independent of packet boundaries.
export class PCMResampler {
  constructor(inputRate, outputRate) {
    if (inputRate !== 16000 || ![16000, 24000].includes(outputRate)) throw new Error('UNSUPPORTED_RESAMPLE')
    this.inputRate = inputRate
    this.outputRate = outputRate
    this.reset()
  }
  reset() {
    this.previous = null
    this.position = 0
  }
  push(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 4096) throw new Error('INVALID_PCM')
    if (this.inputRate === this.outputRate) return pcm
    const output = Buffer.alloc(Math.ceil((pcm.length / 2 + 1) * 1.5) * 2)
    let offset = 0
    for (let index = 0; index < pcm.length; index += 2) {
      const sample = pcm.readInt16LE(index)
      if (this.previous !== null) {
        while (this.position < 3) {
          output.writeInt16LE(Math.round(this.previous + ((sample - this.previous) * this.position) / 3), offset)
          offset += 2
          this.position += 2
        }
        this.position -= 3
      }
      this.previous = sample
    }
    return output.subarray(0, offset)
  }
}

export function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
