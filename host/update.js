/**
 * Approval-gated remote update and rollback service.
 *
 * `plan` performs only read-only preflight work, caches a short-lived plan bound
 * to one agent, and returns it. `apply` re-validates the plan, backs up the
 * current directory, runs update/restart/verify commands, prunes old backups and
 * records history; any failure stops the sequence, keeps the backup and never
 * auto-rolls back. `rollback` restores one archived backup.
 *
 * The service itself does not know about the approval pipeline: `host/gate.js`
 * is the only place that turns a valid plan/history entry into an approval ask.
 *
 * @module host/update
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { buildInspectCommand, parseInspectOutput } from './discover.js'
import { backupLayout, remotePathWarnings, safeSegment, shQuote, validateRemotePath } from './shell.js'

/** Cached plan lifetime (15 minutes). */
const PLAN_TTL_MS = 15 * 60 * 1000
/** Maximum cached plans. */
const PLAN_MAX = 50
/** Maximum pinned rollback targets. */
const ROLLBACK_MAX = 50
/** Default preflight timeout (60 s). */
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000
/** Minimum accepted timeout (1 s). */
const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted timeout (10 min). */
const MAX_TIMEOUT_MS = 600_000
/** Captured output tail length. */
const TAIL_MAX_LENGTH = 8192
/** Command text length kept in history / approval reasons. */
const COMMAND_MAX_LENGTH = 8192
/** Extra disk headroom required for a backup (10 MiB). */
const BACKUP_HEADROOM_KB = 10 * 1024

/**
 * Build one tagged error.
 * @param {string} code - machine-readable code.
 * @param {string} message - Chinese message.
 * @param {unknown} [cause] - underlying failure.
 * @returns {Error & { code: string }} tagged error.
 */
function taggedError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/** @returns {Error} invalid-input error. */
function invalid(message) {
  return taggedError('invalid-input', message)
}

/**
 * Clamp one integer option.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Convert milliseconds to ISO text.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} ISO timestamp.
 */
function iso(ms) {
  return new Date(ms).toISOString()
}

/**
 * Format a compact UTC stamp such as `20261106T131500Z`.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} compact stamp.
 */
function compactStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Keep the last `max` characters of one output string.
 * @param {unknown} value - raw output.
 * @param {number} max - maximum length.
 * @returns {string} tail.
 */
function tail(value, max = TAIL_MAX_LENGTH) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : value.slice(value.length - max)
}

/**
 * Truncate one command for display.
 * @param {unknown} value - raw command.
 * @param {number} max - maximum length.
 * @returns {string} command text.
 */
function cut(value, max = COMMAND_MAX_LENGTH) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * Whether `candidate` is the directory itself or lies below it.
 * @param {string} parent - parent directory.
 * @param {string} candidate - child path.
 * @returns {boolean} containment.
 */
