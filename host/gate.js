/**
 * Harness-native approval gate for remote updates.
 *
 * The gate is registered on `tools/pre-execute`. It is the only place that
 * turns a valid `ssh_helper_update_apply` plan (or a resolvable
 * `ssh_helper_update_rollback` backup) into `{ kind: 'ask' }`; every other tool
 * and every invalid or expired request falls through with `next()` so the tool
 * body can return its own guidance error. There is deliberately no `confirm`,
 * `force` or `skip_approval` parameter.
 *
 * @module host/gate
 */

import { remotePathWarnings, shQuote } from './shell.js'

/** Tool name for the approved update. */
const APPLY_TOOL = 'ssh_helper_update_apply'
/** Tool name for the approved rollback. */
const ROLLBACK_TOOL = 'ssh_helper_update_rollback'
/** Tool name for the approved upload. */
const UPLOAD_TOOL = 'ssh_helper_upload'
/** Maximum command length shown in an approval reason. */
const REASON_COMMAND_LIMIT = 300

/**
 * Truncate one command for the approval prompt.
 * @param {unknown} value - raw command.
 * @returns {string} truncated text.
 */
function cut(value) {
  if (typeof value !== 'string') return ''
  return value.length <= REASON_COMMAND_LIMIT ? value : `${value.slice(0, REASON_COMMAND_LIMIT)}…`
}

/**
 * Make one text value safe for a single-line approval reason.
 *
 * The approval prompt is a security boundary: every interpolated value must be
 * flattened onto one line, otherwise a resource name or path carrying `\n`
 * could forge prompt chrome such as a second `Backup: disabled.` line. Control
 * characters and bidirectional overrides are dropped as well, so a path cannot
 * render reversed in the prompt the operator reads.
 *
 * @param {unknown} value - raw text.
 * @returns {string} one-line text.
 */
