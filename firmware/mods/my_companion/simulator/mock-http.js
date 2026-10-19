import http from 'node:http'
import { time, timer } from './runtime.js'

export function createMockHTTP() {
  const activeRequests = new Set()
  class Request {
    static status = 1
    static header = 2
    static responseFragment = 4
    static responseComplete = 5
    static error = -2

    constructor(options) {
      // This adapter is a localhost test boundary, never an Internet client.
      if (!['127.0.0.1', 'localhost'].includes(options.host) || options.https || options.Socket) {
        throw new Error('LOOPBACK_HTTP_ONLY')
      }
      this.closed = false
      this.available = null
      activeRequests.add(this)
      try {
        // SDK Request writes these automatically. Node's raw header-array path does not.
        const headers = [...options.headers, 'Host', `${options.host}:${options.port}`, 'Connection', 'close']
        if (options.body) headers.push('Content-Length', String(options.body.byteLength))
        this.request = http.request(
          {
            hostname: options.host,
            port: options.port,
            path: options.path,
            method: options.method,
            headers,
            agent: false,
          },
          (response) => {
            if (this.closed) {
              response.destroy()
              return
            }
            this.response = response
            this.emit(Request.status, response.statusCode)
            for (let i = 0; i < response.rawHeaders.length && !this.closed; i += 2) {
              this.emit(Request.header, response.rawHeaders[i].toLowerCase(), response.rawHeaders[i + 1])
            }
            response.on('data', (chunk) => {
              if (this.closed) return
              this.available = chunk
              this.emit(Request.responseFragment, chunk.byteLength)
              this.available = null
            })
            response.on('end', () => {
              this.emit(Request.responseComplete)
              this.close()
            })
            response.on('error', () => this.fail())
            response.on('aborted', () => this.fail())
          },
        )
        this.request.on('error', () => this.fail())
        // Like SDK Request, callbacks occur after construction and callback assignment.
        this.request.end(options.body ? Buffer.from(options.body) : undefined)
      } catch (error) {
        this.close()
        throw error
      }
    }

    emit(message, ...args) {
      if (!this.closed) this.callback?.(message, ...args)
    }

    read(type, count) {
      if (type !== ArrayBuffer || !this.available || count > this.available.byteLength) throw new Error('INVALID_READ')
      const chunk = this.available.subarray(0, count)
      this.available = this.available.subarray(count)
      return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
    }

    fail() {
      this.emit(Request.error)
      this.close()
    }

    close() {
      if (this.closed) return
      this.closed = true
      this.request?.destroy()
      this.response?.destroy()
      this.available = null
      activeRequests.delete(this)
    }
  }
  return {
    Request,
    timer,
    URL,
    TextDecoder,
    now: () => time.ticks,
    unixTime: () => Date.now(),
    encode: (text) => new TextEncoder().encode(text).buffer,
    secureSocket: () => null,
    activeRequests,
  }
}
