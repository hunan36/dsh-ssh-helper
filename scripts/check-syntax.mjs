/**
 * Syntax-check every JavaScript file owned by the plugin.
 *
 * Runs as a child process so the failure of one file is reported on its own
 * line and the process exits non-zero.
 *
 * @module scripts/check-syntax
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Collect `.js` / `.mjs` files under one directory (recursive). */
function collect(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) files.push(...collect(full))
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(full)
  }
  return files
}

const files = collect(ROOT).sort()
let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`ok   ${path.relative(ROOT, file)}`)
    continue
  }
  failed += 1
  console.error(`FAIL ${path.relative(ROOT, file)}`)
  if (result.stderr) console.error(result.stderr.trim())
}
if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check`)
  process.exit(1)
}
console.log(`\n${files.length} file(s) passed syntax check`)
