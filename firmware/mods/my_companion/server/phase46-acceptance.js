// Explicit paid entry point, never run by npm test. All networking is the real adapter.
import { writeFileSync } from 'node:fs'
import { audioAcceptance } from './acceptance.js'
import { loadLocalConfig } from './local-config-loader.js'
import { Phase46Observer } from './phase46-observer.js'

await loadLocalConfig()
if (!process.env.APIYI_API_KEY) console.log('REAL PROVIDER TEST SKIPPED: APIYI_API_KEY not configured')
else {
  const observer = new Phase46Observer()
  const paths = process.argv.slice(2)
  try {
    await audioAcceptance({
      paths,
      mode: process.env.ACCEPTANCE_MODE ?? 'normal',
      progressDeadline: { idleMs: 30000, budgetMs: 180000 },
      onSimulator: (sim) => observer.attach(sim),
      onTrial: (record) => observer.startTrial(record),
    })
  } finally {
    if (observer.sim) {
      await observer.waitForRelease()
      const result = observer.finish()
      if (process.env.PHASE46_TRACE)
        writeFileSync(process.env.PHASE46_TRACE, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
  }
}
