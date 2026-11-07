/**
 * Agent tools for dsh-ssh-helper.
 *
 * Exactly seven tools are registered:
 * - `ssh_helper_accounts` lists/test SSH accounts without exposing credentials;
 * - `ssh_helper_discover` scans/inspects deployment directories (read-only);
 * - `ssh_helper_resources` manages the resource catalogue and history;
 * - `ssh_helper_update_plan` builds a read-only, approval-ready plan;
 * - `ssh_helper_update_apply` executes a plan (guarded by `tools/pre-execute`);
 * - `ssh_helper_update_rollback` restores a backup (guarded the same way);
 * - `ssh_helper_upload` pushes one local file over SFTP (guarded the same way).
 *
 * There is deliberately no generic remote-exec tool and no `confirm`, `force`
 * or `skip_approval` parameter anywhere.
 *
 * @module host/tools
 */

/** Maximum rendered text length. */
const RENDER_LIMIT = 8000

/**
 * @param {unknown} error - thrown value.
 * @returns {string} safe message.
 */
function errorMessage(error) {
  try {
    if (error && typeof error.message === 'string' && error.message !== '') return error.message
  } catch {
    /* fall through */
  }
  return ''
}

/**
 * Clamp a `*_seconds` tool argument.
 * @param {unknown} value - caller value.
 * @param {number} min - minimum seconds.
 * @param {number} max - maximum seconds.
 * @param {number} fallback - default seconds.
 * @returns {number} clamped seconds.
 */
function clampSeconds(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Coerce a value to display text.
 * @param {unknown} value - raw value.
 * @returns {string} text.
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Coerce a value to a display number.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @returns {number} number.
 */
function numberOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Shorten rendered text.
 * @param {unknown} value - raw text.
 * @returns {string} limited text.
 */
function limitedText(value) {
  const text = textOf(value)
  return text.length <= RENDER_LIMIT ? text : `${text.slice(0, RENDER_LIMIT)}…`
}

/**
 * Wrap one text block into tool content.
 * @param {string} text - rendered text.
 * @returns {{ type: 'text', text: string }[]} content blocks.
 */
function textContent(text) {
  return [{ type: 'text', text: limitedText(text) }]
}

/** Account public view schema. */
const ACCOUNT_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'number' },
    username: { type: 'string' },
    authType: { type: 'string' },
    hasPassword: { type: 'boolean' },
    hasKey: { type: 'boolean' },
    note: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'name', 'host', 'port', 'username', 'authType', 'hasPassword', 'hasKey', 'createdAt', 'updatedAt'],
}

/** Discovered fact schema inside a resource view. */
const DISCOVERED_SCHEMA = {
  type: 'object',
  properties: {
    os: { type: 'string' },
    user: { type: 'string' },
    sizeKB: { type: 'number' },
    markers: { type: 'array', items: { type: 'string' } },
    gitRemote: { type: 'string' },
    gitBranch: { type: 'string' },
    serviceUnits: { type: 'array', items: { type: 'string' } },
    inspectedAt: { type: 'string' },
  },
}

/** Resource public view schema. */
const RESOURCE_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    serverId: { type: 'string' },
    serverName: { type: 'string' },
    serviceName: { type: 'string' },
    appDir: { type: 'string' },
    updateCommand: { type: 'string' },
    restartCommand: { type: 'string' },
    verifyCommand: { type: 'string' },
    backupEnabled: { type: 'boolean' },
    backupDir: { type: 'string' },
    backupKeep: { type: 'number' },
    timeoutSeconds: { type: 'number' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    discovered: { oneOf: [DISCOVERED_SCHEMA, { type: 'null' }] },
    lastUpdateAt: { type: 'string' },
    lastUpdateStatus: { type: 'string' },
    lastBackupPath: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: [
    'id',
    'name',
    'serverId',
    'serverName',
    'appDir',
    'updateCommand',
    'backupEnabled',
    'backupKeep',
    'timeoutSeconds',
    'tags',
    'discovered',
    'createdAt',
    'updatedAt',
  ],
}

/** History step schema. */
const HISTORY_STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    command: { type: 'string' },
    exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    durationMs: { type: 'number' },
    stdoutTail: { type: 'string' },
    stderrTail: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['id', 'title', 'status', 'exitCode', 'durationMs', 'stdoutTail', 'stderrTail', 'truncated'],
}

/** History entry schema. */
const HISTORY_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    action: { type: 'string' },
    resourceId: { type: 'string' },
    resourceName: { type: 'string' },
    serverId: { type: 'string' },
    serverName: { type: 'string' },
    appDir: { type: 'string' },
    backupPath: { type: 'string' },
    status: { type: 'string' },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    durationMs: { type: 'number' },
    steps: { type: 'array', items: HISTORY_STEP_SCHEMA },
    message: { type: 'string' },
  },
  required: ['id', 'action', 'resourceId', 'resourceName', 'serverId', 'serverName', 'appDir', 'backupPath', 'status', 'startedAt', 'finishedAt', 'durationMs', 'steps'],
}