function isInside(parent, candidate) {
  if (typeof parent !== 'string' || typeof candidate !== 'string') return false
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

/**
 * Extract one SSH error message safely.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return '未知错误'
}

/**
 * Parse the `###FREE_KB` section appended to the preflight command.
 * @param {string} text - command output.
 * @returns {number} available kilobytes (0 when unknown).
 */
function parseFreeKB(text) {
  const match = /###FREE_KB\r?\n([^\r\n]*)/.exec(String(text ?? ''))
  const value = match === null ? Number.NaN : Number.parseInt(match[1].trim(), 10)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Run the read-only preflight for one app directory.
 * @param {object} account - full account record.
 * @param {string} appDir - validated absolute path.
 * @param {number} timeoutMs - command timeout.
 * @returns {Promise<object>} preflight facts.
 */
async function runPreflight(ssh, account, appDir, timeoutMs) {
  const command = [
    buildInspectCommand(appDir),
    "printf '\\n###FREE_KB\\n'",
    `__dir=${shQuote(appDir)}`,
    'while [ ! -d "$__dir" ] && [ "$__dir" != "/" ]; do __dir=$(dirname "$__dir"); done',
    'df -Pk "$__dir" 2>/dev/null | awk \'NR==2 {print $4}\'',
  ].join('\n')
  const result = await ssh.exec(account, command, { timeoutMs })
  const parsed = parseInspectOutput(result.stdout)
  return {
    exists: parsed.exists,
    writable: parsed.writable,
    physicalPath: parsed.physicalPath,
    sizeKB: parsed.sizeKB,
    freeKB: parseFreeKB(result.stdout),
    markers: parsed.markers,
    git: parsed.git,
    serviceUnits: parsed.serviceUnits,
  }
}

/**
 * Collect blockers for one plan/apply attempt.
 * @param {{ appDir: string, preflight: object, updateCommand: string, backup: { enabled: boolean, dir: string } }} input - facts.
 * @returns {string[]} blockers.
 */
function collectBlockers({ appDir, preflight, updateCommand, backup }) {
  const blockers = []
  if (!preflight.exists) blockers.push('The app directory does not exist or is not a directory.')
  if (!preflight.writable) blockers.push('The app directory is not writable by the SSH user.')
  if (typeof updateCommand !== 'string' || updateCommand.trim() === '') blockers.push('The update command is empty.')
  if (backup.enabled) {
    if (isInside(appDir, backup.dir)) blockers.push('The backup directory is inside the app directory.')
    const required = Math.ceil(preflight.sizeKB * 1.2) + BACKUP_HEADROOM_KB
    if (!(preflight.freeKB >= required)) {
      blockers.push(`Not enough free disk space for a backup: need about ${required} KB, have ${preflight.freeKB} KB.`)
    }
  }
  return blockers
}

/**
 * Collect non-blocking warnings for one plan.
 * @param {{ resource: object, appDir: string, preflight: object, backup: { enabled: boolean, dir: string } }} input - facts.
 * @returns {string[]} warnings.
 */
function collectWarnings({ resource, appDir, preflight, backup }) {
  const warnings = []
  if (preflight.physicalPath !== '' && preflight.physicalPath !== appDir) {
    warnings.push(`The app directory is a symlink to ${preflight.physicalPath}.`)
  }
  const discovered = resource && typeof resource.discovered === 'object' && resource.discovered !== null ? resource.discovered : undefined
  if (discovered) {
    if (Array.isArray(discovered.markers)) {
      const before = discovered.markers.slice().sort().join('\n')
      const nowMarkers = Array.isArray(preflight.markers) ? preflight.markers.slice().sort().join('\n') : ''
      if (before !== nowMarkers) warnings.push('Project markers changed since the last discovery.')
    }
    const gitKnown = typeof discovered.gitRemote === 'string' || typeof discovered.gitBranch === 'string'
    if (gitKnown) {
      const beforeGit = `${discovered.gitRemote ?? ''}\n${discovered.gitBranch ?? ''}`
      const nowGit = preflight.git ? `${preflight.git.remote}\n${preflight.git.branch}` : '\n'
      if (beforeGit !== nowGit) warnings.push('Git remote/branch changed since the last discovery.')
    }
  }
  if (!backup.enabled) warnings.push('Backup is disabled for this resource.')
  for (const warning of remotePathWarnings(appDir)) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  if (backup.enabled && backup.dir !== '') {
    for (const warning of remotePathWarnings(backup.dir)) {
      const text = `Backup: ${warning}`
      if (!warnings.includes(text)) warnings.push(text)
    }
  }
  return warnings
}

/**
 * Build the human summary for a plan.
 * @param {{ resourceName: string, serverName: string, appDir: string, updateCommand: string, backup: object }} plan - plan fields.
 * @returns {{ en: string, zh: string }} summary.
 */
function buildSummary({ resourceName, serverName, appDir, updateCommand, backup }) {
  const command = cut(updateCommand, 300)
  const backupEn = backup.enabled ? `Back up to ${backup.file} first. ` : 'Backup is disabled. '
  const backupZh = backup.enabled ? `先备份到 ${backup.file}。` : '未启用备份。'
  return {
    en: `Update "${resourceName}" on ${serverName} in ${appDir}. ${backupEn}Then run: ${command}`,
    zh: `在 ${serverName} 上更新 ${resourceName}（${appDir}）。${backupZh}随后执行：${command}`,
  }
}

/**
 * Create the update service.
 * @param {{ ssh: object, resources: object, history: object, now?: () => number }} options - services.
 * @returns {{
 *   plan: Function,
 *   peekPlan: Function,
 *   apply: Function,
 *   rollback: Function,
 *   resolveRollbackTarget: Function,
 * }} update service.
 */
export function createUpdateService({ ssh, resources, history, now = () => Date.now() } = {}) {
  if (!ssh || typeof ssh.exec !== 'function') throw new TypeError('createUpdateService: ssh client is required')
  if (!resources || typeof resources.get !== 'function' || typeof resources.find !== 'function') {
    throw new TypeError('createUpdateService: resources store is required')
  }
  if (!history || typeof history.append !== 'function' || typeof history.list !== 'function') {
    throw new TypeError('createUpdateService: history store is required')
  }

  /** @type {Map<string, object>} cached plans, insertion ordered. */
  const plans = new Map()
  /** @type {Map<string, object>} pinned rollback targets, insertion ordered. */
  const rollbacks = new Map()
  /** @type {Set<string>} servers with an apply/rollback in flight. */
  const busyServers = new Set()

  /**
   * Normalize the agent id used to bind plans.
   * @param {unknown} agentId - raw id.
   * @returns {string} normalized id.
   */
  function agentKey(agentId) {
    return typeof agentId === 'string' ? agentId : ''
  }

  /** Drop expired plans and enforce the cache cap. */
  function prunePlans() {
    const at = now()
    for (const [id, plan] of plans) {
      const expires = Date.parse(plan.expiresAt)
      if (!Number.isFinite(expires) || expires <= at) plans.delete(id)
    }
    while (plans.size > PLAN_MAX) {
      const oldest = plans.keys().next().value
      if (oldest === undefined) break
      plans.delete(oldest)
    }
  }

  /**
   * Clone a plan for a caller that must not mutate the cache.
   * @param {object} plan - cached plan.
   * @returns {object} clone.
   */
  function clonePlan(plan) {
    return JSON.parse(JSON.stringify(plan))
  }

  /**
   * Resolve the latest usable backup history entry for one resource.
   * @param {string | object} resourceQuery - resource id/name query or public view.
   * @param {string} [historyId] - explicit history entry.
   * @returns {object | undefined} rollback target.
   */
  function resolveRollbackTarget(resourceQuery, historyId) {
    const resource =
      typeof resourceQuery === 'string'
        ? resources.find(resourceQuery)
        : resourceQuery && typeof resourceQuery === 'object' && typeof resourceQuery.id === 'string'
          ? (resources.get(resourceQuery.id) ?? resourceQuery)
          : undefined
    if (!resource || typeof resource.appDir !== 'string' || resource.appDir === '') return undefined

    let layout
    try {
      layout = backupLayout({ appDir: resource.appDir, backupDir: resource.backupDir, name: resource.name, timestamp: now() })
    } catch {
      return undefined
    }

    /** @type {object | undefined} */
    let entry
    if (typeof historyId === 'string' && historyId !== '') {
      const candidate = history.get(historyId)
      if (
        candidate &&
        candidate.resourceId === resource.id &&
        candidate.action === 'apply' &&
        typeof candidate.backupPath === 'string' &&
        candidate.backupPath !== '' &&
        candidate.backupPath.startsWith(`${layout.dir}/`)
      ) {
        entry = candidate
      }
    } else {
      entry = history
        .list({ resourceId: resource.id, limit: 200 })
        .find(
          (candidate) =>
            candidate.action === 'apply' &&
            typeof candidate.backupPath === 'string' &&
            candidate.backupPath !== '' &&
            candidate.backupPath.startsWith(`${layout.dir}/`),
        )
    }
    if (!entry || typeof entry.backupPath !== 'string' || entry.backupPath === '') return undefined
    return {
      resource,
      entry,
      backupPath: entry.backupPath,
      backupDir: layout.dir,
      parent: layout.parent,
    }
  }

  /** Drop expired rollback pins and enforce the cache cap. */
  function pruneRollbacks() {
    const at = now()
    for (const [id, ticket] of rollbacks) {
      if (!Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= at) rollbacks.delete(id)
    }
    while (rollbacks.size > ROLLBACK_MAX) {
      const oldest = rollbacks.keys().next().value
      if (oldest === undefined) break
      rollbacks.delete(oldest)
    }
  }

  /**
   * Pin one resolved rollback target so the body restores exactly what was approved.
   *
   * Approval is a two-phase operation: the gate resolves a target to build the
   * prompt, the operator approves, and only then does the tool body restore.
   * Re-resolving in the body would let any apply/upload landing in between
   * change which archive gets extracted, so the resolved entry is pinned here
   * and consumed verbatim by {@link rollback}.
   *
   * The pin is keyed by agent and resource because the harness gate cannot
   * rewrite tool arguments between the approval prompt and the tool body.
   *
   * @param {object} target - value from {@link resolveRollbackTarget}.
   * @param {string | undefined} agentId - agent that must consume the pin.
   * @returns {string} pin key.
   */
  function pinRollback(target, agentId) {
    pruneRollbacks()
    const key = `${agentKey(agentId)}\u0000${target.resource.id}`
    rollbacks.set(key, {
      key,
      resourceId: target.resource.id,
      serverId: target.resource.serverId,
      appDir: target.resource.appDir,
      entryId: target.entry && typeof target.entry.id === 'string' ? target.entry.id : '',
      backupPath: target.backupPath,
      parent: target.parent,
      expiresAt: now() + PLAN_TTL_MS,
    })
    return key
  }

  /**
   * Read the pin for one agent and resource without consuming it.
   * @param {string | undefined} agentId - calling agent id.
   * @param {string} resourceId - resource id.
   * @returns {object | undefined} pinned target.
   */
  function peekRollback(agentId, resourceId) {
    pruneRollbacks()
    if (typeof resourceId !== 'string' || resourceId === '') return undefined
    return rollbacks.get(`${agentKey(agentId)}\u0000${resourceId}`)
  }

  /**
   * Drop one pin.
   * @param {string | undefined} agentId - calling agent id.
   * @param {string} resourceId - resource id.
   */
  function clearRollback(agentId, resourceId) {
    rollbacks.delete(`${agentKey(agentId)}\u0000${resourceId}`)
  }

  /**
   * Build a plan without touching the remote host beyond read-only preflight.
   * @param {object} account - full account record.
   * @param {object} resource - resource public view.
   * @param {{ agentId?: string, timeoutMs?: number }} [options] - plan options.
   * @returns {Promise<object>} cached plan.
   */
  async function plan(account, resource, { agentId, timeoutMs } = {}) {
    if (!account || typeof account !== 'object') throw invalid('缺少服务器账户')
    if (!resource || typeof resource !== 'object') throw invalid('缺少资源')
    if (typeof resource.id !== 'string' || resource.id === '') throw invalid('资源 id 无效')
    if (typeof resource.serverId !== 'string' || resource.serverId === '') throw invalid('资源缺少服务器')
    const appDir = validateRemotePath(resource.appDir)
    const preflightTimeout = clampInt(timeoutMs, DEFAULT_PREFLIGHT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const layout = backupLayout({ appDir, backupDir: resource.backupDir, name: resource.name, timestamp: now() })
    const preflight = await runPreflight(ssh, account, appDir, preflightTimeout)
    const updateCommand = typeof resource.updateCommand === 'string' ? resource.updateCommand.trim() : ''
    const backup = { enabled: resource.backupEnabled !== false, dir: layout.dir, file: layout.file }
    const blockers = collectBlockers({ appDir, preflight, updateCommand, backup })
    const warnings = collectWarnings({ resource, appDir, preflight, backup })

    const restartCommand = typeof resource.restartCommand === 'string' ? resource.restartCommand.trim() : ''
    const verifyCommand = typeof resource.verifyCommand === 'string' ? resource.verifyCommand.trim() : ''
    const backupKeep = clampInt(resource.backupKeep, 5, 1, 50)
    const backupParent = path.posix.dirname(appDir)
    const backupBase = path.posix.basename(appDir)

    const steps = [{ id: 'preflight', title: 'Preflight checks', detail: `Inspect ${appDir} (read-only).` }]
    if (backup.enabled) {
      steps.push({
        id: 'backup',
        title: 'Back up the current directory',
        detail: cut(`mkdir -p ${layout.dir} && tar -C ${backupParent} -czf ${layout.file} ./${backupBase}`, 500),
      })
    }
    steps.push({ id: 'update', title: 'Run the update command', detail: cut(`cd ${appDir} && bash -lc ${shQuote(updateCommand)}`, 500) })
    if (restartCommand !== '') {
      steps.push({ id: 'restart', title: 'Restart the service', detail: cut(`cd ${appDir} && bash -lc ${shQuote(restartCommand)}`, 500) })
    }
    if (verifyCommand !== '') {
      steps.push({ id: 'verify', title: 'Verify the deployment', detail: cut(`cd ${appDir} && bash -lc ${shQuote(verifyCommand)}`, 500) })
    }
    if (backup.enabled) {
      steps.push({ id: 'prune', title: 'Prune old backups', detail: `Keep the newest ${backupKeep} backup archives in ${layout.dir}.` })
    }

    const createdAt = now()
    const planId = randomUUID()
    const serverName =
      typeof resource.serverName === 'string' && resource.serverName !== ''
        ? resource.serverName
        : typeof account.name === 'string'
          ? account.name
          : ''
    const result = {
      id: planId,
      agentId: agentKey(agentId),
      resourceId: resource.id,
      resourceName: typeof resource.name === 'string' ? resource.name : '',
      serverId: resource.serverId,
      serverName,
      appDir,
      updateCommand,
      backup,
      preflight,
      steps,
      warnings,
      blockers,
      createdAt: iso(createdAt),
      expiresAt: iso(createdAt + PLAN_TTL_MS),
      summary: buildSummary({
        resourceName: typeof resource.name === 'string' ? resource.name : '',
        serverName,
        appDir,
        updateCommand,
        backup,
      }),
    }
    if (restartCommand !== '') result.restartCommand = restartCommand
    if (verifyCommand !== '') result.verifyCommand = verifyCommand

    plans.set(planId, result)
    prunePlans()
    return result
  }

  /**
   * Read one cached plan without consuming it.
   * @param {string} planId - plan id.
   * @param {string | undefined} agentId - calling agent id.
   * @returns {object | undefined} plan copy.
   */
  function peekPlan(planId, agentId) {
    prunePlans()
    if (typeof planId !== 'string' || planId === '') return undefined
    const plan = plans.get(planId)
    if (plan === undefined) return undefined
    if (plan.agentId !== agentKey(agentId)) return undefined
    if (Date.parse(plan.expiresAt) <= now()) {
      plans.delete(planId)
      return undefined
    }
    return clonePlan(plan)
  }

  /**
   * Execute one remote command as a history step.
   * @param {object} account - full account record.
   * @param {{ id: string, title: string, command: string }} definition - step definition.
   * @param {number} timeoutMs - command timeout.
   * @returns {Promise<object>} history step.
   */
  async function runCommandStep(account, definition, timeoutMs) {
    const startedAt = now()
    try {
      const result = await ssh.exec(account, definition.command, { timeoutMs })
      const stdoutTail = tail(result.stdout)
      const stderrTail = tail(result.stderr)
      return {
        id: definition.id,
        title: definition.title,
        command: cut(definition.command),
        status: result.exitCode === 0 ? 'success' : 'failed',
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        durationMs: typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : Math.max(0, now() - startedAt),
        stdoutTail,
        stderrTail,
        truncated:
          result.truncated === true ||
          (typeof result.stdout === 'string' && result.stdout.length > TAIL_MAX_LENGTH) ||
          (typeof result.stderr === 'string' && result.stderr.length > TAIL_MAX_LENGTH),
      }
    } catch (error) {
      return {
        id: definition.id,
        title: definition.title,
        command: cut(definition.command),
        status: 'failed',
        exitCode: null,
        durationMs: Math.max(0, now() - startedAt),
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      }
    }
  }

  /**
   * Run one backup/update/restart/verify/prune sequence.
   * @param {object} account - full account record.
   * @param {object} plan - cached plan.
   * @param {object} resource - current resource view.
   * @returns {Promise<object>} stored history entry.
   */
  async function executeApply(account, plan, resource) {
    const startedAt = now()
    const steps = []
    let backupPath = ''
    const timeoutMs = clampInt(resource.timeoutSeconds, 600, 30, 3600) * 1000
    const serverName =
      typeof resource.serverName === 'string' && resource.serverName !== ''
        ? resource.serverName
        : typeof account.name === 'string'
          ? account.name
          : ''
    /** @type {string} */
    let message = ''

    /**
     * Persist the attempt and return its history entry.
     * @param {string} status - final status.
     * @param {string} [note] - final message.
     * @returns {Promise<object>} stored entry.
     */
    const finish = async (status, note) => {
      if (typeof note === 'string' && note !== '') message = note
      const finishedAt = now()
      const entry = await history.append({
        action: 'apply',
        resourceId: plan.resourceId,
        resourceName: plan.resourceName,
        serverId: plan.serverId,
        serverName,
        appDir: plan.appDir,
        backupPath,
        status,
        startedAt: iso(startedAt),
        finishedAt: iso(finishedAt),
        durationMs: Math.max(0, finishedAt - startedAt),
        steps,
        ...(message === '' ? {} : { message }),
      })
      await resources.markUpdated(plan.resourceId, { at: entry.finishedAt, status, backupPath })
      return entry
    }

    try {
      let preflight
      const preflightStarted = now()
      try {
        preflight = await runPreflight(ssh, account, plan.appDir, Math.min(timeoutMs, DEFAULT_PREFLIGHT_TIMEOUT_MS))
      } catch (error) {
        steps.push({
          id: 'preflight',
          title: 'Preflight checks',
          status: 'failed',
          exitCode: null,
          durationMs: Math.max(0, now() - preflightStarted),
          stdoutTail: '',
          stderrTail: errorMessage(error),
          truncated: false,
        })
        return await finish('failed', '预检失败，未执行任何远端变更。')
      }

      const blockers = collectBlockers({
        appDir: plan.appDir,
        preflight,
        updateCommand: plan.updateCommand,
        backup: plan.backup,
      })
      if (blockers.length > 0) {
        steps.push({
          id: 'preflight',
          title: 'Preflight checks',
          status: 'failed',
          exitCode: null,
          durationMs: Math.max(0, now() - preflightStarted),
          stdoutTail: '',
          stderrTail: blockers.join('\n'),
          truncated: false,
        })
        return await finish('blocked', '预检发现阻塞项，未执行任何远端变更。')
      }
      steps.push({
        id: 'preflight',
        title: 'Preflight checks',
        status: 'success',
        exitCode: null,
        durationMs: Math.max(0, now() - preflightStarted),
        stdoutTail: '',
        stderrTail: '',
        truncated: false,
      })

      const parent = path.posix.dirname(plan.appDir)
      const baseName = path.posix.basename(plan.appDir)

      if (plan.backup.enabled) {
        backupPath = plan.backup.file
        const command = [
          `mkdir -p ${shQuote(plan.backup.dir)}`,
          `tar -C ${shQuote(parent)} -czf ${shQuote(plan.backup.file)} ${shQuote(`./${baseName}`)}`,
          `test -s ${shQuote(plan.backup.file)}`,
        ].join(' && ')
        const step = await runCommandStep(account, { id: 'backup', title: 'Back up the current directory', command }, timeoutMs)
        steps.push(step)
        if (step.status !== 'success') return await finish('failed', '备份失败，更新未执行；备份文件（如有）已保留。')
      }

      const updateStep = await runCommandStep(
        account,
        {
          id: 'update',
          title: 'Run the update command',
          command: `cd ${shQuote(plan.appDir)} && bash -lc ${shQuote(plan.updateCommand)}`,
        },
        timeoutMs,
      )
      steps.push(updateStep)
      if (updateStep.status !== 'success') return await finish('failed', '更新命令执行失败；备份已保留，且不会自动回滚。')

      if (typeof plan.restartCommand === 'string' && plan.restartCommand !== '') {
        const restartStep = await runCommandStep(
          account,
          {
            id: 'restart',
            title: 'Restart the service',
            command: `cd ${shQuote(plan.appDir)} && bash -lc ${shQuote(plan.restartCommand)}`,
          },
          timeoutMs,
        )
        steps.push(restartStep)
        if (restartStep.status !== 'success') return await finish('partial', '更新已执行，但重启命令失败。')
      }

      if (typeof plan.verifyCommand === 'string' && plan.verifyCommand !== '') {
        const verifyStep = await runCommandStep(
          account,
          {
            id: 'verify',
            title: 'Verify the deployment',
            command: `cd ${shQuote(plan.appDir)} && bash -lc ${shQuote(plan.verifyCommand)}`,
          },
          timeoutMs,
        )
        steps.push(verifyStep)
        if (verifyStep.status !== 'success') return await finish('partial', '更新已执行，但校验命令失败。')
      }

      if (plan.backup.enabled) {
        const keep = clampInt(resource.backupKeep, 5, 1, 50)
        const segment = safeSegment(plan.resourceName)
        const pattern = `${shQuote(`${plan.backup.dir}/${segment}-`)}*.tar.gz`
        const command = `ls -1 ${pattern} 2>/dev/null | sort -r | tail -n +${keep + 1} | while IFS= read -r __f; do rm -f "$__f"; done`
        const pruneStep = await runCommandStep(account, { id: 'prune', title: 'Prune old backups', command }, timeoutMs)
        steps.push(pruneStep)
        if (pruneStep.status !== 'success') return await finish('partial', '更新完成，但清理旧备份失败。')
      }

      return await finish('success', '更新完成。')
    } catch (error) {
      steps.push({
        id: 'internal',
        title: 'Unexpected failure',
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      })
      return await finish('failed', '更新流程异常终止。')
    }
  }

  /**
   * Execute one rollback attempt.
   * @param {object} account - full account record.
   * @param {object} target - rollback target from `resolveRollbackTarget`.
   * @returns {Promise<object>} stored history entry.
   */
  async function executeRollback(account, target) {
    const { resource, entry } = target
    const startedAt = now()
    const steps = []
    const timeoutMs = clampInt(resource.timeoutSeconds, 600, 30, 3600) * 1000
    const serverName =
      typeof resource.serverName === 'string' && resource.serverName !== ''
        ? resource.serverName
        : typeof account.name === 'string'
          ? account.name
          : ''
    const stamp = compactStamp(now())
    const previousDir = `${resource.appDir}.ssh-helper-before-rollback-${stamp}`
    /** @type {string} */
    let message = ''

    /**
     * Persist the rollback attempt.
     * @param {string} status - final status.
     * @param {string} [note] - final message.
     * @returns {Promise<object>} stored entry.
     */
    const finish = async (status, note) => {
      if (typeof note === 'string' && note !== '') message = note
      const finishedAt = now()
      const stored = await history.append({
        action: 'rollback',
        resourceId: resource.id,
        resourceName: resource.name,
        serverId: resource.serverId,
        serverName,
        appDir: resource.appDir,
        backupPath: target.backupPath,
        status,
        startedAt: iso(startedAt),
        finishedAt: iso(finishedAt),
        durationMs: Math.max(0, finishedAt - startedAt),
        steps,
        ...(message === '' ? {} : { message }),
      })
      return stored
    }

    try {
      const backupStep = await runCommandStep(
        account,
        { id: 'backup-check', title: 'Verify the backup archive', command: `test -s ${shQuote(target.backupPath)}` },
        timeoutMs,
      )
      steps.push(backupStep)
      if (backupStep.status !== 'success') return await finish('failed', '备份文件不存在或为空，回滚未开始。')

      const moveStep = await runCommandStep(
        account,
        { id: 'move-aside', title: 'Move the current directory aside', command: `mv ${shQuote(resource.appDir)} ${shQuote(previousDir)}` },
        timeoutMs,
      )
      steps.push(moveStep)
      if (moveStep.status !== 'success') {
        const restoreStep = await runCommandStep(
          account,
          {
            id: 'restore',
            title: 'Restore the previous directory',
            command: `if [ -d ${shQuote(previousDir)} ] && [ ! -e ${shQuote(resource.appDir)} ]; then mv ${shQuote(previousDir)} ${shQuote(resource.appDir)}; fi`,
          },
          timeoutMs,
        )
        steps.push(restoreStep)
        return await finish('failed', '无法移动当前应用目录，已尝试恢复原目录。')
      }

      const extractStep = await runCommandStep(
        account,
        {
          id: 'extract',
          title: 'Extract the backup archive',
          command: `tar -C ${shQuote(target.parent)} -xzf ${shQuote(target.backupPath)} && test -d ${shQuote(resource.appDir)}`,
        },
        timeoutMs,
      )
      steps.push(extractStep)
      if (extractStep.status !== 'success') {
        const restoreStep = await runCommandStep(
          account,
          {
            id: 'restore',
            title: 'Restore the previous directory',
            command: `rm -rf ${shQuote(resource.appDir)} 2>/dev/null; mv ${shQuote(previousDir)} ${shQuote(resource.appDir)}`,
          },
          timeoutMs,
        )
        steps.push(restoreStep)
        return await finish('failed', '解压备份失败，已尝试恢复原目录；备份文件保留。')
      }

      if (typeof resource.restartCommand === 'string' && resource.restartCommand !== '') {
        const restartStep = await runCommandStep(
          account,
          {
            id: 'restart',
            title: 'Restart the service',
            command: `cd ${shQuote(resource.appDir)} && bash -lc ${shQuote(resource.restartCommand)}`,
          },
          timeoutMs,
        )
        steps.push(restartStep)
        if (restartStep.status !== 'success') return await finish('partial', '目录已回滚，但重启命令失败。')
      }

      if (typeof resource.verifyCommand === 'string' && resource.verifyCommand !== '') {
        const verifyStep = await runCommandStep(
          account,
          {
            id: 'verify',
            title: 'Verify the deployment',
            command: `cd ${shQuote(resource.appDir)} && bash -lc ${shQuote(resource.verifyCommand)}`,
          },
          timeoutMs,
        )
        steps.push(verifyStep)
        if (verifyStep.status !== 'success') return await finish('partial', '目录已回滚，但校验命令失败。')
      }

      return await finish('success', `回滚完成；原目录已移动到 ${previousDir}。`)
    } catch (error) {
      steps.push({
        id: 'internal',
        title: 'Unexpected failure',
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      })
      return await finish('failed', '回滚流程异常终止。')
    }
  }

  /**
   * Execute a cached plan.
   * @param {object} account - full account record.
   * @param {string} planId - plan id from `plan`.
   * @param {string | undefined} agentId - calling agent id.
   * @returns {Promise<object>} stored history entry.
   */
  async function apply(account, planId, agentId) {
    prunePlans()
    const cached = typeof planId === 'string' ? plans.get(planId) : undefined
    if (cached === undefined) throw taggedError('plan-not-found', '更新计划不存在，请重新生成计划')
    if (cached.agentId !== agentKey(agentId)) throw taggedError('plan-not-found', '更新计划不存在，请重新生成计划')
    if (Date.parse(cached.expiresAt) <= now()) {
      plans.delete(planId)
      throw taggedError('plan-expired', '更新计划已过期，请重新生成计划')
    }

    const resource = resources.get(cached.resourceId)
    if (!resource) throw invalid('资源不存在，请刷新资源目录')
    if (resource.appDir !== cached.appDir || resource.serverId !== cached.serverId) {
      throw invalid('资源的目标目录或服务器已变更，请重新生成计划')
    }
    if (account && typeof account.id === 'string' && account.id !== cached.serverId) {
      throw invalid('账户与更新计划不匹配，请重新生成计划')
    }
    if (busyServers.has(cached.serverId)) throw taggedError('busy', '该服务器已有更新或回滚正在执行')

    busyServers.add(cached.serverId)
    try {
      return await executeApply(account, cached, resource)
    } finally {
      busyServers.delete(cached.serverId)
      plans.delete(planId)
    }
  }

  /**
   * Restore one backup archive.
   *
   * When an approval pin exists for this agent and resource, it decides which
   * archive is restored, so the body can never drift from the prompt the
   * operator approved. Without a pin the latest usable backup is resolved here,
   * which is only safe for callers that do not pass through an approval prompt.
   *
   * @param {object} account - full account record.
   * @param {string | object} resourceQuery - resource id/name query or view.
   * @param {{ agentId?: string, historyId?: string }} [options] - rollback options.
   * @returns {Promise<object>} stored history entry.
   */
  async function rollback(account, resourceQuery, { agentId, historyId } = {}) {
    const resource =
      typeof resourceQuery === 'string'
        ? resources.find(resourceQuery)
        : resourceQuery && typeof resourceQuery === 'object' && typeof resourceQuery.id === 'string'
          ? (resources.get(resourceQuery.id) ?? resourceQuery)
          : undefined
    if (!resource) throw invalid('资源不存在，请刷新资源目录')

    const pin = peekRollback(agentId, resource.id)
    let target
    if (pin) {
      // The pin is only valid while the resource still points at the approved
      // directory and the archive is still the one that was recorded.
      if (resource.appDir !== pin.appDir || resource.serverId !== pin.serverId) {
        clearRollback(agentId, resource.id)
        throw invalid('资源的目标目录或服务器已变更，请重新发起回滚')
      }
      const entry = history.get(pin.entryId)
      if (!entry || entry.backupPath !== pin.backupPath) {
        clearRollback(agentId, resource.id)
        throw invalid('备份记录已变更，请重新发起回滚')
      }
      target = { resource, entry, backupPath: pin.backupPath, parent: pin.parent, backupDir: path.posix.dirname(pin.backupPath) }
    } else {
      target = resolveRollbackTarget(resource, historyId)
      if (!target) throw taggedError('no-backup', '没有可用的备份记录，无法回滚')
    }
    if (account && typeof account.id === 'string' && account.id !== target.resource.serverId) {
      throw invalid('账户与资源不匹配')
    }
    if (busyServers.has(target.resource.serverId)) throw taggedError('busy', '该服务器已有更新或回滚正在执行')
    busyServers.add(target.resource.serverId)
    try {
      return await executeRollback(account, target)
    } finally {
      busyServers.delete(target.resource.serverId)
      clearRollback(agentId, resource.id)
    }
  }

  return { plan, peekPlan, apply, rollback, resolveRollbackTarget, pinRollback, peekRollback }
}
