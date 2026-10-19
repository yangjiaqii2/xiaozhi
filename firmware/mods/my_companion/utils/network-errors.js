export class NetworkError extends Error {
  constructor(code, details = {}) {
    super(code)
    this.name = 'NetworkError'
    this.code = code
    this.status = details.status ?? 0
    this.requestId = details.requestId ?? ''
    this.attempt = details.attempt ?? 0
  }
}

export function httpError(status) {
  if (status >= 200 && status < 300) return null
  if (status >= 300 && status < 400) return 'REDIRECT'
  if (status === 400) return 'BAD_REQUEST'
  if (status === 401 || status === 403) return 'AUTH_ERROR'
  if (status === 404) return 'NOT_FOUND'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500 && status < 600) return 'SERVER_ERROR'
  if (status >= 400 && status < 500) return 'CLIENT_ERROR'
  return 'HTTP_PROTOCOL_ERROR'
}

export function canRetry(method, error) {
  // A timed-out POST may already have executed on the server. Do not replay it.
  return (
    method === 'GET' &&
    (['NETWORK_ERROR', 'NETWORK_DISCONNECTED', 'TIMEOUT'].includes(error.code) ||
      [502, 503, 504].includes(error.status))
  )
}
