/**
 * System-prompt section for dsh-ssh-helper.
 *
 * The text is rebuilt on every prompt assembly from the live stores, so the
 * model sees the accounts and deployment resources configured right now. It
 * only reads public views, which never contain credentials.
 *
 * @module host/prompt
 */

/** Unique prompt section name. */
const SECTION_NAME = 'ssh-helper:resources'
/** Section order. */
const SECTION_ORDER = 45

/**
 * Make one user-controlled value safe to embed in a single Markdown line.
 * @param {unknown} value - raw value.
 * @returns {string} one-line text.
 */
function singleLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Build the section text.
 * @param {{ accounts: object, resources: object }} services - stores.
 * @returns {string} prompt text.
 */
function buildText({ accounts, resources }) {
  /** @type {object[]} */
  let accountViews = []
  /** @type {object[]} */
  let resourceViews = []
  try {
    accountViews = accounts.list()
  } catch {
    accountViews = []
  }
  try {
    resourceViews = resources.list()
  } catch {
    resourceViews = []
  }
  if (!Array.isArray(accountViews)) accountViews = []
  if (!Array.isArray(resourceViews)) resourceViews = []

  const lines = ['## SSH Helper', '']

  if (accountViews.length === 0) {
    lines.push('No SSH accounts are configured. The user can add accounts in the SSH Helper panel in the left sidebar.')
  } else {
    lines.push('Configured SSH accounts (credentials are never shown):')
    for (const account of accountViews) {
      const name = singleLine(account.name)
      const username = singleLine(account.username)
      const host = singleLine(account.host)
      const port = typeof account.port === 'number' ? account.port : 22
      const auth = account.authType === 'key' ? 'private key' : 'password'
      lines.push(`- ${name} — ${username}@${host}:${port} (${auth} auth)`)
    }
  }
  lines.push('')

  if (resourceViews.length === 0) {
    lines.push('No deployment resources are catalogued. Discover one with `ssh_helper_discover` (scan/inspect) and save it with `ssh_helper_resources`.')
  } else {
    lines.push('Deployment resources:')
    for (const resource of resourceViews) {
      const name = singleLine(resource.name)
      const serverName = singleLine(resource.serverName) || 'unknown server'
      const appDir = singleLine(resource.appDir)
      const status = singleLine(resource.lastUpdateStatus) || 'never'
      lines.push(`- ${name} — ${serverName}:${appDir} (last update: ${status})`)
    }
  }

  lines.push(
    '',
    'Workflow: use `ssh_helper_discover` to find deployment directories, then `ssh_helper_resources` to save them; use `ssh_helper_upload` to push a local build artifact (SFTP, size and SHA-256 verified) when the deployment needs one; use `ssh_helper_update_plan` to produce a read-only plan, then `ssh_helper_update_apply` to execute it; use `ssh_helper_update_rollback` to restore the last backup.',
    '`ssh_helper_upload`, `ssh_helper_update_apply` and `ssh_helper_update_rollback` always ask the user for approval. Never try to bypass approval, never run managed directory changes through a generic `ssh_exec`, and never put passwords, private keys, passphrases or tokens in update commands.',
  )
  return lines.join('\n')
}

/**
 * Register the `## SSH Helper` system-prompt section.
 * @param {object} ctx - host plugin context (`systemPrompt` service).
 * @param {{ accounts: object, resources: object }} services - stores.
 * @returns {() => void} section disposer.
 */
export function registerPromptSection(ctx, { accounts, resources } = {}) {
  if (!ctx || !ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    throw new Error('dsh-ssh-helper: systemPrompt service is unavailable')
  }
  if (!accounts || !resources) throw new Error('dsh-ssh-helper: prompt services are unavailable')
  return ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => buildText({ accounts, resources }),
  })
}