/** Git facts schema. */
const GIT_SCHEMA = {
  type: 'object',
  properties: {
    remote: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    dirty: { type: 'boolean' },
  },
  required: ['remote', 'branch', 'commit', 'dirty'],
}

/** Plan step schema. */
const PLAN_STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['id', 'title', 'detail'],
}

/** Preflight schema. */
const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    exists: { type: 'boolean' },
    writable: { type: 'boolean' },
    physicalPath: { type: 'string' },
    sizeKB: { type: 'number' },
    freeKB: { type: 'number' },
    markers: { type: 'array', items: { type: 'string' } },
    git: { oneOf: [GIT_SCHEMA, { type: 'null' }] },
    serviceUnits: { type: 'array', items: { type: 'string' } },
  },
  required: ['exists', 'writable', 'physicalPath', 'sizeKB', 'freeKB', 'markers', 'git', 'serviceUnits'],
}

/** Backup schema. */
const BACKUP_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    dir: { type: 'string' },
    file: { type: 'string' },
  },
  required: ['enabled', 'dir', 'file'],
}

/** Update plan schema (all-optional wrapper so `{ message }` failures validate too). */
const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    agentId: { type: 'string' },
    resourceId: { type: 'string' },
    resourceName: { type: 'string' },
    serverId: { type: 'string' },
    serverName: { type: 'string' },
    appDir: { type: 'string' },
    updateCommand: { type: 'string' },
    restartCommand: { type: 'string' },
    verifyCommand: { type: 'string' },
    backup: BACKUP_SCHEMA,
    preflight: PREFLIGHT_SCHEMA,
    steps: { type: 'array', items: PLAN_STEP_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    summary: {
      type: 'object',
      properties: { en: { type: 'string' }, zh: { type: 'string' } },
      required: ['en', 'zh'],
    },
    message: { type: 'string' },
  },
}

/** Scan/inspect output schema. */
const DISCOVER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    server: { type: 'string' },
    os: { type: 'string' },
    user: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          markers: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'markers'],
      },
    },
    listening: { type: 'array', items: { type: 'string' } },
    services: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
    path: { type: 'string' },
    exists: { type: 'boolean' },
    writable: { type: 'boolean' },
    physicalPath: { type: 'string' },
    sizeKB: { type: 'number' },
    topLevel: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          sizeBytes: { type: 'number' },
        },
        required: ['name', 'type', 'sizeBytes'],
      },
    },
    markers: { type: 'array', items: { type: 'string' } },
    git: { oneOf: [GIT_SCHEMA, { type: 'null' }] },
    serviceUnits: { type: 'array', items: { type: 'string' } },
    suggestedUpdateCommand: { type: 'string' },
    suggestedRestartCommand: { type: 'string' },
    message: { type: 'string' },
  },
}

/** Accounts tool output schema. */
const ACCOUNTS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    accounts: { type: 'array', items: ACCOUNT_VIEW_SCHEMA },
    result: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        success: { type: 'boolean' },
        latencyMs: { type: 'number' },
        message: { type: 'string' },
        output: { type: 'string' },
      },
      required: ['account', 'success', 'latencyMs'],
    },
    message: { type: 'string' },
  },
}

/** Resources tool output schema. */
const RESOURCES_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    resources: { type: 'array', items: RESOURCE_VIEW_SCHEMA },
    resource: RESOURCE_VIEW_SCHEMA,
    history: { type: 'array', items: HISTORY_ENTRY_SCHEMA },
    deleted: { type: 'boolean' },
    message: { type: 'string' },
  },
}

/** Apply/rollback output schema (history entry or message). */
const HISTORY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ...HISTORY_ENTRY_SCHEMA.properties,
    message: { type: 'string' },
  },
}

/**
 * Render the accounts tool result.
 * @param {object} args - tool arguments.
 * @param {object} value - tool result.
 * @returns {{ type: 'text', text: string }[]} content.
 */
function renderAccounts(args, value) {
  try {
    if (value && Array.isArray(value.accounts)) {
      if (value.accounts.length === 0) return textContent('No SSH accounts are configured.')
      const lines = [`SSH accounts (${value.accounts.length}):`]
      for (const account of value.accounts) {
        const auth = account.authType === 'key' ? 'private key' : 'password'
        const credential = account.authType === 'key' ? (account.hasKey ? 'key stored' : 'no key') : account.hasPassword ? 'password stored' : 'no password'
        lines.push(`- ${textOf(account.name)} — ${textOf(account.username)}@${textOf(account.host)}:${numberOf(account.port, 22)} (${auth} auth, ${credential})`)
        if (typeof account.note === 'string' && account.note !== '') lines.push(`  note: ${account.note}`)
      }
      return textContent(lines.join('\n'))
    }
    if (value && value.result && typeof value.result === 'object') {
      const result = value.result
      if (result.success === true) {
        const header = `Account ${textOf(result.account)} reachable in ${numberOf(result.latencyMs, 0)} ms`
        return textContent(textOf(result.output) ? `${header}\n${textOf(result.output)}` : header)
      }
      return textContent(`Account ${textOf(result.account)} connection failed — ${textOf(result.message) || 'unknown error'}`)
    }
    return textContent(textOf(value && value.message) || 'No account information is available.')
  } catch {
    return textContent('Account information is unavailable.')
  }
}

