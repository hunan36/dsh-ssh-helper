/**
 * Host-side smoke test.
 *
 * Exercises the stores, shell helpers, discovery parsers, update planner and
 * approval gate without touching the network or the real plugin data directory.
 * Run with `npm run smoke`.
 *
 * @module scripts/smoke-host
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAccountStore } from '../host/accounts.js'
import { buildScanCommand, parseInspectOutput, parseScanOutput } from '../host/discover.js'
import { createUpdateGate } from '../host/gate.js'
import { createHistoryStore } from '../host/history.js'
import { createResourceStore } from '../host/resources.js'
import { backupLayout, shQuote, validateRemotePath } from '../host/shell.js'
import { createUpdateService } from '../host/update.js'

const preflight = [
  '###PATH_EXISTS',
  'yes',
  '###WRITABLE',
  'yes',
  '###PHYSICAL',
  '/opt/smoke-app',
  '###SIZE_KB',
  '128',
  '###TOP',
  '10\tfile\tpackage.json',
  '###MARKERS',
  '.git',
  '###GIT',
  'remote=origin',
  'branch=main',
  'commit=abc',
  'dirty=0',
  '###UNITS',
  'smoke-app.service loaded active running Smoke',
  '###FREE_KB',
  '1048576',
].join('\n')

const ssh = {
  async probe() {
    return { success: true, latencyMs: 1, output: 'Linux smoke' }
  },
  async exec(_record, command) {
    if (command.includes('###PATH_EXISTS')) {
      return { exitCode: 0, signal: null, stdout: preflight, stderr: '', durationMs: 1, truncated: false }
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, truncated: false }
  },
}

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-smoke-'))
try {
  const accounts = createAccountStore({ dir })
  const resources = createResourceStore({ dir, accounts })
  const history = createHistoryStore({ dir })
  accounts.load()
  resources.load()
  history.load()

  const account = await accounts.create({ name: 'smoke', host: '127.0.0.1', username: 'smoke', authType: 'password', password: 'smoke-secret' })
  assert.equal(JSON.stringify(accounts.list()).includes('smoke-secret'), false)
  assert.equal(accounts.find('smoke').id, account.id)

  const resource = await resources.save({
    name: 'smoke-app',
    serverId: account.id,
    appDir: '/opt/smoke-app',
    updateCommand: 'git pull --ff-only',
    restartCommand: 'systemctl restart smoke-app',
    backupKeep: 2,
    timeoutSeconds: 30,
  })
  assert.equal(resource.serverName, 'smoke')
  assert.equal(resources.find('smoke-app').id, resource.id)

  assert.equal(shQuote("a'b"), "'a'\\''b'")
  assert.equal(validateRemotePath('/opt/smoke-app/'), '/opt/smoke-app')
  assert.throws(() => validateRemotePath('/etc'), (error) => error.code === 'invalid-path')
  assert.equal(backupLayout({ appDir: '/opt/smoke-app', name: 'smoke-app', timestamp: 0 }).dir, '/opt/.ssh-helper-backups/smoke-app')
  assert.ok(buildScanCommand({ roots: ['/opt'], maxDepth: 2, limit: 5 }).includes('###FIND'))
  assert.equal(parseScanOutput('###OS\nLinux\n###USER\nroot\n###FIND\n/opt/x/package.json\n').candidates[0].path, '/opt/x')
  assert.equal(parseInspectOutput(preflight).markers.includes('.git'), true)

  const update = createUpdateService({ ssh, resources, history })
  const record = accounts.getSecretRecord(account.id)
  const plan = await update.plan(record, resource, { agentId: 'smoke-agent' })
  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.steps.some((step) => step.id === 'backup'), true)

  const gate = createUpdateGate({ update, resources })
  const decision = await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'smoke-agent' } }, () => 'NEXT')
  assert.equal(decision.kind, 'ask')
  assert.equal(typeof decision.displayReason.zh, 'string')
  assert.equal(JSON.stringify(decision).includes('smoke-secret'), false)
  assert.equal(await gate({ name: 'ssh_helper_accounts', arguments: {} }, () => 'NEXT'), 'NEXT')

  const entry = await update.apply(record, plan.id, 'smoke-agent')
  assert.equal(entry.status, 'success')
  assert.equal(history.list().length, 1)
  assert.equal(entry.backupPath, plan.backup.file)

  console.log('SMOKE OK')
} catch (error) {
  console.error(`SMOKE FAILED: ${error && error.message ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
