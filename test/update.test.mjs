/**
 * Unit tests for host/update.js and host/gate.js: plan shape/cache/TTL,
 * blockers and warnings, apply success/failure/partial/busy, rollback and the
 * approval gate decisions.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../host/accounts.js'
import { createUpdateGate } from '../host/gate.js'
import { createHistoryStore } from '../host/history.js'
import { createResourceStore } from '../host/resources.js'
import { createUpdateService } from '../host/update.js'

/**
 * Build one inspect/free section payload.
 * @param {object} [options] - fixture overrides.
 * @returns {string} command output.
 */
function preflightOutput(options = {}) {
  const exists = options.exists !== false
  const writable = options.writable !== false
  const physicalPath = Object.hasOwn(options, 'physicalPath') ? options.physicalPath : '/opt/web-api'
  const sizeKB = options.sizeKB === undefined ? 1000 : options.sizeKB
  const markers = options.markers === undefined ? ['.git', 'package.json'] : options.markers
  const git = options.git === undefined ? { remote: 'origin', branch: 'main', commit: 'abc', dirty: false } : options.git
  const units = options.units === undefined ? ['app.service loaded active running App'] : options.units
  const freeKB = options.freeKB === undefined ? 1024 * 1024 : options.freeKB
  const lines = [
    '###PATH_EXISTS',
    exists ? 'yes' : 'no',
    '###WRITABLE',
    writable ? 'yes' : 'no',
    '###PHYSICAL',
    physicalPath,
    '###SIZE_KB',
    String(sizeKB),
    '###TOP',
    '10\tfile\tpackage.json',
    '###MARKERS',
    ...markers,
    '###GIT',
  ]
  if (git) {
    lines.push(`remote=${git.remote}`, `branch=${git.branch}`, `commit=${git.commit}`, `dirty=${git.dirty ? 1 : 0}`)
  }
  lines.push('###UNITS', ...units, '###FREE_KB', String(freeKB), '')
  return lines.join('\n')
}

/**
 * Create a fake ssh client.
 * @param {{ output?: string, handler?: Function }} [options] - fixture and command handler.
 * @returns {object} fake ssh client with a `calls` array.
 */
function fakeSsh(options = {}) {
  const calls = []
  return {
    calls,
    async probe() {
      return { success: true, latencyMs: 3, output: 'Linux' }
    },
    async exec(record, command, execOptions = {}) {
      calls.push({ command, options: execOptions })
      if (command.includes('###PATH_EXISTS')) {
        return { exitCode: 0, signal: null, stdout: options.output === undefined ? preflightOutput() : options.output, stderr: '', durationMs: 1, truncated: false }
      }
      if (typeof options.handler === 'function') {
        const result = await options.handler(command, execOptions)
        if (result !== undefined) return result
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, truncated: false }
    },
  }
}

/**
 * Create stores, an account and a resource.
 * @param {object} ssh - fake ssh client.
 * @param {{ now?: Function, resource?: object }} [options] - overrides.
 * @returns {Promise<object>} test context.
 */
