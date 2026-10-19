export function createLogger(tag, debugEnabled) {
  return {
    debug(message) {
      if (debugEnabled) trace(`[${tag}] ${message}\n`)
    },
    error(message) {
      trace(`[${tag}] ERROR ${message}\n`)
    },
  }
}