/**
 * Render the discover tool result.
 * @param {object} args - tool arguments.
 * @param {object} value - tool result.
 * @returns {{ type: 'text', text: string }[]} content.
 */
function renderDiscover(args, value) {
  try {
    if (value && Array.isArray(value.candidates)) {
      const lines = [`Scan on ${textOf(value.server) || 'server'} (${textOf(value.os) || 'unknown OS'}, user ${textOf(value.user) || 'unknown'}):`]
      if (value.candidates.length === 0) lines.push('No candidate deployment directories were found.')
      for (const candidate of value.candidates) {
        lines.push(`- ${textOf(candidate.path)} — markers: ${Array.isArray(candidate.markers) ? candidate.markers.join(', ') : ''}`)
      }
      if (Array.isArray(value.listening) && value.listening.length > 0) {
        lines.push('', 'Listening (raw):', ...value.listening.slice(0, 20).map((entry) => `  ${entry}`))
      }
      if (Array.isArray(value.services) && value.services.length > 0) {
        lines.push('', 'Services (raw):', ...value.services.slice(0, 20).map((entry) => `  ${entry}`))
      }
      if (value.truncated === true) lines.push('', 'Output was truncated.')
      return textContent(lines.join('\n'))
    }
    if (value && typeof value.path === 'string') {
      const lines = [
        `Directory ${value.path}`,
        `exists: ${value.exists === true ? 'yes' : 'no'} · writable: ${value.writable === true ? 'yes' : 'no'} · size: ${numberOf(value.sizeKB, 0)} KB`,
      ]
      if (typeof value.physicalPath === 'string' && value.physicalPath !== '') lines.push(`physical: ${value.physicalPath}`)
      if (Array.isArray(value.markers) && value.markers.length > 0) lines.push(`markers: ${value.markers.join(', ')}`)
      if (value.git && typeof value.git === 'object') {
        lines.push(`git: ${textOf(value.git.branch) || '?'} @ ${textOf(value.git.commit).slice(0, 12) || '?'}${value.git.dirty === true ? ' (dirty)' : ''}`)
        if (textOf(value.git.remote) !== '') lines.push(`remote: ${value.git.remote}`)
      }
      if (Array.isArray(value.topLevel) && value.topLevel.length > 0) {
        lines.push('', 'Top level:')
        for (const entry of value.topLevel.slice(0, 30)) {
          lines.push(`- ${textOf(entry.name)} (${textOf(entry.type)}, ${numberOf(entry.sizeBytes, 0)} bytes)`)
        }
      }
      if (Array.isArray(value.serviceUnits) && value.serviceUnits.length > 0) lines.push('', `service units: ${value.serviceUnits.join(', ')}`)
      if (textOf(value.suggestedUpdateCommand) !== '') lines.push('', `suggested update: ${value.suggestedUpdateCommand}`)
      if (textOf(value.suggestedRestartCommand) !== '') lines.push(`suggested restart: ${value.suggestedRestartCommand}`)
      return textContent(lines.join('\n'))
    }
    return textContent(textOf(value && value.message) || 'Discovery returned no data.')
  } catch {
    return textContent('Discovery result is unavailable.')
  }
}

/**
 * Format one resource row.
 * @param {object} resource - resource view.
 * @returns {string} row.
 */
function resourceRow(resource) {
  const status = textOf(resource.lastUpdateStatus) || 'never'
  return `- ${textOf(resource.name)} — ${textOf(resource.serverName) || 'unknown server'}:${textOf(resource.appDir)} (last: ${status})`
}

/**
 * Render the resources tool result.
 * @param {object} args - tool arguments.
 * @param {object} value - tool result.
 * @returns {{ type: 'text', text: string }[]} content.
 */