async function setup(ssh, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-update-'))
  const accounts = createAccountStore({ dir })
  const resources = createResourceStore({ dir, accounts })
  const history = createHistoryStore({ dir })
  accounts.load()
  resources.load()
  history.load()
  const account = await accounts.create({
    name: 'Deploy Server',
    host: '10.0.0.1',
    username: 'deploy',
    authType: 'password',
    password: 'top-secret-password',
  })
  const resource = await resources.save(
    options.resource === undefined
      ? {
          name: 'web-api',
          serverId: account.id,
          appDir: '/opt/web-api',
          updateCommand: 'echo update',
          restartCommand: 'echo restart',
          verifyCommand: 'echo verify',
          backupKeep: 3,
          timeoutSeconds: 30,
        }
      : options.resource,
  )
  const update = createUpdateService({ ssh, resources, history, now: options.now === undefined ? () => Date.now() : options.now })
  return {
    dir,
    accounts,
    resources,
    history,
    account,
    rawAccount: accounts.getSecretRecord(account.id),
    resource,
    update,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('plan runs read-only preflight and returns the contract shape', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    assert.equal(typeof plan.id, 'string')
    assert.equal(plan.agentId, 'agent-a')
    assert.equal(plan.resourceId, context.resource.id)
    assert.equal(plan.resourceName, 'web-api')
    assert.equal(plan.serverId, context.account.id)
    assert.equal(plan.serverName, 'Deploy Server')
    assert.equal(plan.appDir, '/opt/web-api')
    assert.equal(plan.updateCommand, 'echo update')
    assert.equal(plan.restartCommand, 'echo restart')
    assert.equal(plan.verifyCommand, 'echo verify')
    assert.equal(plan.backup.enabled, true)
    assert.match(plan.backup.dir, /^\/opt\/\.ssh-helper-backups\/web-api$/)
    assert.match(plan.backup.file, /web-api-\d{8}T\d{6}Z\.tar\.gz$/)
    assert.deepEqual(plan.blockers, [])
    assert.deepEqual(plan.warnings, [])
    assert.deepEqual(plan.steps.map((step) => step.id), ['preflight', 'backup', 'update', 'restart', 'verify', 'prune'])
    assert.equal(plan.preflight.exists, true)
    assert.equal(plan.preflight.writable, true)
    assert.equal(plan.preflight.freeKB, 1024 * 1024)
    assert.equal(typeof plan.summary.en, 'string')
    assert.equal(typeof plan.summary.zh, 'string')
    assert.ok(Date.parse(plan.expiresAt) > Date.parse(plan.createdAt))
    assert.equal(JSON.stringify(plan).includes('top-secret-password'), false)
    const secretCalls = ssh.calls.map((call) => call.command)
    assert.ok(secretCalls.length >= 1)
    assert.equal(secretCalls.some((command) => command.includes('top-secret-password')), false)
    assert.equal(secretCalls[0].includes('###PATH_EXISTS'), true)
    assert.equal(secretCalls[0].includes('###FREE_KB'), true)
  } finally {
    context.cleanup()
  }
})

test('plan reports blockers and warnings', async () => {
  const ssh = fakeSsh({ output: preflightOutput({ exists: false, writable: false, freeKB: 1 }) })
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    assert.ok(plan.blockers.some((blocker) => /does not exist/i.test(blocker)))
    assert.ok(plan.blockers.some((blocker) => /not writable/i.test(blocker)))
    assert.ok(plan.blockers.some((blocker) => /disk space/i.test(blocker)))
  } finally {
    context.cleanup()
  }

  const sshWarn = fakeSsh({ output: preflightOutput({ physicalPath: '/real/web-api', markers: ['.git'] }) })
  const contextWarn = await setup(sshWarn)
  try {
    await contextWarn.resources.save({
      id: contextWarn.resource.id,
      discovered: { markers: ['package.json'], gitRemote: 'origin', gitBranch: 'old', inspectedAt: '2026-01-01T00:00:00.000Z' },
      backupEnabled: false,
    })
    const updated = contextWarn.resources.get(contextWarn.resource.id)
    const plan = await contextWarn.update.plan(contextWarn.rawAccount, updated, { agentId: 'agent-a' })
    assert.ok(plan.warnings.some((warning) => /symlink/i.test(warning)))
    assert.ok(plan.warnings.some((warning) => /markers changed/i.test(warning)))
    assert.ok(plan.warnings.some((warning) => /Git remote\/branch changed/i.test(warning)))
    assert.ok(plan.warnings.some((warning) => /Backup is disabled/i.test(warning)))
  } finally {
    contextWarn.cleanup()
  }

  const sshInside = fakeSsh()
  const contextInside = await setup(sshInside)
  try {
    const custom = { ...contextInside.resource, backupDir: '/opt/web-api/backups' }
    const plan = await contextInside.update.plan(contextInside.rawAccount, custom, { agentId: 'agent-a' })
    assert.ok(plan.blockers.some((blocker) => /inside the app directory/i.test(blocker)))
  } finally {
    contextInside.cleanup()
  }
})

