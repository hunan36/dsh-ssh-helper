/**
 * Unit tests for host/atomic.js, host/accounts.js, host/resources.js and
 * host/history.js: atomic writes, quarantine, CRUD, validation, redaction,
 * legacy import, history caps and output tails.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../host/accounts.js'
import { createJsonFile } from '../host/atomic.js'
import { createHistoryStore } from '../host/history.js'
import { createResourceStore } from '../host/resources.js'

/**
 * Create one temporary directory.
 * @returns {string} absolute path.
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-store-'))
}

/**
 * Remove a temporary directory.
 * @param {string} dir - directory.
 */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** @param {string} file @returns {string} octal mode. */
function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8)
}

test('atomic json file writes, reads and updates', async () => {
  const dir = tempDir()
  try {
    const file = createJsonFile({ dir, filename: 'data.json' })
    assert.equal(file.path, path.join(dir, 'data.json'))
    assert.equal(file.read(), undefined)
    await file.write({ value: 1 })
    assert.deepEqual(file.read(), { value: 1 })
    assert.equal(modeOf(file.path), '600')
    assert.equal(readdirSync(dir).includes('data.json.tmp'), false)

    const result = await file.update((current) => ({ value: current.value + 1 }))
    assert.deepEqual(result, { value: 2 })
    assert.deepEqual(file.read(), { value: 2 })

    await file.update(() => undefined)
    assert.deepEqual(file.read(), { value: 2 })
  } finally {
    cleanup(dir)
  }
})

test('atomic json file serializes concurrent writes and updates', async () => {
  const dir = tempDir()
  try {
    const file = createJsonFile({ dir, filename: 'data.json' })
    await Promise.all([
      file.write({ value: 1 }),
      file.update((current) => ({ value: (current ? current.value : 0) + 1 })),
      file.write({ value: 3 }),
      file.update((current) => ({ value: (current ? current.value : 0) + 10 })),
    ])
    assert.deepEqual(file.read(), { value: 13 })
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0)
  } finally {
    cleanup(dir)
  }
})

test('atomic json file quarantines corrupt JSON', async () => {
  const dir = tempDir()
  try {
    const file = createJsonFile({ dir, filename: 'data.json' })
    writeFileSync(file.path, '{not json', 'utf8')
    assert.equal(file.read(), undefined)
    const quarantined = readdirSync(dir).filter((name) => name.startsWith('data.json.corrupt-'))
    assert.equal(quarantined.length, 1)
    assert.equal(readdirSync(dir).includes('data.json'), false)
  } finally {
    cleanup(dir)
  }
})