function renderResources(args, value) {
  try {
    if (value && Array.isArray(value.resources)) {
      if (value.resources.length === 0) return textContent('No deployment resources are configured.')
      return textContent([`Deployment resources (${value.resources.length}):`, ...value.resources.map(resourceRow)].join('\n'))
    }
    if (value && value.resource && typeof value.resource === 'object') {
      const resource = value.resource
      const lines = [
        `Resource ${textOf(resource.name)}`,
        `server: ${textOf(resource.serverName) || 'unknown'} (${textOf(resource.serverId)})`,
        `directory: ${textOf(resource.appDir)}`,
        `update: ${textOf(resource.updateCommand)}`,
      ]
      if (textOf(resource.restartCommand) !== '') lines.push(`restart: ${resource.restartCommand}`)
      if (textOf(resource.verifyCommand) !== '') lines.push(`verify: ${resource.verifyCommand}`)
      lines.push(`backup: ${resource.backupEnabled === true ? `enabled (keep ${numberOf(resource.backupKeep, 5)})` : 'disabled'}`)
      if (textOf(resource.lastUpdateStatus) !== '') {
        lines.push(`last update: ${resource.lastUpdateStatus} at ${textOf(resource.lastUpdateAt) || 'unknown'}`)
      }
      if (Array.isArray(resource.history) || (value && Array.isArray(value.history))) {
        const entries = Array.isArray(value.history) ? value.history : []
        if (entries.length > 0) {
          lines.push('', 'Recent history:')
          for (const entry of entries) {
            lines.push(`- ${textOf(entry.startedAt)} ${textOf(entry.action)} ${textOf(entry.status)} (${numberOf(entry.durationMs, 0)} ms)`)
          }
        }
      }
      return textContent(lines.join('\n'))
    }
    if (value && Array.isArray(value.history)) {
      if (value.history.length === 0) return textContent('No update history is available.')
      const lines = [`Update history (${value.history.length}):`]
      for (const entry of value.history) {
        lines.push(
          `- ${textOf(entry.startedAt)} ${textOf(entry.action)} ${textOf(entry.status)} — ${textOf(entry.resourceName)} (${numberOf(entry.durationMs, 0)} ms)`,
        )
      }
      return textContent(lines.join('\n'))
    }
    if (value && value.deleted === true) return textContent('Resource deleted.')
    return textContent(textOf(value && value.message) || 'No resource information is available.')
  } catch {
    return textContent('Resource information is unavailable.')
  }
}

/**
 * Render the update plan.
 * @param {object} args - tool arguments.
 * @param {object} value - tool result.
 * @returns {{ type: 'text', text: string }[]} content.
 */
function renderPlan(args, value) {
  try {
    if (!value || typeof value.id !== 'string') return textContent(textOf(value && value.message) || 'No plan was produced.')
    const plan = value
    const lines = [
      `Update plan ${plan.id}`,
      `resource: ${textOf(plan.resourceName)} on ${textOf(plan.serverName)}`,
      `directory: ${textOf(plan.appDir)}`,
      `update command: ${textOf(plan.updateCommand)}`,
    ]
    if (plan.backup && typeof plan.backup === 'object') {
      lines.push(`backup: ${plan.backup.enabled === true ? textOf(plan.backup.file) : 'disabled'}`)
    }
    if (typeof plan.restartCommand === 'string' && plan.restartCommand !== '') lines.push(`restart command: ${plan.restartCommand}`)
    if (typeof plan.verifyCommand === 'string' && plan.verifyCommand !== '') lines.push(`verify command: ${plan.verifyCommand}`)
    if (Array.isArray(plan.steps) && plan.steps.length > 0) {
      lines.push('', 'Steps:')
      for (const step of plan.steps) lines.push(`- ${textOf(step.title)}: ${textOf(step.detail)}`)
    }
    if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
      lines.push('', 'Blockers:')
      for (const blocker of plan.blockers) lines.push(`- ${blocker}`)
    }
    if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
      lines.push('', 'Warnings:')
      for (const warning of plan.warnings) lines.push(`- ${warning}`)
    }
    lines.push('', `expires: ${textOf(plan.expiresAt)}`, 'Call ssh_helper_update_apply with this plan_id to request approval; nothing is executed until the user approves.')
    return textContent(lines.join('\n'))
  } catch {
    return textContent('Update plan is unavailable.')
  }
}

/**
 * Render one stored history entry.
 * @param {object} args - tool arguments (unused).
 * @param {object} value - history entry or `{ message }` failure.
 * @returns {{ type: 'text', text: string }[]} content.
 */
function renderHistory(args, value) {
  try {
    if (!value || typeof value.status !== 'string') return textContent(textOf(value && value.message) || 'No update result is available.')
    const entry = value
    const lines = [
      `${textOf(entry.action)} ${textOf(entry.status)} — ${textOf(entry.resourceName)} on ${textOf(entry.serverName)}`,
      `directory: ${textOf(entry.appDir)}`,
      `backup: ${textOf(entry.backupPath) || '(none)'}`,
      `duration: ${numberOf(entry.durationMs, 0)} ms`,
    ]
    if (textOf(entry.message) !== '') lines.push(`message: ${entry.message}`)
    if (Array.isArray(entry.steps)) {
      for (const step of entry.steps) {
        lines.push('', `[${textOf(step.status)}] ${textOf(step.title)}${typeof step.exitCode === 'number' ? ` (exit ${step.exitCode})` : ''}`)
        if (textOf(step.stderrTail) !== '') lines.push(`stderr: ${tailText(step.stderrTail)}`)
        if (textOf(step.stdoutTail) !== '') lines.push(`stdout: ${tailText(step.stdoutTail)}`)
      }
    }
    return textContent(lines.join('\n'))
  } catch {
    return textContent('Update result is unavailable.')
  }
}

/**
 * Limit one step output block for rendering.
 * @param {unknown} value - raw text.
 * @returns {string} clipped text.
 */
function tailText(value) {
  const text = textOf(value)
  return text.length <= 2000 ? text : `…${text.slice(text.length - 2000)}`
}