function line(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Delimiter that fences a verbatim multi-line command inside a prompt. */
const FENCE = '----- command (verbatim) -----'

/**
 * Render a command block the operator can read as data, never as prompt chrome.
 *
 * Multi-line shell scripts are legitimate, so they are not rejected; instead
 * they are fenced so a reader cannot mistake a line of the script for one of
 * the prompt's own labels. The block is truncated to keep the prompt short.
 *
 * @param {unknown} value - raw command.
 * @returns {string[]} three lines: opening fence, body, closing fence.
 */
function fence(value) {
  const text = typeof value === 'string' ? value.replace(/[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '') : ''
  return [FENCE, cut(text), FENCE]
}

/**
 * Build the approval decision for one valid apply plan.
 * @param {object} plan - cached plan.
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, zh: string } }} decision.
 */
function askForApply(plan) {
  const backup = line(plan.backup && plan.backup.enabled ? plan.backup.file : 'disabled')
  const name = line(plan.resourceName)
  const server = line(plan.serverName)
  const dir = line(plan.appDir)
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.map(line).filter(Boolean) : []
  const restart = line(plan.restartCommand)
  const verify = line(plan.verifyCommand)

  const english = [
    `Approve remote update plan ${line(plan.id)} for "${name}" on ${server} (${dir}).`,
    `Backup: ${backup}.`,
    ...fence(plan.updateCommand),
  ]
  if (restart !== '') english.push(`Restart command: ${cut(restart)}`)
  if (verify !== '') english.push(`Verify command: ${cut(verify)}`)
  if (warnings.length > 0) english.push(`Warnings: ${warnings.join('; ')}`)

  const chinese = [
    `批准更新 "${name}"：服务器 ${server}，目录 ${dir}。`,
    `备份：${backup}。`,
    ...fence(plan.updateCommand),
  ]
  if (restart !== '') chinese.push(`重启命令：${cut(restart)}`)
  if (verify !== '') chinese.push(`校验命令：${cut(verify)}`)
  if (warnings.length > 0) chinese.push(`警告：${warnings.join('；')}`)

  return {
    kind: 'ask',
    reason: english.join('\n'),
    displayReason: { en: english.join('\n'), zh: chinese.join('\n') },
  }
}

/**
 * Build the approval decision for one valid rollback target.
 * @param {object} target - rollback target from `update.resolveRollbackTarget`.
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, zh: string } }} decision.
 */
function askForRollback(target) {
  const resource = target.resource
  const name = line(resource.name)
  const server = line(resource.serverName || '')
  const dir = line(resource.appDir)
  const backupPath = line(target.backupPath)
  const parent = line(target.parent)
  const warnings = Array.isArray(remotePathWarnings(resource.appDir)) ? remotePathWarnings(resource.appDir).map(line).filter(Boolean) : []
  const restart = line(resource.restartCommand)
  const verify = line(resource.verifyCommand)
  const restoreCommand = `tar -C ${shQuote(parent)} -xzf ${shQuote(backupPath)}`
  const english = [
    `Approve rollback of "${name}" on ${server} (${dir}).`,
    `Restore backup: ${backupPath}.`,
    `The current directory is moved aside before extraction.`,
    `Restore command: ${cut(restoreCommand)}`,
  ]
  if (restart !== '') english.push(`Restart command: ${cut(restart)}`)
  if (verify !== '') english.push(`Verify command: ${cut(verify)}`)
  if (warnings.length > 0) english.push(`Warnings: ${warnings.join('; ')}`)

  const chinese = [
    `批准回滚 "${name}"：服务器 ${server}，目录 ${dir}。`,
    `恢复备份：${backupPath}。`,
    `解压前会先把当前目录移动到一旁。`,
    `恢复命令：${cut(restoreCommand)}`,
  ]
  if (restart !== '') chinese.push(`重启命令：${cut(restart)}`)
  if (verify !== '') chinese.push(`校验命令：${cut(verify)}`)
  if (warnings.length > 0) chinese.push(`警告：${warnings.join('；')}`)

  return {
    kind: 'ask',
    reason: english.join('\n'),
    displayReason: { en: english.join('\n'), zh: chinese.join('\n') },
  }
}

/**
 * Format one byte count for a prompt line.
 * @param {unknown} value - raw bytes.
 * @returns {string} human readable size.
 */
function size(value) {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

/**
 * Build the approval decision for one valid upload target.
 * @param {object} target - value from `upload.resolve`.
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, zh: string } }} decision.
 */
function askForUpload(target) {
  const warnings = Array.isArray(target.warnings) ? target.warnings.map(line).filter(Boolean) : []
  const fileName = line(target.fileName)
  const serverName = line(target.serverName)
  const remotePath = line(target.remotePath)
  const localPath = line(target.localPath)
  const resourceName = line(target.resourceName)
  const english = [
    `Approve upload of "${fileName}" (${size(target.sizeBytes)}) to ${serverName} at ${remotePath}.`,
    `Local file: ${localPath}.`,
    `The file is transferred over SFTP, then its size and SHA-256 are verified on the server.`,
  ]
  if (resourceName !== '') english.push(`Deployment resource: ${resourceName}.`)
  if (warnings.length > 0) english.push(`Warnings: ${warnings.join('; ')}`)

  const chinese = [
    `批准上传 "${fileName}"（${size(target.sizeBytes)}）到 ${serverName} 的 ${remotePath}。`,
    `本地文件：${localPath}。`,
    `文件通过 SFTP 传输，随后在服务器上校验大小与 SHA-256。`,
  ]
  if (resourceName !== '') chinese.push(`部署资源：${resourceName}。`)
  if (warnings.length > 0) chinese.push(`警告：${warnings.join('；')}`)

  return {
    kind: 'ask',
    reason: english.join('\n'),
    displayReason: { en: english.join('\n'), zh: chinese.join('\n') },
  }
}

/**
 * Create the `tools/pre-execute` handler.
 * @param {{ update: object, upload?: object, resources: object }} services - services (`update` must expose `peekPlan` and `resolveRollbackTarget`; `upload` must expose `resolve`).
 * @returns {(exec: object, next: Function) => Promise<object>} waterfall handler.
 */
export function createUpdateGate({ update, upload, resources } = {}) {
  if (!update || typeof update !== 'object') throw new TypeError('createUpdateGate: update service is required')
  void resources

  return async function updateGate(exec, next) {
    try {
      const name =
        exec && typeof exec.name === 'string'
          ? exec.name
          : exec && typeof exec.toolName === 'string'
            ? exec.toolName
            : exec && exec.tool && typeof exec.tool.name === 'string'
              ? exec.tool.name
              : ''
      if (name !== APPLY_TOOL && name !== ROLLBACK_TOOL && name !== UPLOAD_TOOL) return next()

      const args =
        exec && typeof exec.arguments === 'object' && exec.arguments !== null && !Array.isArray(exec.arguments)
          ? exec.arguments
          : {}
      const agentId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : undefined

      if (name === APPLY_TOOL) {
        const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : ''
        if (planId === '' || typeof update.peekPlan !== 'function') return next()
        const plan = update.peekPlan(planId, agentId)
        if (!plan || !Array.isArray(plan.blockers) || plan.blockers.length > 0) return next()
        return askForApply(plan)
      }

      if (name === UPLOAD_TOOL) {
        if (!upload || typeof upload.resolve !== 'function') return next()
        let target
        try {
          target = upload.resolve(args)
        } catch {
          // An invalid request is rejected by the tool body with guidance; it is
          // never turned into an approval prompt.
          return next()
        }
        return askForUpload(target)
      }

      if (typeof update.resolveRollbackTarget !== 'function') return next()
      const resource = typeof args.resource === 'string' ? args.resource.trim() : ''
      if (resource === '') return next()
      const historyId = typeof args.history_id === 'string' ? args.history_id.trim() : undefined
      const target = update.resolveRollbackTarget(resource, historyId)
      if (!target) return next()
      if (typeof update.pinRollback !== 'function') return next()
      update.pinRollback(target, agentId)
      return askForRollback(target)
    } catch {
      return next()
    }
  }
}
