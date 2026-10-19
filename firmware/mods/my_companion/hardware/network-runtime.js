import { getNetworkConnection, startNetworkConnection, stopNetworkConnection } from 'network-manager'
import { NetworkConnectionState } from 'network-state'
import { readStoredWiFiPreference } from 'stored-wifi'
import Time from 'time'
import Timer from 'timer'

// The only Wi-Fi platform adapter. Credentials stay in the host preference store.
export default {
  get: getNetworkConnection,
  start: startNetworkConnection,
  stop: stopNetworkConnection,
  states: NetworkConnectionState,
  credentials: () => ({ ssid: readStoredWiFiPreference('ssid'), password: readStoredWiFiPreference('password') }),
  timer: Timer,
  now: () => Time.ticks,
  elapsed: (start, end) => Time.delta(start, end),
}
