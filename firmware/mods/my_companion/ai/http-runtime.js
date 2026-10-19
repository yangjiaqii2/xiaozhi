import { Request } from 'http'
import Modules from 'modules'
import TextDecoder from 'text/decoder'
import Time from 'time'
import Timer from 'timer'
import URL from 'url'

// No incompatible TLS module is imported statically into the MOD.
export default {
  Request,
  URL,
  TextDecoder,
  timer: Timer,
  now: () => Time.ticks,
  unixTime: () => Date.now(),
  encode: (text) => ArrayBuffer.fromString(text),
  secureSocket() {
    if (!Modules.has('securesocket')) return null
    // SDK modules.c: importNow defaults to XS_IMPORT_DEFAULT, not a namespace.
    return Modules.importNow('securesocket')
  },
}
