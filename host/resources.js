/**
 * Persistent deployment resource store.
 *
 * A resource is one service directory on one SSH account: where it lives, how
 * to update/restart/verify it, and what was discovered about it. Resources hold
 * no credentials; the public view adds `serverName` from the account store.
 * The file is written atomically to `resources.json` with mode `0600`.
 *
 * @module host/resources
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createJsonFile } from './atomic.js'
import { validateRemotePath } from './shell.js'

/** File name inside the plugin data directory. */
const DATA_FILE = 'resources.json'
/** Maximum display name length. */
const NAME_MAX_LENGTH = 200
/** Maximum note length. */
const NOTE_MAX_LENGTH = 500
/** Maximum command length. */
const COMMAND_MAX_LENGTH = 8192
/** Maximum number of tags. */
const TAGS_MAX = 32
/** Default backup retention. */
const DEFAULT_BACKUP_KEEP = 5
/** Default step timeout in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 600

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

/** @returns {Error} conflict error. */
function conflict(message) {
  return taggedError('conflict', message)
}

/** @returns {Error} not-found error. */
function notFound(message) {
  return taggedError('not-found', message)
}

/** @returns {Error} storage error. */
function storageError(cause) {
  return taggedError('storage', '无法保存资源数据', cause)
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pick an incoming value, falling back to the stored value.
 * @param {object} draft - incoming draft.
 * @param {string} key - field name.
 * @param {object | undefined} existing - stored record.
 * @returns {unknown} effective value.
 */
function pick(draft, key, existing) {
  const value = draft[key]
  if (value !== undefined) return value
  if (existing === undefined) return undefined
  return existing[key]
}

/**
 * Read an optional, trimmed string field.
 * @param {unknown} value - raw value.
 * @param {string} label - field label.
 * @param {number} maxLength - maximum length.
 * @returns {string | undefined} trimmed value or undefined.
 */
function readText(value, label, maxLength) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${label}格式无效`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > maxLength) throw invalid(`${label}最多 ${maxLength} 个字符`)
  return trimmed
}

/**
 * Read a required, non-empty string field.
 * @param {unknown} value - raw value.
 * @param {string} label - field label.
 * @param {number} maxLength - maximum length.
 * @returns {string} trimmed value.
 */
function readRequiredText(value, label, maxLength) {
  const text = readText(value, label, maxLength)
  if (text === undefined) throw invalid(`${label}不能为空`)
  return text
}

/**
 * Read a boolean field with a fallback.
 * @param {unknown} value - raw value.
 * @param {string} label - field label.
 * @param {boolean} fallback - default.
 * @returns {boolean} effective value.
 */
function readBoolean(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw invalid(`${label}必须是布尔值`)
  return value
}

/**
 * Read a clamped integer field.
 * @param {unknown} value - raw value.
 * @param {string} label - field label.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - default.
 * @returns {number} clamped integer.
 */
function readClampedInteger(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) throw invalid(`${label}必须是数字`)
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Normalize the tag list.
 * @param {unknown} value - raw tags.
 * @param {string[]} [fallback] - values used when the field is absent.
 * @returns {string[]} normalized tags.
 */
function readTags(value, fallback = []) {
  if (value === undefined || value === null) return fallback.slice()
  if (!Array.isArray(value)) throw invalid('标签必须是字符串数组')
  const tags = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw invalid('标签必须是字符串数组')
    const trimmed = entry.trim()
    if (trimmed === '' || tags.includes(trimmed)) continue
    tags.push(trimmed)
    if (tags.length >= TAGS_MAX) break
  }
  return tags
}

/**
 * Read an array of strings for a discovered fact.
 * @param {unknown} value - raw value.
 * @param {number} maxItems - maximum retained items.
 * @returns {string[]} strings.
 */
function readStringArray(value, maxItems) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || items.includes(trimmed)) continue
    items.push(trimmed)
    if (items.length >= maxItems) break
  }
  return items
}

/**
 * Normalize the optional `discovered` snapshot from an inspect call.
 * @param {unknown} value - raw discovered value.
 * @param {object | undefined} existing - stored discovered value.
 * @returns {object | null} sanitized snapshot or null.
 */
function readDiscovered(value, existing) {
  if (value === undefined) return existing === undefined ? null : existing
  if (value === null) return null
  if (!isObject(value)) throw invalid('采集信息格式无效')
  const snapshot = {}
  if (typeof value.os === 'string' && value.os.trim() !== '') snapshot.os = value.os.trim()
  if (typeof value.user === 'string' && value.user.trim() !== '') snapshot.user = value.user.trim()
  if (typeof value.sizeKB === 'number' && Number.isFinite(value.sizeKB) && value.sizeKB >= 0) snapshot.sizeKB = value.sizeKB
  snapshot.markers = readStringArray(value.markers, 200)
  if (typeof value.gitRemote === 'string') snapshot.gitRemote = value.gitRemote
  if (typeof value.gitBranch === 'string') snapshot.gitBranch = value.gitBranch
  snapshot.serviceUnits = readStringArray(value.serviceUnits, 200)
  snapshot.inspectedAt =
    typeof value.inspectedAt === 'string' && value.inspectedAt !== '' ? value.inspectedAt : new Date().toISOString()
  return snapshot
}

/**
 * Whether a backup directory lies inside the app directory.
 * @param {string} appDir - normalized app directory.
 * @param {string} backupDir - normalized backup directory.
 * @returns {boolean} containment.
 */
function isInside(appDir, backupDir) {
  return backupDir === appDir || backupDir.startsWith(`${appDir}/`)
}

/**
 * Build a complete internal resource record.
 * @param {object} draft - create/update payload.
 * @param {object | undefined} existing - stored record.
 * @param {object} accounts - account store.
 * @returns {object} complete record.
 */
function buildRecord(draft, existing, accounts) {
  if (!isObject(draft)) throw invalid('请求内容无效')

  let name
  const rawName = pick(draft, 'name', existing)
  if (typeof rawName === 'string') {
    const trimmed = rawName.trim()
    name = trimmed === '' ? (existing && existing.name) : trimmed
  } else if (rawName === undefined || rawName === null) {
    name = existing && existing.name
  } else {
    throw invalid('资源名称格式无效')
  }
  if (typeof name !== 'string' || name === '') throw invalid('资源名称不能为空')
  if (name.length > NAME_MAX_LENGTH) throw invalid(`资源名称最多 ${NAME_MAX_LENGTH} 个字符`)
  // A resource name is a label shown in the approval prompt, never a script.
  // Line breaks would let the name forge prompt chrome (`Backup: disabled.`),
  // so they are rejected here rather than sanitised at every display site.
  if (/[\r\n\u2028\u2029]/.test(name)) throw invalid('资源名称不能包含换行')

  let serverId
  if (typeof draft.serverId === 'string' && draft.serverId.trim() !== '') {
    serverId = draft.serverId.trim()
  } else if (typeof draft.server === 'string' && draft.server.trim() !== '') {
    const account = accounts.find(draft.server.trim())
    if (!account) throw invalid('服务器不存在')
    serverId = account.id
  } else if (existing && typeof existing.serverId === 'string' && existing.serverId !== '') {
    serverId = existing.serverId
  }
  if (typeof serverId !== 'string' || serverId === '') throw invalid('请选择服务器')
  if (!accounts.get(serverId)) throw invalid('服务器不存在')

  const rawAppDir = pick(draft, 'appDir', existing)
  if (rawAppDir === undefined || rawAppDir === null || rawAppDir === '') throw invalid('应用目录不能为空')
  const appDir = validateRemotePath(rawAppDir)

  const rawUpdate = pick(draft, 'updateCommand', existing)
  const updateCommand = readRequiredText(rawUpdate, '更新命令', COMMAND_MAX_LENGTH)

  const restartCommand = readText(pick(draft, 'restartCommand', existing), '重启命令', COMMAND_MAX_LENGTH)
  const verifyCommand = readText(pick(draft, 'verifyCommand', existing), '校验命令', COMMAND_MAX_LENGTH)
  const serviceName = readText(pick(draft, 'serviceName', existing), '服务名称', NAME_MAX_LENGTH)

  const backupEnabled = readBoolean(pick(draft, 'backupEnabled', existing), '备份开关', true)
  const rawBackupDir = readText(pick(draft, 'backupDir', existing), '备份目录', 1024)
  const backupDir = rawBackupDir === undefined ? undefined : validateRemotePath(rawBackupDir)
  if (backupDir !== undefined && isInside(appDir, backupDir)) throw invalid('备份目录不能位于应用目录内部')

  const backupKeep = readClampedInteger(pick(draft, 'backupKeep', existing), '备份保留数量', 1, 50, DEFAULT_BACKUP_KEEP)
  const timeoutSeconds = readClampedInteger(
    pick(draft, 'timeoutSeconds', existing),
    '超时时间',
    30,
    3600,
    DEFAULT_TIMEOUT_SECONDS,
  )

  const rawNote = pick(draft, 'note', existing)
  let note
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== 'string') throw invalid('备注格式无效')
    note = rawNote.trim()
    if (note.length > NOTE_MAX_LENGTH) throw invalid(`备注最多 ${NOTE_MAX_LENGTH} 个字符`)
  }

  const tags = readTags(pick(draft, 'tags', existing), existing && Array.isArray(existing.tags) ? existing.tags : [])
  const discovered = readDiscovered(pick(draft, 'discovered', existing), existing ? existing.discovered : undefined)

  const now = new Date().toISOString()
  const record = {
    id: existing && typeof existing.id === 'string' ? existing.id : randomUUID(),
    name,
    serverId,
    appDir,
    updateCommand,
    backupEnabled,
    backupKeep,
    timeoutSeconds,
    tags,
    discovered: discovered === undefined ? null : discovered,
    createdAt: existing && typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  }
  if (serviceName !== undefined) record.serviceName = serviceName
  if (restartCommand !== undefined) record.restartCommand = restartCommand
  if (verifyCommand !== undefined) record.verifyCommand = verifyCommand
  if (backupDir !== undefined) record.backupDir = backupDir
  if (note !== undefined && note !== '') record.note = note
  if (existing && typeof existing.lastUpdateAt === 'string') record.lastUpdateAt = existing.lastUpdateAt
  if (existing && typeof existing.lastUpdateStatus === 'string') record.lastUpdateStatus = existing.lastUpdateStatus
  if (existing && typeof existing.lastBackupPath === 'string') record.lastBackupPath = existing.lastBackupPath
  return record
}

/**
 * Project one record to its public view, adding the account display name.
 * @param {object} record - internal record.
 * @param {object} accounts - account store.
 * @returns {object} public view.
 */
function toView(record, accounts) {
  const account = accounts.get(record.serverId)
  const view = {
    id: String(record.id ?? ''),
    name: typeof record.name === 'string' ? record.name : '',
    serverId: typeof record.serverId === 'string' ? record.serverId : '',
    serverName: account && typeof account.name === 'string' ? account.name : '',
    appDir: typeof record.appDir === 'string' ? record.appDir : '',
    updateCommand: typeof record.updateCommand === 'string' ? record.updateCommand : '',
    backupEnabled: record.backupEnabled === true,
    backupKeep: Number.isInteger(record.backupKeep) ? record.backupKeep : DEFAULT_BACKUP_KEEP,
    timeoutSeconds: Number.isInteger(record.timeoutSeconds) ? record.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
    tags: Array.isArray(record.tags) ? record.tags.filter((entry) => typeof entry === 'string') : [],
    discovered: record.discovered === null || record.discovered === undefined ? null : record.discovered,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
  if (typeof record.serviceName === 'string' && record.serviceName !== '') view.serviceName = record.serviceName
  if (typeof record.restartCommand === 'string' && record.restartCommand !== '') view.restartCommand = record.restartCommand
  if (typeof record.verifyCommand === 'string' && record.verifyCommand !== '') view.verifyCommand = record.verifyCommand
  if (typeof record.backupDir === 'string' && record.backupDir !== '') view.backupDir = record.backupDir
  if (typeof record.note === 'string' && record.note !== '') view.note = record.note
  if (typeof record.lastUpdateAt === 'string' && record.lastUpdateAt !== '') view.lastUpdateAt = record.lastUpdateAt
  if (typeof record.lastUpdateStatus === 'string' && record.lastUpdateStatus !== '') view.lastUpdateStatus = record.lastUpdateStatus
  if (typeof record.lastBackupPath === 'string' && record.lastBackupPath !== '') view.lastBackupPath = record.lastBackupPath
  return view
}

/**
 * Whether one parsed entry is a usable persisted resource.
 * @param {unknown} entry - parsed entry.
 * @returns {boolean} validity.
 */
function isPersistedRecord(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.name !== 'string' || entry.name === '') return false
  if (typeof entry.serverId !== 'string' || entry.serverId === '') return false
  if (typeof entry.appDir !== 'string' || entry.appDir === '') return false
  if (typeof entry.updateCommand !== 'string' || entry.updateCommand.trim() === '') return false
  return true
}

/**
 * Keep only known fields of a persisted resource.
 * @param {object} entry - parsed record.
 * @returns {object} sanitized record.
 */
function sanitizePersisted(entry) {
  const record = {
    id: entry.id,
    name: entry.name,
    serverId: entry.serverId,
    appDir: entry.appDir,
    updateCommand: entry.updateCommand,
    backupEnabled: entry.backupEnabled !== false,
    backupKeep: Number.isInteger(entry.backupKeep) ? Math.min(50, Math.max(1, entry.backupKeep)) : DEFAULT_BACKUP_KEEP,
    timeoutSeconds: Number.isInteger(entry.timeoutSeconds)
      ? Math.min(3600, Math.max(30, entry.timeoutSeconds))
      : DEFAULT_TIMEOUT_SECONDS,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string') : [],
    discovered: isObject(entry.discovered) || entry.discovered === null ? entry.discovered : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
  }
  for (const key of ['serviceName', 'restartCommand', 'verifyCommand', 'backupDir', 'note', 'lastUpdateAt', 'lastUpdateStatus', 'lastBackupPath']) {
    if (typeof entry[key] === 'string' && entry[key] !== '') record[key] = entry[key]
  }
  return record
}

/**
 * Create the resource store.
 * @param {{ dir: string, accounts: object }} options - data directory and account store.
 * @returns {{
 *   dataDir: () => string,
 *   load: () => void,
 *   list: (options?: { server?: string }) => object[],
 *   get: (id: string) => object | undefined,
 *   find: (query: string) => object | undefined,
 *   save: (draft: object) => Promise<object>,
 *   remove: (id: string) => Promise<boolean>,
 *   toView: (record: object) => object | undefined,
 *   markUpdated: (id: string, patch: { at?: string, status?: string, backupPath?: string }) => Promise<object | undefined>,
 * }} store API.
 */
export function createResourceStore({ dir, accounts } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createResourceStore: dir is required')
  if (!accounts || typeof accounts.get !== 'function' || typeof accounts.find !== 'function') {
    throw new TypeError('createResourceStore: accounts store is required')
  }
  const resolvedDir = path.resolve(dir)
  const file = createJsonFile({ dir: resolvedDir, filename: DATA_FILE })

  /** @type {object[]} internal records. */
  let records = []
  let loaded = false
  /** @type {Promise<unknown>} tail of the serialized mutation chain. */
  let mutationTail = Promise.resolve()

  /** Read the data file once; never throws. */
  function load() {
    if (loaded) return
    loaded = true
    const parsed = file.read()
    records = Array.isArray(parsed) ? parsed.filter(isPersistedRecord).map(sanitizePersisted) : []
  }

  /** Ensure the lazy read happened. */
  function ensureLoaded() {
    if (!loaded) load()
  }

  /**
   * @param {string} id - record id.
   * @returns {object | undefined} internal record.
   */
  function rawById(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return records.find((record) => record.id === id)
  }

  /**
   * Reject a display name used by another resource (case-insensitive).
   * @param {string} name - candidate name.
   * @param {string} selfId - id of the record being written.
   * @throws {Error} conflict when another resource owns the name.
   */
  function assertNameAvailable(name, selfId) {
    const wanted = name.toLowerCase()
    const clash = records.find((record) => record.id !== selfId && typeof record.name === 'string' && record.name.toLowerCase() === wanted)
    if (clash) throw conflict('资源名称已存在')
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

  /** @returns {string} resolved data directory. */
  function dataDir() {
    return resolvedDir
  }

  /**
   * List resources, optionally filtered by account id/name.
   * @param {{ server?: string }} [options] - filter.
   * @returns {object[]} public views sorted by name.
   */
  function list({ server } = {}) {
    ensureLoaded()
    /** @type {string | undefined} */
    let filterId
    if (typeof server === 'string' && server.trim() !== '') {
      const found = accounts.find(server.trim())
      filterId = found ? found.id : server.trim()
    }
    const selected = filterId === undefined ? records : records.filter((record) => record.serverId === filterId)
    return selected
      .slice()
      .sort((left, right) => String(left.name).localeCompare(String(right.name)))
      .map((record) => toView(record, accounts))
  }

  /**
   * @param {string} id - record id.
   * @returns {object | undefined} public view.
   */
  function get(id) {
    ensureLoaded()
    const record = rawById(id)
    return record === undefined ? undefined : toView(record, accounts)
  }

  /**
   * Resolve a resource by id, exact name (case-insensitive), then a unique name
   * prefix.
   * @param {string} query - id or name text.
   * @returns {object | undefined} public view.
   */
  function find(query) {
    ensureLoaded()
    if (typeof query !== 'string') return undefined
    const text = query.trim()
    if (text === '') return undefined
    const byId = records.find((record) => record.id === text)
    if (byId) return toView(byId, accounts)
    const lower = text.toLowerCase()
    const byName = records.find((record) => typeof record.name === 'string' && record.name.toLowerCase() === lower)
    if (byName) return toView(byName, accounts)
    const byPrefix = records.filter((record) => typeof record.name === 'string' && record.name.toLowerCase().startsWith(lower))
    if (byPrefix.length === 1) return toView(byPrefix[0], accounts)
    return undefined
  }

  /**
   * Create or update one resource.
   * @param {object} draft - flat payload; `id` updates an existing resource.
   * @returns {Promise<object>} public view.
   */
  function save(draft) {
    ensureLoaded()
    return enqueue(async () => {
      if (!isObject(draft)) throw invalid('请求内容无效')
      const id = typeof draft.id === 'string' && draft.id.trim() !== '' ? draft.id.trim() : ''
      const existing = id === '' ? undefined : rawById(id)
      if (id !== '' && existing === undefined) throw notFound('资源不存在')
      const record = buildRecord(draft, existing, accounts)
      assertNameAvailable(record.name, record.id)
      const previous = records
      records = existing === undefined ? [...records, record] : records.map((entry) => (entry.id === record.id ? record : entry))
      try {
        await file.write(records)
      } catch (error) {
        records = previous
        throw storageError(error)
      }
      return toView(record, accounts)
    })
  }

  /**
   * Remove one resource.
   * @param {string} id - record id.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  function remove(id) {
    ensureLoaded()
    return enqueue(async () => {
      if (!rawById(id)) return false
      const previous = records
      records = records.filter((record) => record.id !== id)
      try {
        await file.write(records)
      } catch (error) {
        records = previous
        throw storageError(error)
      }
      return true
    })
  }

  /**
   * Record the outcome of an update attempt on one resource.
   * @param {string} id - record id.
   * @param {{ at?: string, status?: string, backupPath?: string }} patch - outcome fields.
   * @returns {Promise<object | undefined>} public view, or undefined when absent.
   */
  function markUpdated(id, patch = {}) {
    ensureLoaded()
    return enqueue(async () => {
      const existing = rawById(id)
      if (!existing) return undefined
      const now = new Date().toISOString()
      const updated = { ...existing, updatedAt: now }
      updated.lastUpdateAt = typeof patch.at === 'string' && patch.at !== '' ? patch.at : now
      if (typeof patch.status === 'string' && patch.status !== '') updated.lastUpdateStatus = patch.status
      if (typeof patch.backupPath === 'string') updated.lastBackupPath = patch.backupPath
      const previous = records
      records = records.map((record) => (record.id === id ? updated : record))
      try {
        await file.write(records)
      } catch (error) {
        records = previous
        throw storageError(error)
      }
      return toView(updated, accounts)
    })
  }

  return { dataDir, load, list, get, find, save, remove, toView: (record) => toView(record, accounts), markUpdated }
}
