import SNTP from 'sntp'
import Time from 'time'
import Timer from 'timer'

// Source: SDK modules/network/sntp/sntp.js. This is NOT authenticated time.
export function createTimeRuntime(host = 'pool.ntp.org') {
  return {
    timer: Timer,
    now: () => Time.ticks,
    elapsed: (start, end) => Time.delta(start, end),
    unixTime: () => Date.now(),
    setTime: (seconds) => Time.set(seconds),
    sync(callback) {
      if (typeof host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new Error('INVALID_TIME_CONFIG')
      let closed = false
      let client
      const close = () => {
        if (closed) return
        closed = true
        client?.close()
        client = null
      }
      client = new SNTP({ host }, (message, seconds) => {
        if (closed) return
        if (message === SNTP.time) {
          // SDK closes itself before notifying time. Do not close its native socket twice.
          closed = true
          client = null
          callback(null, seconds)
        } else if (message === SNTP.error) {
          // failed() closes after this callback returns.
          closed = true
          client = null
          callback('TIME_SYNC_ERROR')
        }
      })
      return { close }
    },
  }
}
