import { loadLocalConfig } from '../server/local-config-loader.js'
import { environmentOptions } from './config.js'
import { KeyboardInput } from './mock-input.js'
import { RealtimeSimulator } from './realtime-simulator.js'

let simulator
try {
  await loadLocalConfig()
  const provider = process.env.REALTIME_PROVIDER ?? 'mock'
  if (provider === 'apiyi' && !process.env.APIYI_API_KEY) {
    console.log('REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured')
  } else {
    const Simulator =
      provider === 'mock'
        ? RealtimeSimulator
        : provider === 'apiyi'
          ? (await import('./apiyi-simulator.js')).ApiYiSimulator
          : null
    if (!Simulator) throw new Error('UNSUPPORTED_PROVIDER')
    simulator = new Simulator(environmentOptions())
    await simulator.start()
    await new KeyboardInput(simulator).start()
  }
} catch (error) {
  console.error(`[Simulator] ${error.code ?? 'START_FAILED'}`)
  await simulator?.close()
  process.exitCode = 1
}