test('account store CRUD, redaction, duplicate names and validation', async () => {
  const dir = tempDir()
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  try {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
    const store = createAccountStore({ dir })
    store.load()
    assert.equal(store.dataDir(), dir)
    assert.deepEqual(store.list(), [])
    assert.deepEqual(store.legacyInfo(), { available: false, count: 0 })

    const created = await store.create({
      name: 'Production',
      host: '10.0.0.1',
      port: 2222,
      username: 'root',
      authType: 'password',
      password: 'super-secret-password',
      note: 'primary',
    })
    assert.equal(created.name, 'Production')
    assert.equal(created.port, 2222)
    assert.equal(created.hasPassword, true)
    assert.equal(created.hasKey, false)
    assert.equal('password' in created, false)
    assert.equal('privateKey' in created, false)
    assert.equal(JSON.stringify(store.list()).includes('super-secret-password'), false)
    assert.equal(modeOf(path.join(dir, 'accounts.json')), '600')

    const secret = store.getSecretRecord(created.id)
    assert.equal(secret.password, 'super-secret-password')

    assert.equal(store.get(created.id).name, 'Production')
    assert.equal(store.find('Production').id, created.id)
    assert.equal(store.find('production').id, created.id)
    assert.equal(store.find('Prod').id, created.id)
    assert.equal(store.find(created.id).id, created.id)
    assert.equal(store.find('missing'), undefined)

    await assert.rejects(
      store.create({ name: 'production', host: 'h', username: 'u', authType: 'password', password: 'x' }),
      (error) => error.code === 'conflict',
    )
    await assert.rejects(
      store.create({ host: '', username: 'u', authType: 'password', password: 'x' }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      store.create({ host: 'h', port: 70000, username: 'u', authType: 'password', password: 'x' }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      store.create({ host: 'h', username: 'u', authType: 'password', password: 'x', note: 'a'.repeat(501) }),
      (error) => error.code === 'invalid-input',
    )

    await store.update(created.id, { note: 'updated' })
    const kept = store.getSecretRecord(created.id)
    assert.equal(kept.password, 'super-secret-password')
    assert.equal(kept.note, 'updated')
    assert.equal(store.get(created.id).updatedAt.length > 0, true)

    await assert.rejects(store.update(created.id, { authType: 'key' }), (error) => error.code === 'invalid-input')
    const keyed = await store.update(created.id, { authType: 'key', privateKey: '-----BEGIN KEY-----', passphrase: 'pass' })
    assert.equal(keyed.hasKey, true)
    assert.equal(keyed.hasPassword, false)
    assert.equal(store.getSecretRecord(created.id).password, undefined)
    await store.update(created.id, { note: 'key kept' })
    assert.equal(store.getSecretRecord(created.id).privateKey, '-----BEGIN KEY-----')
    assert.equal(store.getSecretRecord(created.id).passphrase, 'pass')

    const draft = await store.testDraft({ id: created.id, host: '10.0.0.2' })
    assert.equal(draft.privateKey, '-----BEGIN KEY-----')
    assert.equal(draft.id, created.id)

    assert.equal(await store.remove(created.id), true)
    assert.equal(await store.remove(created.id), false)
    assert.deepEqual(store.list(), [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    cleanup(dir)
  }
})

test('account store quarantines a corrupt data file', async () => {
  const dir = tempDir()
  try {
    writeFileSync(path.join(dir, 'accounts.json'), '{broken', 'utf8')
    const store = createAccountStore({ dir })
    store.load()
    assert.deepEqual(store.list(), [])
    const quarantined = readdirSync(dir).filter((name) => name.startsWith('accounts.json.corrupt-'))
    assert.equal(quarantined.length, 1)
  } finally {
    cleanup(dir)
  }
})

test('account store imports legacy ssh-manager data and skips duplicates', async () => {
  const dir = tempDir()
  const home = tempDir()
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_HOME = home
    delete process.env.DSH_PROFILE_DIR
    const legacyDir = path.join(home, 'ssh-manager')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      path.join(legacyDir, 'servers.json'),
      JSON.stringify([
        { id: 'old-1', name: 'Old', host: '10.0.0.9', port: 22, username: 'root', authType: 'password', password: 'legacy-pw' },
        { id: 'old-2', name: 'old', host: '10.0.0.9', port: 22, username: 'root', authType: 'password', password: 'dup' },
        { id: 'old-3', name: 'Keyed', host: '10.0.0.10', username: 'deploy', authType: 'key', privateKey: 'KEY' },
        { id: 'old-4', host: '10.0.0.11', username: 'bad', authType: 'password' },
      ]),
      'utf8',
    )

    const store = createAccountStore({ dir })
    store.load()
    const info = store.legacyInfo()
    assert.equal(info.available, true)
    assert.equal(info.count, 4)
    assert.ok(typeof info.source === 'string' && info.source.endsWith('servers.json'))

    const first = await store.importLegacy()
    assert.deepEqual(first, { imported: 2, skipped: 2, total: 4 })
    assert.equal(store.list().length, 2)
    assert.equal(JSON.stringify(store.list()).includes('legacy-pw'), false)

    const second = await store.importLegacy()
    assert.deepEqual(second, { imported: 0, skipped: 4, total: 4 })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    cleanup(home)
    cleanup(dir)
  }
})

test('resource store validates, saves, filters and marks updates', async () => {
  const dir = tempDir()
  try {
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    accounts.load()
    resources.load()
    const account = await accounts.create({ name: 'Server A', host: 'h', username: 'u', authType: 'password', password: 'pw' })
    const other = await accounts.create({ name: 'Server B', host: 'h2', username: 'u', authType: 'password', password: 'pw' })

    const view = await resources.save({
      name: 'Web API',
      serverId: account.id,
      appDir: '/opt/web-api/',
      updateCommand: 'git pull --ff-only',
      restartCommand: 'systemctl restart web-api',
      backupKeep: 999,
      timeoutSeconds: 1,
      tags: ['prod', ' api ', 'prod', ''],
    })
    assert.equal(view.appDir, '/opt/web-api')
    assert.equal(view.serverName, 'Server A')
    assert.equal(view.backupKeep, 50)
    assert.equal(view.timeoutSeconds, 30)
    assert.deepEqual(view.tags, ['prod', 'api'])
    assert.equal(view.discovered, null)
    assert.equal(JSON.stringify(view).includes('pw'), false)

    const second = await resources.save({ name: 'Admin', serverId: other.id, appDir: '/srv/admin', updateCommand: 'true' })
    assert.equal(resources.list().length, 2)
    assert.equal(resources.list({ server: 'Server A' }).length, 1)
    assert.equal(resources.list({ server: account.id })[0].name, 'Web API')
    assert.equal(resources.find('web').id, view.id)
    assert.equal(resources.find('Server'), undefined)
    assert.equal(resources.find(second.id).id, second.id)
    assert.equal(resources.get('missing'), undefined)

    await assert.rejects(
      resources.save({ name: 'web api', serverId: account.id, appDir: '/opt/x', updateCommand: 'true' }),
      (error) => error.code === 'conflict',
    )
    await assert.rejects(
      resources.save({ name: 'Bad', serverId: 'missing', appDir: '/opt/x', updateCommand: 'true' }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      resources.save({ name: 'Bad', serverId: account.id, appDir: '/etc', updateCommand: 'true' }),
      (error) => error.code === 'invalid-path',
    )
    await assert.rejects(
      resources.save({ name: 'Bad', serverId: account.id, appDir: '/opt/x', updateCommand: '  ' }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      resources.save({ name: 'Bad', serverId: account.id, appDir: '/opt/x', updateCommand: 'true', backupDir: '/opt/x/backups' }),
      (error) => error.code === 'invalid-input',
    )
    await assert.rejects(
      resources.save({ name: 'Bad', serverId: account.id, appDir: '/opt/x', updateCommand: 'true', tags: [1] }),
      (error) => error.code === 'invalid-input',
    )

    const updated = await resources.save({
      id: view.id,
      discovered: { markers: ['.git'], serviceUnits: ['web-api.service'], inspectedAt: '2026-01-01T00:00:00.000Z' },
    })
    assert.equal(updated.name, 'Web API')
    assert.deepEqual(updated.discovered.markers, ['.git'])

    const marked = await resources.markUpdated(view.id, { at: '2026-01-02T00:00:00.000Z', status: 'success', backupPath: '/opt/.ssh-helper-backups/web-api/x.tar.gz' })
    assert.equal(marked.lastUpdateStatus, 'success')
    assert.equal(marked.lastBackupPath, '/opt/.ssh-helper-backups/web-api/x.tar.gz')
    assert.equal(marked.lastUpdateAt, '2026-01-02T00:00:00.000Z')

    assert.equal(modeOf(path.join(dir, 'resources.json')), '600')
    assert.equal(await resources.remove(view.id), true)
    assert.equal(await resources.remove(view.id), false)
  } finally {
    cleanup(dir)
  }
})

test('resource store quarantines corrupt JSON', async () => {
  const dir = tempDir()
  try {
    writeFileSync(path.join(dir, 'resources.json'), '[broken', 'utf8')
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    resources.load()
    assert.deepEqual(resources.list(), [])
    assert.equal(readdirSync(dir).some((name) => name.startsWith('resources.json.corrupt-')), true)
  } finally {
    cleanup(dir)
  }
})

test('history store prepends, caps at 200, clips tails and filters', async () => {
  const dir = tempDir()
  try {
    const history = createHistoryStore({ dir })
    history.load()
    const long = 'x'.repeat(9000)
    for (let index = 0; index < 205; index += 1) {
      await history.append({
        action: index % 2 === 0 ? 'apply' : 'rollback',
        resourceId: `resource-${index % 3}`,
        resourceName: 'res',
        serverId: 'server',
        serverName: 'server',
        appDir: '/opt/res',
        backupPath: `/opt/backup-${index}.tar.gz`,
        status: 'success',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        steps: [
          {
            id: 'update',
            title: 'Update',
            status: 'success',
            exitCode: 0,
            durationMs: 50,
            stdoutTail: long,
            stderrTail: long,
            truncated: true,
          },
        ],
      })
    }
    const all = history.list({ limit: 200 })
    assert.equal(all.length, 200)
    assert.equal(all[0].backupPath, '/opt/backup-204.tar.gz')
    assert.equal(all[0].steps[0].stdoutTail.length, 8192)
    assert.equal(all[0].steps[0].stderrTail.length, 8192)
    assert.equal(history.list({ limit: 5 }).length, 5)
    assert.equal(history.list({ limit: 0 }).length, 1)
    assert.equal(history.list({ resourceId: 'resource-0' }).every((entry) => entry.resourceId === 'resource-0'), true)
    assert.equal(history.get(all[0].id).id, all[0].id)
    assert.equal(history.get('missing'), undefined)
    assert.equal(modeOf(path.join(dir, 'history.json')), '600')
  } finally {
    cleanup(dir)
  }
})

test('history store quarantines corrupt JSON', async () => {
  const dir = tempDir()
  try {
    writeFileSync(path.join(dir, 'history.json'), 'not json at all', 'utf8')
    const history = createHistoryStore({ dir })
    history.load()
    assert.deepEqual(history.list(), [])
    assert.equal(readdirSync(dir).some((name) => name.startsWith('history.json.corrupt-')), true)
  } finally {
    cleanup(dir)
  }
})

test('history store rejects malformed entries without writing', async () => {
  const dir = tempDir()
  try {
    const history = createHistoryStore({ dir })
    await assert.rejects(history.append({ action: 'nope', status: 'success', steps: [] }), (error) => error.code === 'invalid-input')
    assert.deepEqual(history.list(), [])
    assert.equal(readFileSync(path.join(dir, 'history.json'), 'utf8').includes('nope'), false)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      assert.ok(true)
      return
    }
    throw error
  } finally {
    cleanup(dir)
  }
})

test('atomic json file creates the tmp file with 0600 before writing any bytes', async () => {
  const dir = tempDir()
  try {
    const file = createJsonFile({ dir, filename: 'accounts.json' })
    // Spy on the mode at creation time by watching the file appear: the writer
    // must never leave a window in which `<file>.tmp` exists with a looser mode.
    const seen = []
    const tmpPath = `${file.path}.tmp`
    let watching = true
    const watcher = (async () => {
      while (watching) {
        try {
          seen.push(modeOf(tmpPath))
        } catch {
          /* not created yet */
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()
    await file.write({ password: 'super-secret-password' })
    watching = false
    await watcher
    assert.equal(seen.every((mode) => mode === '600'), true, `tmp modes observed: ${seen.join(',')}`)
    assert.equal(modeOf(file.path), '600')
  } finally {
    cleanup(dir)
  }
})

test('atomic json file creates and tightens the plugin data directory', async () => {
  const parent = tempDir()
  const dir = path.join(parent, 'nested', 'ssh-helper')
  try {
    const file = createJsonFile({ dir, filename: 'accounts.json' })
    await file.write({ value: 1 })
    assert.equal(modeOf(dir), '700')
    assert.equal(modeOf(file.path), '600')
  } finally {
    cleanup(parent)
  }
})

test('history store scrubs credential shapes from captured output tails', async () => {
  const dir = tempDir()
  try {
    const history = createHistoryStore({ dir })
    history.load()
    await history.append({
      action: 'apply',
      resourceId: 'resource-1',
      resourceName: 'web-api',
      serverId: 'server-1',
      serverName: 'Prod',
      appDir: '/opt/web-api',
      backupPath: '/opt/.ssh-helper-backups/web-api/x.tar.gz',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      steps: [
        {
          id: 'update',
          title: 'Update',
          status: 'failed',
          exitCode: 1,
          durationMs: 50,
          command: 'export GITHUB_TOKEN=ghp_live_command_value && deploy',
          stdoutTail: '+ set -x trace of a failing CLI\npassword=plaintext-pw\nAPI_KEY: abc123\n--token=xyz789\npasswd: letmein\n',
          stderrTail:
            'fatal: secret: s3cr3t\ntoken = tail-token\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
          truncated: false,
        },
      ],
    })
    const entry = history.list()[0]
    const step = entry.steps[0]
    for (const leaked of ['plaintext-pw', 'abc123', 'xyz789', 'letmein', 's3cr3t', 'tail-token', 'b3BlbnNzaC1rZXktdjEAAAAA']) {
      assert.equal(step.stdoutTail.includes(leaked) || step.stderrTail.includes(leaked), false, `leaked ${leaked}`)
    }
    assert.equal(step.stdoutTail.includes('password=<redacted>'), true)
    assert.equal(step.stdoutTail.includes('API_KEY: <redacted>'), true)
    assert.equal(step.stderrTail.includes('<redacted-private-key>'), true)
    // The command is the audit record: it must stay verbatim.
    assert.equal(step.command, 'export GITHUB_TOKEN=ghp_live_command_value && deploy')
    // …and nothing leaked into the persisted file either.
    const persisted = readFileSync(path.join(dir, 'history.json'), 'utf8')
    assert.equal(persisted.includes('plaintext-pw'), false)
    assert.equal(persisted.includes('b3BlbnNzaC1rZXktdjEAAAAA'), false)
  } finally {
    cleanup(dir)
  }
})