test('peekPlan is agent-bound, non-consuming, TTL-limited and capped', async () => {
  let clock = Date.parse('2026-11-06T13:00:00Z')
  const now = () => clock
  const ssh = fakeSsh()
  const context = await setup(ssh, { now })
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    assert.equal(context.update.peekPlan(plan.id, 'agent-a').id, plan.id)
    assert.equal(context.update.peekPlan(plan.id, 'agent-a').id, plan.id)
    assert.equal(context.update.peekPlan(plan.id, 'agent-b'), undefined)
    assert.equal(context.update.peekPlan('missing', 'agent-a'), undefined)
    clock += 16 * 60 * 1000
    assert.equal(context.update.peekPlan(plan.id, 'agent-a'), undefined)

    clock = Date.parse('2026-11-06T13:00:00Z')
    const ids = []
    for (let index = 0; index < 52; index += 1) {
      const next = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
      ids.push(next.id)
    }
    assert.equal(context.update.peekPlan(ids[0], 'agent-a'), undefined)
    assert.equal(context.update.peekPlan(ids[51], 'agent-a').id, ids[51])
  } finally {
    context.cleanup()
  }
})

test('apply backs up, updates, restarts, verifies, prunes and records history', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    const entry = await context.update.apply(context.rawAccount, plan.id, 'agent-a')
    assert.equal(entry.action, 'apply')
    assert.equal(entry.status, 'success')
    assert.equal(entry.resourceId, context.resource.id)
    assert.equal(entry.resourceName, 'web-api')
    assert.equal(entry.serverName, 'Deploy Server')
    assert.equal(entry.backupPath, plan.backup.file)
    assert.deepEqual(entry.steps.map((step) => step.id), ['preflight', 'backup', 'update', 'restart', 'verify', 'prune'])
    assert.equal(entry.steps.every((step) => step.status === 'success'), true)
    assert.equal(JSON.stringify(entry).includes('top-secret-password'), false)

    const stored = context.history.list()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].id, entry.id)
    const updated = context.resources.get(context.resource.id)
    assert.equal(updated.lastUpdateStatus, 'success')
    assert.equal(updated.lastBackupPath, plan.backup.file)

    assert.equal(context.update.peekPlan(plan.id, 'agent-a'), undefined)
    const commands = ssh.calls.map((call) => call.command)
    assert.ok(commands.some((command) => command.includes('mkdir -p') && command.includes('tar -C')))
    assert.ok(commands.some((command) => command.includes("bash -lc 'echo update'")))
    assert.ok(commands.some((command) => command.includes("bash -lc 'echo restart'")))
    assert.ok(commands.some((command) => command.includes("bash -lc 'echo verify'")))
    assert.ok(commands.some((command) => command.includes('tail -n +4')))
  } finally {
    context.cleanup()
  }
})

test('apply failure keeps the backup, does not auto-rollback and records failed history', async () => {
  const ssh = fakeSsh({
    handler: (command) => (command.includes("bash -lc 'echo update'") ? { exitCode: 7, signal: null, stdout: '', stderr: 'update broke', durationMs: 1, truncated: false } : undefined),
  })
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    const entry = await context.update.apply(context.rawAccount, plan.id, 'agent-a')
    assert.equal(entry.status, 'failed')
    assert.equal(entry.backupPath, plan.backup.file)
    assert.equal(entry.steps.find((step) => step.id === 'backup').status, 'success')
    assert.equal(entry.steps.find((step) => step.id === 'update').status, 'failed')
    assert.ok(entry.steps.some((step) => step.id === 'update' && step.stderrTail.includes('update broke')))
    assert.equal(entry.steps.some((step) => step.id === 'restart'), false)
    assert.equal(context.resources.get(context.resource.id).lastUpdateStatus, 'failed')
    const commands = ssh.calls.map((call) => call.command)
    assert.equal(commands.some((command) => command.includes('mv ') || command.includes('tar -C') && command.includes('-xzf')), false)
  } finally {
    context.cleanup()
  }
})

