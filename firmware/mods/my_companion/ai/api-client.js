import { canRetry, httpError, NetworkError } from 'my-companion/network-errors'
import { parseJSON } from 'my-companion/protocol'

export class ApiClient {
  constructor(options, wifi, runtime, logger, httpLogger) {
    this.options = options
    this.wifi = wifi
    this.runtime = runtime
    this.logger = logger
    this.httpLogger = httpLogger
    this.busy = false
    this.closed = false
    this.cancel = null
    this.sequence = 0
  }

  get(path) {
    return this.request('GET', path)
  }
  post(path, body) {
    return this.request('POST', path, body)
  }

  endpoint(path) {
    try {
      if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || /[\r\n#]/.test(path)) throw 0
      const base = new this.runtime.URL(this.options.baseUrl)
      const url = new this.runtime.URL(path, base.href)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        url.origin !== base.origin
      )
        throw 0
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      // SDK Socket host handling here is IPv4/DNS; do not claim unverified IPv6 support.
      if (!url.hostname || url.hostname.includes(':')) throw 0
      return { host: url.hostname, port, path: url.pathname + url.search, https: url.protocol === 'https:' }
    } catch {
      throw new NetworkError('INVALID_CONFIG')
    }
  }

  async request(method, path, body) {
    if (this.closed) throw new NetworkError('CLOSED')
    if (this.busy) throw new NetworkError('BUSY')
    this.busy = true
    this.sequence = (this.sequence + 1) >>> 0
    const requestId = `req-${this.runtime.now() >>> 0}-${this.sequence}`
    try {
      for (const [value, maximum] of [
        [this.options.timeoutMs, 120000],
        [this.options.maxResponseBytes, 32768],
        [this.options.maxRequestBytes, 32768],
      ]) {
        if (!Number.isInteger(value) || value < 1 || value > maximum) throw new NetworkError('INVALID_CONFIG')
      }
      const retryOptions = this.options.retry
      if (
        retryOptions.enabled &&
        (!Number.isInteger(retryOptions.maxAttempts) ||
          retryOptions.maxAttempts < 1 ||
          retryOptions.maxAttempts > 3 ||
          !Number.isInteger(retryOptions.initialDelayMs) ||
          retryOptions.initialDelayMs < 1 ||
          !Number.isInteger(retryOptions.maxDelayMs) ||
          retryOptions.maxDelayMs < retryOptions.initialDelayMs ||
          retryOptions.maxDelayMs > 60000)
      )
        throw new NetworkError('INVALID_CONFIG')
      const endpoint = this.endpoint(path)
      const headers = ['Accept', 'application/json', 'Accept-Encoding', 'identity', 'X-Request-Id', requestId]
      for (const [name, value] of [
        ['X-Device-Id', this.options.deviceId],
        ['Authorization', this.options.token],
      ]) {
        if (value) {
          if (typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 2048) {
            throw new NetworkError('INVALID_CONFIG')
          }
          headers.push(name, name === 'Authorization' ? `Bearer ${value}` : value)
        }
      }
      let encoded
      if (method === 'POST') {
        try {
          const json = JSON.stringify(body)
          if (typeof json !== 'string' || json.length > this.options.maxRequestBytes) throw 0
          encoded = this.runtime.encode(json)
          if (encoded.byteLength > this.options.maxRequestBytes) throw 0
        } catch {
          throw new NetworkError('INVALID_REQUEST')
        }
        headers.push('Content-Type', 'application/json; charset=utf-8')
      }
      let secureOptions = {}
      if (endpoint.https) {
        let Socket
        try {
          Socket = this.runtime.secureSocket()
        } catch {
          throw new NetworkError('HTTPS_UNAVAILABLE')
        }
        if (!Socket) throw new NetworkError('HTTPS_UNAVAILABLE')
        if (this.runtime.unixTime() < this.options.tls.minUnixTimeMs) throw new NetworkError('CLOCK_NOT_SET')
        secureOptions = { Socket, secure: { verify: true, trace: false, protocolVersion: 0x303 } }
      }
      const retry = this.options.retry
      const attempts = retry.enabled ? Math.max(1, Math.min(3, retry.maxAttempts)) : 1
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (this.closed) throw new NetworkError('CANCELLED')
        this.logger.debug(`${method} requestId=${requestId} attempt=${attempt}`)
        try {
          const result = await this.singleAttempt(
            { ...endpoint, ...secureOptions, method, headers, body: encoded },
            requestId,
          )
          this.logger.debug(`response received requestId=${requestId} bytes=${result.bytes}`)
          return result
        } catch (error) {
          const failure = error instanceof NetworkError ? error : new NetworkError('NETWORK_ERROR')
          failure.requestId = requestId
          failure.attempt = attempt
          this.logger.error(`requestId=${requestId} code=${failure.code} status=${failure.status} attempt=${attempt}`)
          if (attempt === attempts || !canRetry(method, failure) || this.closed) throw failure
          const delay = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** (attempt - 1))
          await this.waitRetry(delay)
        }
      }
    } catch (error) {
      const failure = error instanceof NetworkError ? error : new NetworkError('INVALID_CONFIG')
      if (!failure.requestId) {
        failure.requestId = requestId
        this.logger.error(`requestId=${requestId} code=${failure.code}`)
      }
      throw failure
    } finally {
      this.cancel = null
      this.busy = false
    }
  }

  singleAttempt(options, requestId) {
    if (!this.wifi.isConnected()) return Promise.reject(new NetworkError('NETWORK_DISCONNECTED'))
    const { Request, timer } = this.runtime
    return new Promise((resolve, reject) => {
      let request
      let timeout = null
      let unsubscribe
      let settled = false
      let status = 0
      let bytes = null
      let length = 0
      const finish = (error, data) => {
        if (settled) return
        settled = true
        if (timeout !== null) timer.clear(timeout)
        unsubscribe?.()
        if (this.cancel === cancel) this.cancel = null
        // Close is the SDK's real cancellation API. Never log socket exception text.
        try {
          request?.close()
        } catch {
          this.httpLogger.error('CLOSE_ERROR')
        }
        bytes = null
        if (error) reject(error)
        else resolve({ requestId, status, bytes: length, data })
      }
      const fail = (code) => finish(new NetworkError(code, { status, requestId }))
      const cancel = () => fail('CANCELLED')
      this.cancel = cancel
      try {
        unsubscribe = this.wifi.onStatusChanged(() => {
          if (!this.wifi.isConnected()) fail('NETWORK_DISCONNECTED')
        })
        timeout = timer.set(() => fail('TIMEOUT'), this.options.timeoutMs)
        request = new Request(options)
        // SDK Request does not accept callback in its constructor dictionary.
        request.callback = (message, value, detail) => {
          if (settled) return
          try {
            if (message === Request.status) {
              if (!Number.isInteger(value) || value < 100 || value > 599) {
                fail('HTTP_PROTOCOL_ERROR')
                return
              }
              status = value
              this.httpLogger.debug(`requestId=${requestId} status=${status}`)
              const code = httpError(status)
              if (code) fail(code)
            } else if (message === Request.header) {
              if (value === 'content-length') {
                if (!/^\d+$/.test(detail)) {
                  fail('HTTP_PROTOCOL_ERROR')
                  return
                }
                if (Number(detail) > this.options.maxResponseBytes) fail('RESPONSE_TOO_LARGE')
              } else if (value === 'content-encoding' && detail.toLowerCase() !== 'identity') {
                fail('UNSUPPORTED_ENCODING')
              }
            } else if (message === Request.responseFragment) {
              if (!Number.isInteger(value) || value < 0) {
                fail('HTTP_PROTOCOL_ERROR')
                return
              }
              if (value > this.options.maxResponseBytes - length) {
                fail('RESPONSE_TOO_LARGE')
                return
              }
              if (!bytes) bytes = new Uint8Array(this.options.maxResponseBytes)
              const fragment = new Uint8Array(request.read(ArrayBuffer, value))
              if (fragment.byteLength !== value) {
                fail('HTTP_PROTOCOL_ERROR')
                return
              }
              bytes.set(fragment, length)
              length += fragment.byteLength
            } else if (message === Request.responseComplete) {
              if (!status) {
                fail('HTTP_PROTOCOL_ERROR')
                return
              }
              if (status === 204 && !length) {
                finish(null, null)
                return
              }
              const decoder = new this.runtime.TextDecoder('utf-8', { fatal: true })
              const data = parseJSON(decoder.decode(bytes ? bytes.subarray(0, length) : new Uint8Array(0)))
              finish(null, data)
            } else if (message === Request.error) {
              fail(options.https ? 'TLS_OR_NETWORK_ERROR' : 'NETWORK_ERROR')
            }
          } catch (error) {
            fail(error instanceof NetworkError ? error.code : 'INVALID_RESPONSE')
          }
        }
      } catch {
        fail(options.https ? 'TLS_OR_NETWORK_ERROR' : 'NETWORK_ERROR')
      }
    })
  }

  waitRetry(delay) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.runtime.timer.clear(id)
        reject(new NetworkError('CANCELLED'))
      }
      const id = this.runtime.timer.set(() => {
        if (this.cancel === cancel) this.cancel = null
        resolve()
      }, delay)
      this.cancel = cancel
    })
  }

  close() {
    this.closed = true
    this.cancel?.()
  }
}
