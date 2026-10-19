// A byte-level socket double for executing the installed SDK's unmodified http.Request.
// This tests its parser/callback/close contract, not ESP32 TCP or Wi-Fi hardware.
export class Listener {
  constructor() {
    throw new Error('Server sockets are outside this client test')
  }
}

export class Socket {
  static scripts = []
  static instances = []
  static connected = 1
  static readable = 2
  static error = -2
  constructor(options) {
    this.options = options
    this.bytes = new Uint8Array(0)
    this.closed = false
    this.writes = []
    Socket.instances.push(this)
    const script = Socket.scripts.shift()
    queueMicrotask(() => {
      if (this.closed) return
      this.callback(1)
      script(this)
    })
  }
  feed(value) {
    if (this.closed) return
    const incoming = typeof value === 'string' ? new TextEncoder().encode(value) : value
    const combined = new Uint8Array(this.bytes.length + incoming.length)
    combined.set(this.bytes)
    combined.set(incoming, this.bytes.length)
    this.bytes = combined
    this.callback(2, combined.length)
  }
  read(type, count) {
    if (type === undefined) return this.bytes.length
    let length = typeof count === 'number' ? Math.min(count, this.bytes.length) : this.bytes.length
    if (count === '\n') {
      const end = this.bytes.indexOf(10)
      if (end >= 0) length = end + 1
    }
    const value = this.bytes.slice(0, length)
    this.bytes = this.bytes.slice(length)
    if (type === String) return new TextDecoder().decode(value)
    if (type === ArrayBuffer) return value.buffer
    return undefined
  }
  write(...parts) {
    this.writes.push(...parts)
    return 65536
  }
  close() {
    this.closed = true
  }
}