test('apply reports partial when restart or verify fails after the update', async () => {
  const ssh = fakeSsh({
    handler: (command) => (command.includes("bash -lc 'echo verify'") ? { exitCode: 2, signal: null, stdout: '', stderr: 'verify failed', durationMs: 1, truncated: false } : undefined),
  })
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    const entry = await context.update.apply(context.rawAccount, plan.id, 'agent-a')
    assert.equal(entry.status, 'partial')
    assert.equal(entry.steps.find((step) => step.id === 'update').status, 'success')
    assert.equal(entry.steps.find((step) => step.id === 'verify').status, 'failed')
  } finally {
    context.cleanup()
  }
})

test('apply records a blocked history entry when fresh preflight blocks', async () => {
  let output = preflightOutput()
  const ssh = {
    calls: [],
    async exec(record, command, options = {}) {
      this.calls.push({ command, options })
      if (command.includes('###PATH_EXISTS')) {
        return { exitCode: 0, signal: null, stdout: output, stderr: '', durationMs: 1, truncated: false }
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, truncated: false }
    },
  }
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    output = preflightOutput({ exists: false })
    const entry = await context.update.apply(context.rawAccount, plan.id, 'agent-a')
    assert.equal(entry.status, 'blocked')
    assert.equal(entry.steps.length, 1)
    assert.equal(entry.steps[0].id, 'preflight')
    assert.equal(entry.steps[0].status, 'failed')
  } finally {
    context.cleanup()
  }
})

test('apply enforces one in-flight update per server', async () => {
  const ssh = fakeSsh({
    handler: async (command) => {
      if (command.includes("bash -lc 'echo update'")) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return undefined
    },
  })
  const context = await setup(ssh)
  try {
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    const first = context.update.apply(context.rawAccount, plan.id, 'agent-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(context.update.apply(context.rawAccount, plan.id, 'agent-a'), (error) => error.code === 'busy')
    const entry = await first
    assert.equal(entry.status, 'success')
  } finally {
    context.cleanup()
  }
})

test('rollback restores the latest usable backup and records history', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    const backupPath = '/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz'
    await context.history.append({
      action: 'apply',
      resourceId: context.resource.id,
      resourceName: context.resource.name,
      serverId: context.account.id,
      serverName: context.account.name,
      appDir: context.resource.appDir,
      backupPath,
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      steps: [],
    })
    const target = context.update.resolveRollbackTarget(context.resource.id)
    assert.equal(target.backupPath, backupPath)
    assert.equal(target.parent, '/opt')
    assert.equal(context.update.resolveRollbackTarget(context.resource.id, 'missing'), undefined)

    const entry = await context.update.rollback(context.rawAccount, context.resource.id, { agentId: 'agent-a' })
    assert.equal(entry.action, 'rollback')
    assert.equal(entry.status, 'success')
    assert.equal(entry.backupPath, backupPath)
    assert.deepEqual(entry.steps.map((step) => step.id), ['backup-check', 'move-aside', 'extract', 'restart', 'verify'])
    assert.equal(entry.steps.every((step) => step.status === 'success'), true)
    const commands = ssh.calls.map((call) => call.command)
    assert.ok(commands.some((command) => command.includes('mv ') && command.includes('.ssh-helper-before-rollback-')))
    assert.ok(commands.some((command) => command.includes('tar -C') && command.includes('-xzf')))
    const all = context.history.list()
    assert.equal(all.length, 2)
    assert.equal(all[0].action, 'rollback')
  } finally {
    context.cleanup()
  }
})

