import { fail } from 'my-companion/realtime-protocol'

// Bounded ring: no growing history, no array.shift() per audio packet.
export class AudioBuffer {
  constructor({ maxBytes, maxChunks }) {
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 2 ||
      maxBytes > 65536 ||
      !Number.isInteger(maxChunks) ||
      maxChunks < 1 ||
      maxChunks > 64
    )
      fail('INVALID_BUFFER_CONFIG')
    this.maxBytes = maxBytes
    this.slots = new Array(maxChunks)
    this.clear()
  }

  push(pcm) {
    if (this.length === this.slots.length || this.bytes + pcm.byteLength > this.maxBytes) fail('BUFFER_OVERFLOW')
    this.slots[(this.head + this.length) % this.slots.length] = pcm
    this.bytes += pcm.byteLength
    this.length += 1
  }

  shift() {
    if (!this.length) return undefined
    const result = this.slots[this.head]
    this.slots[this.head] = undefined
    this.head = (this.head + 1) % this.slots.length
    this.bytes -= result.byteLength
    this.length -= 1
    return result
  }

  clear() {
    this.slots.fill(undefined)
    this.head = 0
    this.length = 0
    this.bytes = 0
  }
}
