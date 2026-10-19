export class Clock {
  time = 0
  sequence = 0
  tasks = new Map()
  set = (callback, delay = 0, repeat = 0) => {
    const id = ++this.sequence
    this.tasks.set(id, { callback, at: this.time + delay, repeat })
    return id
  }
  repeat = (callback, delay) => this.set(callback, delay, delay)
  clear = (id) => this.tasks.delete(id)
  now = () => this.time
  elapsed = (start, end) => end - start
  advance(ms) {
    const until = this.time + ms
    for (;;) {
      let next
      for (const entry of this.tasks) {
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry
      }
      if (!next) break
      const [id, task] = next
      this.time = task.at
      if (task.repeat) task.at += task.repeat
      else this.tasks.delete(id)
      task.callback(id)
    }
    this.time = until
  }
}

export const logger = { debug() {}, error() {} }
export const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

export function httpRuntime(clock, scripts) {
  const requests = []
  class Request {
    static status = 1
    static header = 2
    static headersComplete = 3
    static responseFragment = 4
    static responseComplete = 5
    static error = -2
    constructor(options) {
      this.options = options
      this.closed = false
      requests.push(this)
      const script = scripts.shift()
      this.readyTimer = clock.set(() => {
        if (!this.closed) script?.(this)
      }, 0)
    }
    emit(message, ...args) {
      if (!this.closed) this.callback(message, ...args)
    }
    fragment(bytes) {
      this.bytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      this.emit(Request.responseFragment, this.bytes.byteLength)
    }
    read(type, count) {
      if (type !== ArrayBuffer || count > this.bytes.byteLength) throw new Error('invalid SDK read contract')
      return this.bytes.slice(0, count).buffer
    }
    close() {
      this.closed = true
      clock.clear(this.readyTimer)
    }
  }
  return {
    Request,
    timer: clock,
    now: clock.now,
    URL,
    TextDecoder,
    encode: (text) => new TextEncoder().encode(text).buffer,
    secureSocket: () => null,
    unixTime: () => Date.now(),
    requests,
  }
}

export function response(status, body = '{"deviceId":"robot-001"}') {
  return (request) => {
    request.emit(1, status)
    if (!request.closed) request.fragment(body)
    request.emit(5)
  }
}