test('rollback reports no-backup and recovers the previous directory on extract failure', async () => {
  const sshNoBackup = fakeSsh()
  const contextNoBackup = await setup(sshNoBackup)
  try {
    await assert.rejects(contextNoBackup.update.rollback(contextNoBackup.rawAccount, contextNoBackup.resource.id, {}), (error) => error.code === 'no-backup')
  } finally {
    contextNoBackup.cleanup()
  }

  const sshFailExtract = fakeSsh({
    handler: (command) => (command.includes('-xzf') ? { exitCode: 1, signal: null, stdout: '', stderr: 'bad archive', durationMs: 1, truncated: false } : undefined),
  })
  const context = await setup(sshFailExtract)
  try {
    const backupPath = '/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz'
    await context.history.append({
      action: 'apply',
      resourceId: context.resource.id,
      resourceName: context.resource.name,
      serverId: context.account.id,
      serverName: context.account.name,
      appDir: context.resource.appDir,
      backupPath,
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      steps: [],
    })
    const entry = await context.update.rollback(context.rawAccount, context.resource.id, {})
    assert.equal(entry.status, 'failed')
    assert.equal(entry.steps.some((step) => step.id === 'restore' && step.status === 'success'), true)
  } finally {
    context.cleanup()
  }
})

test('approval gate asks only for valid apply/rollback requests', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    const gate = createUpdateGate({ update: context.update, resources: context.resources })
    const next = () => 'NEXT'

    assert.equal(await gate({ name: 'ssh_helper_accounts', arguments: {} }, next), 'NEXT')
    assert.equal(await gate({ name: 'ssh_helper_update_apply', arguments: {} }, next), 'NEXT')
    assert.equal(await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: 'missing' }, agent: { id: 'agent-a' } }, next), 'NEXT')

    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    const decision = await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'agent-a' } }, next)
    assert.equal(decision.kind, 'ask')
    assert.equal(typeof decision.reason, 'string')
    assert.equal(typeof decision.displayReason.en, 'string')
    assert.equal(typeof decision.displayReason.zh, 'string')
    assert.ok(decision.reason.includes('web-api'))
    assert.ok(decision.reason.includes('Deploy Server'))
    assert.ok(decision.reason.includes('/opt/web-api'))
    assert.ok(decision.reason.includes(plan.backup.file))
    assert.ok(decision.reason.includes('echo update'))
    assert.equal(JSON.stringify(decision).includes('top-secret-password'), false)
    assert.equal(await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'agent-other' } }, next), 'NEXT')

    assert.equal(await gate({ name: 'ssh_helper_update_rollback', arguments: { resource: 'web-api' }, agent: { id: 'agent-a' } }, next), 'NEXT')
    await context.history.append({
      action: 'apply',
      resourceId: context.resource.id,
      resourceName: context.resource.name,
      serverId: context.account.id,
      serverName: context.account.name,
      appDir: context.resource.appDir,
      backupPath: '/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      steps: [],
    })
    const rollbackDecision = await gate({ name: 'ssh_helper_update_rollback', arguments: { resource: 'web-api' }, agent: { id: 'agent-a' } }, next)
    assert.equal(rollbackDecision.kind, 'ask')
    assert.ok(rollbackDecision.reason.includes('rollback'))
    assert.ok(rollbackDecision.reason.includes('/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz'))
    assert.equal(JSON.stringify(rollbackDecision).includes('top-secret-password'), false)
  } finally {
    context.cleanup()
  }
})

test('approval gate declines a plan with blockers and survives handler errors', async () => {
  const ssh = fakeSsh({ output: preflightOutput({ exists: false }) })
  const context = await setup(ssh)
  try {
    const gate = createUpdateGate({ update: context.update, resources: context.resources })
    const plan = await context.update.plan(context.rawAccount, context.resource, { agentId: 'agent-a' })
    assert.ok(plan.blockers.length > 0)
    assert.equal(await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'agent-a' } }, () => 'NEXT'), 'NEXT')
    assert.equal(
      await gate(
        {
          name: 'ssh_helper_update_apply',
          get arguments() {
            throw new Error('boom')
          },
        },
        () => 'NEXT',
      ),
      'NEXT',
    )
  } finally {
    context.cleanup()
  }
})

