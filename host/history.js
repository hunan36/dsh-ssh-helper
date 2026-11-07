/**
 * Persistent update history store.
 *
 * Every apply/rollback attempt is stored newest first in `history.json`, capped
 * at 200 entries. Step output tails are clipped to 8192 characters so history
 * stays bounded and credential shapes are masked before they are persisted, so
 * neither `history.json` nor the browser ever shows a leaked secret. The command
 * text is kept verbatim because it is the audit record. The file is written
 * atomically with mode `0600`.
 *
 * @module host/history
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createJsonFile } from './atomic.js'

/** File name inside the plugin data directory. */
const DATA_FILE = 'history.json'
/** Maximum retained history entries. */
const MAX_ENTRIES = 200
/** Maximum characters kept per captured output tail. */
const TAIL_MAX_LENGTH = 8192
/** Default list limit (all retained entries). */
const DEFAULT_LIST_LIMIT = MAX_ENTRIES
/** Accepted actions. */
const ACTIONS = new Set(['apply', 'rollback', 'upload'])
/** Accepted statuses. */
const STATUSES = new Set(['success', 'partial', 'failed', 'blocked'])

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

/** @returns {Error} storage error. */
function storageError(cause) {
  return taggedError('storage', '无法保存更新历史', cause)
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Mask credential shapes in one captured output tail.
 *
 * Captured stdout/stderr routinely contains secrets: `bash -x`/`set -x` echoes
 * the command after expansion and failing CLIs echo their argv, so a token that
 * only ever existed on the remote host can land in `history.json` and in the
 * browser. The command text itself stays verbatim (it is the audit record) —
 * only the captured output is scrubbed here.
 *
 * @param {string} text - captured output.
 * @returns {string} scrubbed output.
 */
function redactSecrets(text) {
  return text
    .replace(/\b(password|passwd|passphrase|token|secret|api[_-]?key)\b(\s*[=:]\s*)\S+/gi, (_match, name, separator) => `${name}${separator}<redacted>`)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>')
}

/**
 * Clip one captured output tail to the contract maximum (the tail, not the
 * head), then scrub credential shapes from it.
 * @param {unknown} value - raw output.
 * @returns {string} clipped and scrubbed text.
 */
function clipTail(value) {
  if (typeof value !== 'string') return ''
  const clipped = value.length <= TAIL_MAX_LENGTH ? value : value.slice(value.length - TAIL_MAX_LENGTH)
  return redactSecrets(clipped)
}

/**
 * Normalize one history step.
 * @param {unknown} step - raw step.
 * @param {number} index - step index for defaults.
 * @returns {object} sanitized step.
 */
function readStep(step, index) {
  if (!isObject(step)) throw invalid('更新步骤格式无效')
  const id = typeof step.id === 'string' && step.id !== '' ? step.id : `step-${index + 1}`
  const title = typeof step.title === 'string' && step.title !== '' ? step.title : id
  const status = typeof step.status === 'string' && step.status !== '' ? step.status : 'failed'
  const record = {
    id,
    title,
    status,
    exitCode: Number.isInteger(step.exitCode) ? step.exitCode : null,
    durationMs: typeof step.durationMs === 'number' && Number.isFinite(step.durationMs) ? Math.max(0, step.durationMs) : 0,
    stdoutTail: clipTail(step.stdoutTail),
    stderrTail: clipTail(step.stderrTail),
    truncated: step.truncated === true,
  }
  if (typeof step.command === 'string' && step.command !== '') record.command = step.command
  return record
}

/**
 * Normalize one history entry.
 * @param {unknown} entry - raw entry.
 * @returns {object} sanitized entry.
 */
function readEntry(entry) {
  if (!isObject(entry)) throw invalid('更新历史格式无效')
  const action = typeof entry.action === 'string' ? entry.action : ''
  if (!ACTIONS.has(action)) throw invalid('更新历史动作无效')
  const status = typeof entry.status === 'string' ? entry.status : ''
  if (!STATUSES.has(status)) throw invalid('更新历史状态无效')
  const steps = Array.isArray(entry.steps) ? entry.steps.map((step, index) => readStep(step, index)) : []
  const record = {
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : randomUUID(),
    action,
    resourceId: typeof entry.resourceId === 'string' ? entry.resourceId : '',
    resourceName: typeof entry.resourceName === 'string' ? entry.resourceName : '',
    serverId: typeof entry.serverId === 'string' ? entry.serverId : '',
    serverName: typeof entry.serverName === 'string' ? entry.serverName : '',
    appDir: typeof entry.appDir === 'string' ? entry.appDir : '',
    backupPath: typeof entry.backupPath === 'string' ? entry.backupPath : '',
    status,
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : '',
    finishedAt: typeof entry.finishedAt === 'string' ? entry.finishedAt : '',
    durationMs: typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs) : 0,
    steps,
  }
  if (typeof entry.message === 'string' && entry.message !== '') record.message = entry.message
  return record
}

