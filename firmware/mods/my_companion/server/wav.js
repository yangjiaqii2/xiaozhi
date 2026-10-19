import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'
import { MockAudioInput } from '../simulator/mock-audio-input.js'
import { MockAudioOutput } from '../simulator/mock-audio-output.js'
import { arrayBuffer } from './audio.js'

export function wavHeader(bytes, rate = 24000) {
  const out = Buffer.alloc(44)
  out.write('RIFF')
  out.writeUInt32LE(bytes + 36, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(bytes, 40)
  return out
}

export function openWav(path) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < 44 || size > 2 * 1024 * 1024) throw new Error('INVALID_WAV_SIZE')
    const header = Buffer.alloc(Math.min(size, 65536))
    readSync(fd, header, 0, header.length, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE')
      throw new Error('INVALID_WAV')
    let validFormat = false
    for (let n = 12; n + 8 <= header.length; ) {
      const type = header.toString('ascii', n, n + 4)
      const length = header.readUInt32LE(n + 4)
      if (type === 'fmt ') {
        if (
          length < 16 ||
          n + 8 + length > header.length ||
          header.readUInt16LE(n + 8) !== 1 ||
          header.readUInt16LE(n + 10) !== 1 ||
          header.readUInt32LE(n + 12) !== 16000 ||
          header.readUInt16LE(n + 22) !== 16
        )
          throw new Error('WAV_REQUIRES_16K_MONO_PCM16')
        validFormat = true
      }
      if (type === 'data') {
        if (!validFormat || !length || length % 2 || n + 8 + length > size) throw new Error('INVALID_WAV_DATA')
        return { fd, offset: n + 8, length }
      }
      n += 8 + length + (length % 2)
    }
    throw new Error('INVALID_WAV')
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export class WavAudioInput extends MockAudioInput {
  constructor(path) {
    super()
    this.path = path
  }
  validate() {
    const wav = openWav(this.path)
    try {
      if (wav.length > 320000) throw new Error('WAV_TEST_BUDGET_EXCEEDED')
    } finally {
      closeSync(wav.fd)
    }
  }
  async utterance({ silenceMs = 2000, onProgress = () => {} } = {}) {
    if (!this.path) throw new Error('REALTIME_WAV_REQUIRED')
    const wav = openWav(this.path)
    try {
      if (wav.length > 320000 || !Number.isInteger(silenceMs) || silenceMs < 0 || silenceMs > 4000)
        throw new Error('WAV_TEST_BUDGET_EXCEEDED')
      const total = wav.length + Math.ceil(silenceMs / 20) * 640
      for (let offset = 0; offset < total; offset += 640) {
        if (!this.onChunk) return false
        const pcm = Buffer.alloc(640)
        if (offset < wav.length) {
          const size = Math.min(640, wav.length - offset)
          if (readSync(wav.fd, pcm, 0, size, wav.offset + offset) !== size) throw new Error('WAV_READ_FAILED')
        }
        this.onChunk(arrayBuffer(pcm))
        this.chunks += 1
        onProgress()
        if (!this.onChunk) return false
        await new Promise((resolve) => {
          const id = setTimeout(() => {
            this.timers.delete(id)
            resolve()
          }, 20)
          this.timers.set(id, resolve)
        })
      }
      return true
    } finally {
      closeSync(wav.fd)
    }
  }
}

export class WavAudioOutput extends MockAudioOutput {
  constructor(path) {
    super()
    this.fd = openSync(path, 'wx', 0o600)
    this.path = path
    this.bytes = 0
    writeSync(this.fd, wavHeader(0), 0, 44, 0)
  }
  write(pcm, done) {
    if (this.disposed || this.timer !== null) throw new Error('AUDIO_OUTPUT_BUSY')
    if (this.bytes + pcm.byteLength > 10 * 1024 * 1024) throw new Error('OUTPUT_FILE_LIMIT')
    writeSync(this.fd, Buffer.from(pcm), 0, pcm.byteLength, 44 + this.bytes)
    this.bytes += pcm.byteLength
    writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0)
    super.write(pcm, done)
  }
  stop() {
    super.stop()
    if (this.fd !== null) writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0)
  }
  dispose() {
    if (this.disposed) return
    super.dispose()
    closeSync(this.fd)
    this.fd = null
  }
}