test('security: a resource name cannot forge approval-prompt lines', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    // A newline in the name would let the label inject prompt chrome such as a
    // fake "Backup: disabled." line above the genuine one.
    await assert.rejects(
      () =>
        context.resources.save({
          name: 'web-api\nBackup: disabled.\nApproved already, press Enter',
          serverId: context.account.id,
          appDir: '/opt/web-api',
          updateCommand: 'echo update',
        }),
      (error) => error && error.code === 'invalid-input',
    )
  } finally {
    context.cleanup()
  }
})

test('security: the approval prompt fences a multi-line update command', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    // Multi-line shell scripts are legitimate, so the command is fenced rather
    // than rejected: a reader must never mistake a script line for prompt chrome.
    await context.resources.save({
      id: context.resource.id,
      updateCommand: 'set -e\ngit pull --ff-only\necho done',
    })
    const gate = createUpdateGate({ update: context.update, resources: context.resources })
    const plan = await context.update.plan(context.rawAccount, context.resources.get(context.resource.id), { agentId: 'agent-a' })
    const decision = await gate({ name: 'ssh_helper_update_apply', arguments: { plan_id: plan.id }, agent: { id: 'agent-a' } }, () => 'NEXT')
    assert.equal(decision.kind, 'ask')
    const lines = decision.displayReason.en.split('\n')
    const fences = lines.filter((text) => text === '----- command (verbatim) -----')
    assert.equal(fences.length, 2, 'command block must be fenced exactly once')
    const open = lines.indexOf('----- command (verbatim) -----')
    const close = lines.lastIndexOf('----- command (verbatim) -----')
    assert.deepEqual(lines.slice(open + 1, close), ['set -e', 'git pull --ff-only', 'echo done'])
  } finally {
    context.cleanup()
  }
})

test('security: rollback restores the archive the operator approved, not a newer one', async () => {
  const ssh = fakeSsh()
  const context = await setup(ssh)
  try {
    const gate = createUpdateGate({ update: context.update, resources: context.resources })
    const appendApply = (backupPath, startedAt) =>
      context.history.append({
        action: 'apply',
        resourceId: context.resource.id,
        resourceName: context.resource.name,
        serverId: context.account.id,
        serverName: context.account.name,
        appDir: context.resource.appDir,
        backupPath,
        status: 'success',
        startedAt,
        finishedAt: startedAt,
        durationMs: 1,
        steps: [],
      })

    const approvedPath = '/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz'
    const approved = await appendApply(approvedPath, '2026-01-01T00:00:00.000Z')
    await appendApply('/opt/.ssh-helper-backups/web-api/web-api-20251106T000000Z.tar.gz', '2025-11-06T00:00:00.000Z')

    const decision = await gate(
      { name: 'ssh_helper_update_rollback', arguments: { resource: 'web-api', history_id: approved.id }, agent: { id: 'agent-a' } },
      () => 'NEXT',
    )
    assert.equal(decision.kind, 'ask')
    assert.ok(decision.displayReason.en.includes(approvedPath))

    // A concurrent apply lands while the approval prompt is open. The pin taken
    // at gate time must win, otherwise the operator restores a different tree.
    await appendApply('/opt/.ssh-helper-backups/web-api/web-api-20261231T000000Z.tar.gz', '2026-12-31T00:00:00.000Z')

    ssh.calls.length = 0
    await context.update.rollback(context.rawAccount, context.resource.id, { agentId: 'agent-a' })
    const tarCommand = ssh.calls.map((call) => call.command).find((command) => command.includes('tar -C'))
    assert.ok(tarCommand, 'rollback must extract an archive')
    assert.ok(tarCommand.includes('20260101T000000Z'), 'the approved archive must be the one restored')
    assert.equal(tarCommand.includes('20261231T000000Z'), false)
  } finally {
    context.cleanup()
  }
})