/**
 * Build the `ssh_helper_accounts` tool.
 * @param {{ accounts: object, ssh: object }} services - services.
 * @returns {object} tool definition.
 */
function accountsTool({ accounts, ssh }) {
  return {
    name: 'ssh_helper_accounts',
    description:
      'List the SSH accounts configured in dsh-ssh-helper or test connectivity to one account. Credentials are never returned; use the account name or id from action="list" with action="test".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'test'], description: 'list accounts or test one account' },
        account: { type: 'string', description: 'Account id or name; required for action=test' },
        timeout_seconds: { type: 'number', description: 'Connection test timeout in seconds (1-120, default 20)' },
      },
      required: ['action'],
    },
    output: { schema: ACCOUNTS_OUTPUT_SCHEMA, render: renderAccounts },
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.action === 'test' ? `Test SSH account ${textOf(args.account) || ''}`.trim() : 'List SSH accounts',
      kind: 'other',
    }),
    async execute(args) {
      try {
        const action = args && typeof args.action === 'string' ? args.action : ''
        if (action === 'list') {
          try {
            return { accounts: accounts.list() }
          } catch (error) {
            return { message: errorMessage(error) || '读取账户列表失败' }
          }
        }
        if (action === 'test') {
          const query = args && typeof args.account === 'string' ? args.account.trim() : ''
          if (query === '') return { message: '缺少账户参数：请提供要测试的账户 id 或名称' }
          const view = accounts.find(query)
          if (!view) return { message: `未找到账户 "${query}"，请先用 ssh_helper_accounts 的 list 操作查看` }
          const record = accounts.getSecretRecord(view.id)
          if (!record) return { message: `无法读取账户 "${view.name}" 的连接凭据` }
          const seconds = clampSeconds(args && args.timeout_seconds, 1, 120, 20)
          const startedAt = Date.now()
          try {
            const probed = await ssh.probe(record, { timeoutMs: seconds * 1000 })
            return {
              result: {
                account: view.name,
                success: true,
                latencyMs: typeof probed.latencyMs === 'number' ? probed.latencyMs : Date.now() - startedAt,
                message: '连接成功',
                output: textOf(probed.output),
              },
            }
          } catch (error) {
            return {
              result: {
                account: view.name,
                success: false,
                latencyMs: Date.now() - startedAt,
                message: errorMessage(error) || '连接失败',
              },
            }
          }
        }
        return { message: `不支持的操作 "${textOf(action)}"：仅支持 list 或 test` }
      } catch (error) {
        return { message: errorMessage(error) || '操作失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_discover` tool.
 * @param {{ accounts: object, discover: object }} services - services.
 * @returns {object} tool definition.
 */
function discoverTool({ accounts, discover }) {
  /**
   * Resolve an account and its secret record.
   * @param {unknown} query - account id/name.
   * @returns {object | { message: string }} record or failure.
   */
  function resolveAccount(query) {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text === '') return { message: '缺少服务器参数：请提供账户 id 或名称' }
    const view = accounts.find(text)
    if (!view) return { message: `未找到账户 "${text}"` }
    const record = accounts.getSecretRecord(view.id)
    if (!record) return { message: `无法读取账户 "${view.name}" 的连接凭据` }
    return record
  }

  return {
    name: 'ssh_helper_discover',
    description:
      'Read-only discovery of deployment directories on a configured SSH account. action="scan" searches common roots (or explicit roots) for project markers; action="inspect" reports whether one directory exists, its top-level entries, markers, git state and running services. File contents such as .env are never read. No command in this tool changes the remote host.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'inspect'], description: 'scan candidate roots or inspect one directory' },
        server: { type: 'string', description: 'Account id or name' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Absolute scan roots (scan only)' },
        path: { type: 'string', description: 'Absolute directory path for inspect' },
        max_depth: { type: 'number', description: 'Scan depth 1-4 (default 3)' },
        limit: { type: 'number', description: 'Maximum candidates 1-200 (default 80)' },
        timeout_seconds: { type: 'number', description: 'Timeout in seconds (1-600, default 60)' },
      },
      required: ['action', 'server'],
    },
    output: { schema: DISCOVER_OUTPUT_SCHEMA, render: renderDiscover },
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.action === 'inspect' ? `Inspect ${textOf(args.path) || 'directory'}` : `Scan ${textOf(args.server) || 'server'}`,
      kind: 'other',
    }),
    async execute(args) {
      try {
        const action = args && typeof args.action === 'string' ? args.action : ''
        const record = resolveAccount(args && args.server)
        if (record.message !== undefined) return record
        const seconds = clampSeconds(args && args.timeout_seconds, 1, 600, 60)
        if (action === 'scan') {
          const roots = Array.isArray(args && args.roots) ? args.roots.filter((root) => typeof root === 'string' && root.trim() !== '') : undefined
          return await discover.scan(record, {
            roots: roots === undefined || roots.length === 0 ? undefined : roots,
            maxDepth: args && args.max_depth,
            limit: args && args.limit,
            timeoutMs: seconds * 1000,
          })
        }
        if (action === 'inspect') {
          const remotePath = args && typeof args.path === 'string' ? args.path.trim() : ''
          if (remotePath === '') return { message: '缺少 path 参数：请提供要勘察的绝对目录路径' }
          return await discover.inspect(record, { path: remotePath, timeoutMs: seconds * 1000 })
        }
        return { message: `不支持的操作 "${textOf(action)}"：仅支持 scan 或 inspect` }
      } catch (error) {
        return { message: errorMessage(error) || '目录采集失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_resources` tool.
 * @param {{ accounts: object, resources: object, history: object }} services - services.
 * @returns {object} tool definition.
 */
function resourcesTool({ accounts, resources, history }) {
  /**
   * Resolve one resource query.
   * @param {unknown} query - id or name.
   * @returns {object | { message: string }} view or failure.
   */
  function resolveResource(query) {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text === '') return { message: '缺少资源参数：请提供资源 id 或名称' }
    const view = resources.find(text)
    if (!view) return { message: `未找到资源 "${text}"，请先用 action="list" 查看` }
    return view
  }

  return {
    name: 'ssh_helper_resources',
    description:
      'Manage the deployment resource catalogue: list resources, get one with recent history, list history, save a resource discovered on an SSH account, or delete one. Saving stores metadata and commands only; it never executes anything.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'history', 'save', 'delete'], description: 'operation' },
        resource: { type: 'string', description: 'Resource id or name (get/history/delete, and save to update)' },
        server: { type: 'string', description: 'Account id or name (list filter or save target)' },
        name: { type: 'string', description: 'Resource display name' },
        service_name: { type: 'string', description: 'systemd/docker service label' },
        app_dir: { type: 'string', description: 'Absolute deployment directory' },
        update_command: { type: 'string', description: 'Update command run in app_dir' },
        restart_command: { type: 'string', description: 'Optional restart command' },
        verify_command: { type: 'string', description: 'Optional verify command' },
        backup_enabled: { type: 'boolean', description: 'Whether to back up before updates (default true)' },
        backup_dir: { type: 'string', description: 'Optional absolute backup directory' },
        backup_keep: { type: 'number', description: 'Backups to keep, 1-50 (default 5)' },
        timeout_seconds: { type: 'number', description: 'Step timeout, 30-3600 (default 600)' },
        note: { type: 'string', description: 'Optional note (max 500 chars)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        discovered: { type: 'object', description: 'Discovery facts to store (markers/git/services)' },
      },
      required: ['action'],
    },
    output: { schema: RESOURCES_OUTPUT_SCHEMA, render: renderResources },
    presentCall: (args) => ({
      card: 'generic',
      title: args && args.action ? `Resources: ${textOf(args.action)}` : 'Deployment resources',
      kind: 'other',
    }),
    async execute(args) {
      try {
        const action = args && typeof args.action === 'string' ? args.action : ''
        if (action === 'list') {
          const server = args && typeof args.server === 'string' ? args.server : undefined
          return { resources: resources.list({ server }) }
        }
        if (action === 'get') {
          const view = resolveResource(args && args.resource)
          if (view.message !== undefined) return view
          return { resource: view, history: history.list({ resourceId: view.id, limit: 20 }) }
        }
        if (action === 'history') {
          let resourceId
          if (args && typeof args.resource === 'string' && args.resource.trim() !== '') {
            const view = resources.find(args.resource.trim())
            if (!view) return { message: `未找到资源 "${args.resource}"` }
            resourceId = view.id
          }
          const limit = clampSeconds(args && args.limit, 1, 200, 20)
          return { history: history.list({ resourceId, limit }) }
        }
        if (action === 'save') {
          const draft = {}
          if (args && args.name !== undefined) draft.name = args.name
          if (args && args.server !== undefined) draft.server = args.server
          if (args && args.server_id !== undefined) draft.serverId = args.server_id
          if (args && args.service_name !== undefined) draft.serviceName = args.service_name
          if (args && args.app_dir !== undefined) draft.appDir = args.app_dir
          if (args && args.update_command !== undefined) draft.updateCommand = args.update_command
          if (args && args.restart_command !== undefined) draft.restartCommand = args.restart_command
          if (args && args.verify_command !== undefined) draft.verifyCommand = args.verify_command
          if (args && args.backup_enabled !== undefined) draft.backupEnabled = args.backup_enabled
          if (args && args.backup_dir !== undefined) draft.backupDir = args.backup_dir
          if (args && args.backup_keep !== undefined) draft.backupKeep = args.backup_keep
          if (args && args.timeout_seconds !== undefined) draft.timeoutSeconds = args.timeout_seconds
          if (args && args.note !== undefined) draft.note = args.note
          if (args && args.tags !== undefined) draft.tags = args.tags
          if (args && args.discovered !== undefined) draft.discovered = args.discovered
          if (args && typeof args.resource === 'string' && args.resource.trim() !== '') {
            const view = resolveResource(args.resource)
            if (view.message !== undefined) return view
            draft.id = view.id
          }
          return { resource: await resources.save(draft) }
        }
        if (action === 'delete') {
          const view = resolveResource(args && args.resource)
          if (view.message !== undefined) return view
          const deleted = await resources.remove(view.id)
          if (!deleted) return { message: `未找到资源 "${view.name}"` }
          return { deleted: true, resource: view }
        }
        return { message: `不支持的操作 "${textOf(action)}"：仅支持 list/get/history/save/delete` }
      } catch (error) {
        return { message: errorMessage(error) || '资源操作失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_update_plan` tool.
 * @param {{ accounts: object, resources: object, update: object }} services - services.
 * @returns {object} tool definition.
 */
function planTool({ accounts, resources, update }) {
  return {
    name: 'ssh_helper_update_plan',
    description:
      'Build a read-only update plan for one deployment resource. Preflight checks the directory, writability, free space, markers and git state; the returned plan_id can be passed to ssh_helper_update_apply. Nothing on the remote host is modified.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource id or name' },
        timeout_seconds: { type: 'number', description: 'Preflight timeout in seconds (1-600, default 60)' },
      },
      required: ['resource'],
    },
    output: { schema: PLAN_OUTPUT_SCHEMA, render: renderPlan },
    presentCall: (args) => ({ card: 'generic', title: `Plan update for ${textOf(args && args.resource) || 'resource'}`, kind: 'other' }),
    timeoutMs: 600_000,
    async execute(args, exec) {
      try {
        const query = args && typeof args.resource === 'string' ? args.resource.trim() : ''
        if (query === '') return { message: '缺少资源参数：请提供资源 id 或名称' }
        const resource = resources.find(query)
        if (!resource) return { message: `未找到资源 "${query}"，请先用 ssh_helper_resources 的 list 操作查看` }
        const account = accounts.getSecretRecord(resource.serverId)
        if (!account) return { message: `资源 "${resource.name}" 关联的账户不存在，请先修复资源` }
        const seconds = clampSeconds(args && args.timeout_seconds, 1, 600, 60)
        return await update.plan(account, resource, {
          agentId: exec && exec.agent ? exec.agent.id : undefined,
          timeoutMs: seconds * 1000,
        })
      } catch (error) {
        return { message: errorMessage(error) || '生成更新计划失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_update_apply` tool.
 * @param {{ accounts: object, update: object }} services - services.
 * @returns {object} tool definition.
 */
function applyTool({ accounts, update }) {
  return {
    name: 'ssh_helper_update_apply',
    description:
      'Execute a previously generated update plan: back up the app directory, run the update/restart/verify commands, prune old backups and record history. This tool is always gated by the harness approval prompt; without an approved allowed-once decision nothing runs.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'plan_id returned by ssh_helper_update_plan' },
      },
      required: ['plan_id'],
    },
    output: { schema: HISTORY_OUTPUT_SCHEMA, render: renderHistory },
    presentCall: () => ({ card: 'generic', title: 'Apply approved SSH update', kind: 'other' }),
    isConcurrencySafe: () => false,
    timeoutMs: 3_600_000,
    async execute(args, exec) {
      try {
        const planId = args && typeof args.plan_id === 'string' ? args.plan_id.trim() : ''
        if (planId === '') return { message: '缺少 plan_id：请先调用 ssh_helper_update_plan' }
        const agentId = exec && exec.agent ? exec.agent.id : undefined
        const plan = update.peekPlan(planId, agentId)
        if (!plan) return { message: '更新计划不存在或已过期，请重新调用 ssh_helper_update_plan 生成计划' }
        if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
          return { message: `更新计划存在阻塞项，无法执行：${plan.blockers.join('; ')}` }
        }
        const account = accounts.getSecretRecord(plan.serverId)
        if (!account) return { message: '更新计划关联的账户不存在' }
        return await update.apply(account, planId, agentId)
      } catch (error) {
        return { message: errorMessage(error) || '执行更新失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_update_rollback` tool.
 * @param {{ accounts: object, resources: object, update: object }} services - services.
 * @returns {object} tool definition.
 */
function rollbackTool({ accounts, resources, update }) {
  return {
    name: 'ssh_helper_update_rollback',
    description:
      'Roll one deployment resource back to the latest recorded backup (or a specific history entry). The current directory is moved aside and the backup is extracted, then optional restart/verify commands run. Always gated by the harness approval prompt.',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource id or name' },
        history_id: { type: 'string', description: 'Optional history entry id to restore instead of the latest backup' },
      },
      required: ['resource'],
    },
    output: { schema: HISTORY_OUTPUT_SCHEMA, render: renderHistory },
    presentCall: (args) => ({ card: 'generic', title: `Roll back ${textOf(args && args.resource) || 'resource'}`, kind: 'other' }),
    isConcurrencySafe: () => false,
    timeoutMs: 3_600_000,
    async execute(args, exec) {
      try {
        const query = args && typeof args.resource === 'string' ? args.resource.trim() : ''
        if (query === '') return { message: '缺少资源参数：请提供资源 id 或名称' }
        const resource = resources.find(query)
        if (!resource) return { message: `未找到资源 "${query}"` }
        const account = accounts.getSecretRecord(resource.serverId)
        if (!account) return { message: `资源 "${resource.name}" 关联的账户不存在` }
        const historyId = args && typeof args.history_id === 'string' && args.history_id.trim() !== '' ? args.history_id.trim() : undefined
        return await update.rollback(account, resource.id, {
          agentId: exec && exec.agent ? exec.agent.id : undefined,
          historyId,
        })
      } catch (error) {
        return { message: errorMessage(error) || '回滚失败' }
      }
    },
  }
}

/**
 * Build the `ssh_helper_upload` tool.
 * @param {{ accounts: object, upload: object }} services - services.
 * @returns {object} tool definition.
 */
function uploadTool({ accounts, upload }) {
  return {
    name: 'ssh_helper_upload',
    description:
      'Upload one local file to a remote server over SFTP and verify its size and SHA-256 on the server. Use it to push build artifacts (for example a dist tarball) before running ssh_helper_update_plan and ssh_helper_update_apply. This tool is always gated by the harness approval prompt; without an approved allowed-once decision nothing is transferred.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Account id or name of the target server' },
        local_path: { type: 'string', description: 'Absolute path of the local file to upload' },
        remote_path: { type: 'string', description: 'Absolute path of the destination file on the server, e.g. /tmp/app-dist.tgz' },
        resource: { type: 'string', description: 'Optional deployment resource id or name this upload is for' },
        timeout_seconds: { type: 'number', description: 'Upload timeout in seconds (5-3600, default 300)' },
      },
      required: ['server', 'local_path', 'remote_path'],
    },
    output: { schema: HISTORY_OUTPUT_SCHEMA, render: renderHistory },
    presentCall: (args) => ({ card: 'generic', title: `Upload to ${textOf(args && args.server) || 'server'}`, kind: 'other' }),
    isConcurrencySafe: () => false,
    timeoutMs: 3_600_000,
    async execute(args, exec) {
      try {
        const query = args && typeof args.server === 'string' ? args.server.trim() : ''
        if (query === '') return { message: '缺少服务器参数：请提供账户 id 或名称' }
        if (!accounts.find(query)) return { message: `未找到账户 "${query}"，请先用 ssh_helper_accounts 的 list 操作查看` }
        if (typeof (args && args.local_path) !== 'string' || args.local_path.trim() === '') {
          return { message: '缺少 local_path：请提供要上传的本地文件的绝对路径' }
        }
        if (typeof (args && args.remote_path) !== 'string' || args.remote_path.trim() === '') {
          return { message: '缺少 remote_path：请提供目标文件的绝对路径' }
        }
        let target
        try {
          target = upload.resolve(args)
        } catch (error) {
          return { message: errorMessage(error) || '上传参数无效' }
        }
        return await upload.execute(target, { agentId: exec && exec.agent ? exec.agent.id : undefined })
      } catch (error) {
        return { message: errorMessage(error) || '上传失败' }
      }
    },
  }
}

/**
 * Register the agent tools.
 *
 * The three remote-write tools (`ssh_helper_update_apply`,
 * `ssh_helper_update_rollback`, `ssh_helper_upload`) are registered only when
 * `allowWrites` is true. The host entry point passes `false` when the approval
 * gate could not be mounted, because a write tool without a gate is a write
 * with no approval: the DSH `tools/pre-execute` waterfall defaults to
 * `{ kind: 'allow' }`, so an absent gate means "allow". Failing closed here
 * keeps the read-only tools usable while never shipping an unguarded writer.
 *
 * @param {object} ctx - host plugin context (`tools` service).
 * @param {{ accounts: object, resources: object, history: object, ssh: object, discover: object, update: object, upload: object, allowWrites?: boolean }} services - services.
 * @returns {(() => void)[]} tool disposers.
 */
export function registerTools(ctx, services = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-ssh-helper: tools service is unavailable')
  }
  const { accounts, resources, history, ssh, discover, update, upload } = services
  if (!accounts || !resources || !history || !ssh || !discover || !update || !upload) {
    throw new Error('dsh-ssh-helper: tool services are unavailable')
  }
  const allowWrites = services.allowWrites !== false
  if (!allowWrites) {
    try {
      ctx?.logger?.warn?.(
        'dsh-ssh-helper: approval gate unavailable, registering read-only tools only (update/rollback/upload are disabled)',
      )
    } catch {
      /* logging is best effort */
    }
  }
  const definitions = [
    accountsTool({ accounts, ssh }),
    discoverTool({ accounts, discover }),
    resourcesTool({ accounts, resources, history }),
    planTool({ accounts, resources, update }),
  ]
  if (allowWrites) definitions.push(applyTool({ accounts, update }), rollbackTool({ accounts, resources, update }), uploadTool({ accounts, upload }))
  const disposers = []
  for (const definition of definitions) {
    try {
      const disposer = ctx.tools.register(definition)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      try {
        ctx?.logger?.warn?.(`dsh-ssh-helper: failed to register tool "${definition.name}": ${errorMessage(error)}`)
      } catch {
        /* logging is best effort */
      }
    }
  }
  return disposers
}
