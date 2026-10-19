import { spawnSync } from 'node:child_process'
import { diagnosticSnapshot } from '../hardware/diagnostics.js'

// Offline/static report, optionally followed by the existing USB scan. No audio APIs.
const flags = process.argv.slice(2)
if (flags.some((value) => !['--scan', '--require-hardware'].includes(value))) {
  console.error('INVALID_PREFLIGHT_ARGUMENT')
  process.exitCode = 1
} else {
  console.log(
    JSON.stringify(
      {
        evidence: 'LINUX_OFFLINE_STATIC',
        hardwareAcceptance: 'UNVERIFIED',
        audioStarted: false,
        uploadStarted: false,
        checks: diagnosticSnapshot().checks,
      },
      null,
      2,
    ),
  )
  if (flags.includes('--scan')) {
    const result = spawnSync('npm', ['run', 'scan'], {
      cwd: new URL('../../../', import.meta.url),
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 15000,
    })
    if (result.error || result.status !== 0) {
      console.error('DEVICE_SCAN_FAILED')
      process.exitCode = 1
    }
  }
  if (flags.includes('--require-hardware')) process.exitCode = 2
}