/**
 * Whether a parsed entry can be loaded.
 * @param {unknown} entry - parsed entry.
 * @returns {boolean} usability.
 */
function isUsable(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.action !== 'string' || !ACTIONS.has(entry.action)) return false
  if (typeof entry.status !== 'string' || !STATUSES.has(entry.status)) return false
  if (!Array.isArray(entry.steps)) return false
  return true
}

/**
 * Deep-copy one entry so callers cannot mutate stored state.
 * @param {object} entry - stored entry.
 * @returns {object} copy.
 */
function copyEntry(entry) {
  return JSON.parse(JSON.stringify(entry))
}

/**
 * Create the history store.
 * @param {{ dir: string }} options - plugin data directory.
 * @returns {{
 *   load: () => void,
 *   append: (entry: object) => Promise<object>,
 *   list: (options?: { resourceId?: string, limit?: number }) => object[],
 *   get: (id: string) => object | undefined,
 * }} store API.
 */
export function createHistoryStore({ dir } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createHistoryStore: dir is required')
  const resolvedDir = path.resolve(dir)
  const file = createJsonFile({ dir: resolvedDir, filename: DATA_FILE })

  /** @type {object[]} entries, newest first. */
  let entries = []
  let loaded = false
  /** @type {Promise<unknown>} tail of the serialized mutation chain. */
  let mutationTail = Promise.resolve()

  /** Read the data file once; never throws. */
  function load() {
    if (loaded) return
    loaded = true
    const parsed = file.read()
    if (!Array.isArray(parsed)) {
      entries = []
      return
    }
    entries = parsed.filter(isUsable).slice(0, MAX_ENTRIES).map((entry) => {
      try {
        return readEntry(entry)
      } catch {
        return undefined
      }
    }).filter((entry) => entry !== undefined)
  }

  /** Ensure the lazy read happened. */
  function ensureLoaded() {
    if (!loaded) load()
  }

  /**
   * Serialize one mutation on top of earlier mutations.
   * @template T
   * @param {() => Promise<T>} task - mutation.
   * @returns {Promise<T>} outcome.
   */
  function enqueue(task) {
    const run = mutationTail.then(task, task)
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Append one entry at the front and persist.
   * @param {object} entry - history entry (id assigned when absent).
   * @returns {Promise<object>} stored entry.
   */
  function append(entry) {
    ensureLoaded()
    return enqueue(async () => {
      const record = readEntry(entry)
      const previous = entries
      entries = [record, ...entries].slice(0, MAX_ENTRIES)
      try {
        await file.write(entries)
      } catch (error) {
        entries = previous
        throw storageError(error)
      }
      return copyEntry(record)
    })
  }

  /**
   * List entries newest first.
   * @param {{ resourceId?: string, limit?: number }} [options] - filter and page size.
   * @returns {object[]} entries.
   */
  function list({ resourceId, limit } = {}) {
    ensureLoaded()
    const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(MAX_ENTRIES, Math.max(1, Math.round(limit))) : DEFAULT_LIST_LIMIT
    const filtered =
      typeof resourceId === 'string' && resourceId !== ''
        ? entries.filter((entry) => entry.resourceId === resourceId)
        : entries
    return filtered.slice(0, max).map((entry) => copyEntry(entry))
  }

  /**
   * @param {string} id - entry id.
   * @returns {object | undefined} entry copy.
   */
  function get(id) {
    ensureLoaded()
    if (typeof id !== 'string' || id === '') return undefined
    const entry = entries.find((candidate) => candidate.id === id)
    return entry === undefined ? undefined : copyEntry(entry)
  }

  return { load, append, list, get }
}
