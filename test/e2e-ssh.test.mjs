/**
 * In-process SSH end-to-end tests.
 *
 * Starts a real `ssh2` server on loopback and drives the plugin's SSH client,
 * discovery service and update service against a temporary directory. Covers
 * probe/scan/inspect/plan/apply/rollback and a failed update that must keep its
 * backup without auto-rollback.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../host/accounts.js'
import { createDiscoverService } from '../host/discover.js'
import { createUpdateGate } from '../host/gate.js'
import { createHistoryStore } from '../host/history.js'
import { createResourceStore } from '../host/resources.js'
import { createSshClient } from '../host/ssh.js'
import { createUpdateService } from '../host/update.js'
import { createUploadService } from '../host/upload.js'
import { startFakeSshServer } from './helpers/fake-ssh-server.mjs'

/**
 * Create one deployment directory with project markers.
 * @param {string} appDir - absolute app directory.
 * @param {string} version - initial VERSION contents.
 */
function createApp(appDir, version) {
  mkdirSync(path.join(appDir, 'src'), { recursive: true })
  mkdirSync(path.join(appDir, '.git'))
  writeFileSync(path.join(appDir, 'package.json'), '{"name":"web-api","version":"1.0.0"}\n', 'utf8')
  writeFileSync(path.join(appDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n', 'utf8')
  writeFileSync(path.join(appDir, 'app.jar'), 'fake-jar', 'utf8')
  writeFileSync(path.join(appDir, '.env'), 'TOP_SECRET_VALUE=never-leak-this\n', 'utf8')
  writeFileSync(path.join(appDir, 'VERSION'), `${version}\n`, 'utf8')
}

/**
 * Start the fake SSH server plus all plugin services.
 * @returns {Promise<object>} harness with a cleanup function.
 */
async function createHarness() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-e2e-'))
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const workspace = path.join(root, 'srv')
  mkdirSync(workspace, { recursive: true })
  const appDir = path.join(workspace, 'web-api')
  createApp(appDir, 'v1')

  const server = await startFakeSshServer({ cwd: workspace })
  const accounts = createAccountStore({ dir: dataDir })
  const resources = createResourceStore({ dir: dataDir, accounts })
  const history = createHistoryStore({ dir: dataDir })
  accounts.load()
  resources.load()
  history.load()
  const account = await accounts.create({
    name: 'e2e-server',
    host: '127.0.0.1',
    port: server.port,
    username: 'tester',
    authType: 'password',
    password: 'test-pass',
  })
  const ssh = createSshClient()
  const discover = createDiscoverService({ ssh })
  const update = createUpdateService({ ssh, resources, history })
  const upload = createUploadService({ ssh, accounts, resources, history })
  const gate = createUpdateGate({ update, upload, resources })
  const resource = await resources.save({
    name: 'web-api',
    serverId: account.id,
    appDir,
    updateCommand: "printf 'v2\\n' > VERSION",
    restartCommand: "printf 'restart\\n' >> restart.log",
    verifyCommand: "test -f VERSION",
    backupKeep: 2,
    timeoutSeconds: 60,
    note: 'e2e',
  })

  return {
    root,
    dataDir,
    workspace,
    appDir,
    server,
    accounts,
    resources,
    history,
    ssh,
    discover,
    update,
    upload,
    gate,
    account,
    record: accounts.getSecretRecord(account.id),
    resource,
    cleanup: async () => {
      await server.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('E2E probe, scan and inspect over a real ssh2 server', async () => {
  const harness = await createHarness()
  try {
    const probed = await harness.ssh.probe(harness.record)
    assert.equal(probed.success, true)
    assert.ok(probed.latencyMs >= 0)
    assert.match(probed.output, /(Darwin|Linux)/)

    await assert.rejects(
      harness.ssh.probe({ ...harness.record, password: 'wrong-password' }),
      (error) => error.code === 'auth' && !String(error.message).includes('wrong-password'),
    )

    const scanned = await harness.discover.scan(harness.record, {
      roots: [harness.workspace],
      maxDepth: 3,
      limit: 20,
      timeoutMs: 20_000,
    })
    assert.equal(scanned.server, 'e2e-server')
    assert.equal(scanned.truncated, false)
    assert.ok(scanned.candidates.some((candidate) => candidate.path === harness.appDir), JSON.stringify(scanned.candidates))
    const candidate = scanned.candidates.find((entry) => entry.path === harness.appDir)
    assert.ok(candidate.markers.includes('package.json'))
    assert.ok(candidate.markers.includes('.git'))
    assert.ok(candidate.markers.includes('docker-compose.yml'))

    const inspected = await harness.discover.inspect(harness.record, { path: harness.appDir, timeoutMs: 20_000 })
    assert.equal(inspected.path, harness.appDir)
    assert.equal(inspected.exists, true)
    assert.equal(inspected.writable, true)
    assert.ok(inspected.sizeKB >= 0)
    assert.ok(inspected.markers.includes('.git'))
    assert.ok(inspected.markers.includes('package.json'))
    assert.ok(inspected.markers.includes('docker-compose.yml'))
    assert.ok(inspected.markers.includes('app.jar'))
    assert.ok(inspected.topLevel.some((entry) => entry.name === 'VERSION' && entry.type === 'file' && entry.sizeBytes > 0))
    assert.ok(inspected.physicalPath.length > 0)
    assert.equal(inspected.suggestedUpdateCommand, 'docker compose pull && docker compose up -d --remove-orphans')
    assert.equal(JSON.stringify(inspected).includes('never-leak-this'), false)
    assert.equal(inspected.git !== null, true)

    const missing = await harness.discover.inspect(harness.record, { path: path.join(harness.workspace, 'missing-app'), timeoutMs: 20_000 })
    assert.equal(missing.exists, false)
    assert.equal(missing.writable, false)
    assert.deepEqual(missing.topLevel, [])
  } finally {
    await harness.cleanup()
  }
})

test('E2E plan, approval gate, apply and rollback', async () => {
  const harness = await createHarness()
  try {
    const plan = await harness.update.plan(harness.record, harness.resource, { agentId: 'agent-e2e' })
    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.resourceId, harness.resource.id)
    assert.equal(plan.serverId, harness.account.id)
    assert.equal(plan.appDir, harness.appDir)
    assert.equal(plan.steps[0].id, 'preflight')
    assert.equal(plan.steps.some((step) => step.id === 'backup'), true)
    assert.equal(plan.steps.some((step) => step.id === 'update'), true)
    assert.equal(plan.steps.some((step) => step.id === 'restart'), true)
    assert.equal(plan.steps.some((step) => step.id === 'verify'), true)
    assert.equal(JSON.stringify(plan).includes('test-pass'), false)

    const pending = (exec) => harness.gate(exec, () => 'NEXT')
    const decision = await pending({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'agent-e2e' } })
    assert.equal(decision.kind, 'ask')
    assert.ok(decision.reason.includes('web-api'))
    assert.ok(decision.displayReason.en.length > 0)
    assert.ok(decision.displayReason.zh.length > 0)
    assert.equal(JSON.stringify(decision).includes('test-pass'), false)

    const applied = await harness.update.apply(harness.record, plan.id, 'agent-e2e')
    assert.equal(applied.status, 'success', JSON.stringify({ message: applied.message, steps: applied.steps.map((step) => ({ id: step.id, status: step.status, stderr: step.stderrTail })) }))
    assert.equal(applied.action, 'apply')
    assert.equal(applied.resourceId, harness.resource.id)
    assert.equal(applied.backupPath, plan.backup.file)
    assert.equal(applied.steps.find((step) => step.id === 'backup').status, 'success')
    assert.equal(applied.steps.find((step) => step.id === 'update').status, 'success')
    assert.equal(readFileSync(path.join(harness.appDir, 'VERSION'), 'utf8').trim(), 'v2')
    assert.match(readFileSync(path.join(harness.appDir, 'restart.log'), 'utf8'), /restart/)
    assert.ok(statSync(plan.backup.file).size > 0)
    assert.equal(harness.history.list().length, 1)
    assert.equal(harness.resources.get(harness.resource.id).lastUpdateStatus, 'success')
    assert.equal(JSON.stringify(harness.history.list()).includes('test-pass'), false)

    const rollbackDecision = await pending({ name: 'ssh_helper_update_rollback', arguments: { resource: harness.resource.name }, agent: { id: 'agent-e2e' } })
    assert.equal(rollbackDecision.kind, 'ask')
    assert.ok(rollbackDecision.reason.includes(plan.backup.file))

    const rolledBack = await harness.update.rollback(harness.record, harness.resource.name, { agentId: 'agent-e2e' })
    assert.equal(rolledBack.action, 'rollback')
    assert.equal(rolledBack.status, 'success')
    assert.equal(rolledBack.backupPath, plan.backup.file)
    assert.equal(readFileSync(path.join(harness.appDir, 'VERSION'), 'utf8').trim(), 'v1')
    const previousDirs = readdirSync(harness.workspace).filter((name) => name.startsWith('web-api.ssh-helper-before-rollback-'))
    assert.equal(previousDirs.length, 1)
    assert.equal(harness.history.list().length, 2)
    assert.equal(harness.history.list()[0].action, 'rollback')
  } finally {
    await harness.cleanup()
  }
})

test('E2E failed update keeps its backup and never auto-rolls back', async () => {
  const harness = await createHarness()
  try {
    const badDir = path.join(harness.workspace, 'bad-app')
    createApp(badDir, 'v1')
    const resource = await harness.resources.save({
      name: 'bad-app',
      serverId: harness.account.id,
      appDir: badDir,
      updateCommand: 'exit 7',
      backupKeep: 2,
      timeoutSeconds: 60,
    })
    const plan = await harness.update.plan(harness.record, resource, { agentId: 'agent-e2e' })
    assert.deepEqual(plan.blockers, [])
    const entry = await harness.update.apply(harness.record, plan.id, 'agent-e2e')
    assert.equal(entry.status, 'failed')
    assert.equal(entry.backupPath, plan.backup.file)
    assert.ok(statSync(plan.backup.file).size > 0)
    assert.equal(entry.steps.find((step) => step.id === 'backup').status, 'success')
    assert.equal(entry.steps.find((step) => step.id === 'update').status, 'failed')
    assert.equal(readFileSync(path.join(badDir, 'VERSION'), 'utf8').trim(), 'v1')
    assert.equal(readdirSync(harness.workspace).some((name) => name.startsWith('bad-app.ssh-helper-before-rollback-')), false)
    assert.equal(harness.history.list()[0].status, 'failed')
    assert.equal(harness.resources.get(resource.id).lastUpdateStatus, 'failed')
    assert.equal(JSON.stringify(entry).includes('test-pass'), false)
  } finally {
    await harness.cleanup()
  }
})

test('E2E upload pushes a real file over SFTP and verifies size and SHA-256', async () => {
  const harness = await createHarness()
  try {
    const localFile = path.join(harness.root, 'dist.tgz')
    const payload = 'artifact-payload-'.repeat(2048)
    writeFileSync(localFile, payload, 'utf8')
    const remoteFile = path.join(harness.workspace, 'uploads', 'dist.tgz')

    const target = harness.upload.resolve({
      server: harness.account.id,
      local_path: localFile,
      remote_path: remoteFile,
      resource: harness.resource.id,
      timeout_seconds: 60,
    })
    assert.equal(target.sizeBytes, Buffer.byteLength(payload))
    assert.equal(target.remotePath, remoteFile)
    assert.equal(target.resourceName, 'web-api')

    const decision = await harness.gate(
      {
        name: 'ssh_helper_upload',
        arguments: { server: harness.account.id, local_path: localFile, remote_path: remoteFile, resource: harness.resource.id },
        agent: { id: 'agent-e2e' },
      },
      () => 'NEXT',
    )
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /dist\.tgz/)
    assert.match(decision.displayReason.zh, /批准上传/)

    const entry = await harness.upload.execute(target, { agentId: 'agent-e2e' })
    assert.equal(entry.status, 'success', JSON.stringify(entry))
    assert.equal(entry.action, 'upload')
    assert.equal(entry.steps.find((step) => step.id === 'sftp').status, 'success')
    assert.equal(entry.steps.find((step) => step.id === 'verify').status, 'success')
    assert.equal(readFileSync(remoteFile, 'utf8'), payload)
    assert.equal(statSync(remoteFile).size, Buffer.byteLength(payload))
    assert.equal(harness.history.list()[0].action, 'upload')
    assert.equal(JSON.stringify(entry).includes('test-pass'), false)
  } finally {
    await harness.cleanup()
  }
})

test('E2E upload rejects a missing local file and an invalid remote path', async () => {
  const harness = await createHarness()
  try {
    const localFile = path.join(harness.root, 'sample.tgz')
    writeFileSync(localFile, 'sample', 'utf8')

    assert.throws(
      () => harness.upload.resolve({ server: harness.account.id, local_path: '/nope/missing.tgz', remote_path: '/tmp/x.tgz' }),
      (error) => error.code === 'invalid-input' && /本地文件不存在/.test(error.message),
    )
    assert.throws(
      () => harness.upload.resolve({ server: harness.account.id, local_path: localFile, remote_path: 'relative/path.tgz' }),
      (error) => error.code === 'invalid-path',
    )
    assert.throws(
      () => harness.upload.resolve({ server: 'unknown-server', local_path: localFile, remote_path: '/tmp/x.tgz' }),
      (error) => /未找到账户/.test(error.message),
    )
    // The gate must fall through (never ask) when the request is invalid.
    const next = () => 'NEXT'
    assert.equal(
      await harness.gate({ name: 'ssh_helper_upload', arguments: { server: harness.account.id, local_path: '/nope/missing.tgz', remote_path: '/tmp/x.tgz' } }, next),
      'NEXT',
    )
  } finally {
    await harness.cleanup()
  }
})
