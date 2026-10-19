import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('the production manifest cannot package desktop runtime or test modules', async () => {
  const root = new URL('../../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
  for (const source of Object.values(manifest.modules).flat()) {
    const resolved = await realpath(new URL(`${source}.js`, root))
    const code = await readFile(resolved, 'utf8')
    assert(!/\bfrom\s+['"](?:node:|[^'"]*simulator\/)/.test(code), `${resolved} imports a desktop runtime`)
    for (const directory of ['simulator', 'tests', 'server']) {
      const boundary = fileURLToPath(new URL(`${directory}/`, root))
      const relative = path.relative(boundary, resolved)
      assert(
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        `${resolved} must remain outside ${directory}`,
      )
    }
  }
})
