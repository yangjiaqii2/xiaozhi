// Node scheduling is isolated here; the ESP32 manifest never includes this module.
export const timer = {
  set: (callback, ms = 0) => setTimeout(callback, ms),
  repeat: (callback, ms) => setInterval(callback, ms),
  clear(id) {
    clearTimeout(id)
    clearInterval(id)
  },
}
export const time = {
  get ticks() {
    return performance.now() >>> 0
  },
  delta: (start, end) => (end - start) >>> 0,
}
