/**
 * Persistent SSH account store.
 *
 * Accounts contain credentials (password, private key and passphrase), so every
 * public projection in this module deliberately drops them. Only
 * `getSecretRecord` and `testDraft` return the full record, and both are
 * host-side only. The file is written atomically to `accounts.json` with mode
 * `0600`; a corrupt file is quarantined by `host/atomic.js`.
 *
 * @module host/accounts
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createJsonFile } from './atomic.js'

/** File name inside the plugin data directory. */
const DATA_FILE = 'accounts.json'
/** Maximum display name length. */
const NAME_MAX_LENGTH = 200
/** Maximum note length. */
const NOTE_MAX_LENGTH = 500
/** Default SSH port. */
const DEFAULT_PORT = 22
/** Supported authentication types. */
const AUTH_TYPES = new Set(['password', 'key'])

/**
 * Resolve the plugin data directory: `DSH_SSH_HELPER_DIR`, then
 * `<DSH_HOME>/ssh-helper`, then `~/.dsh/ssh-helper`.
 * @returns {string} absolute data directory.
 */
export function resolveDataDir() {
  const explicit = process.env.DSH_SSH_HELPER_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return path.join(path.resolve(home.trim()), 'ssh-helper')
  return path.join(homedir(), '.dsh', 'ssh-helper')
}

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
  return taggedError('storage', '无法保存账户数据', cause)
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one optional string field.
 * @param {unknown} value - raw value.
 * @param {string} label - field label for errors.
 * @param {boolean} [allowEmpty] - whether an empty string is accepted.
 * @returns {string | undefined} trimmed value or undefined.
 */
function readString(value, label, allowEmpty = false) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${label}格式无效`)
  const trimmed = value.trim()
  if (!allowEmpty && trimmed === '') return undefined
  return trimmed
}

/**
 * Normalize one port value.
 * @param {unknown} value - raw port.
 * @returns {number} integer port in 1..65535.
 */
function readPort(value) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw invalid('端口必须是 1-65535 之间的整数')
  }
  if (numeric < 1 || numeric > 65535) throw invalid('端口必须是 1-65535 之间的整数')
  return numeric
}

/**
 * Normalize an authentication type.
 * @param {unknown} value - raw value.
 * @returns {'password' | 'key'} normalized type.
 */
function readAuthType(value) {
  if (typeof value !== 'string' || !AUTH_TYPES.has(value)) throw invalid('认证方式必须是 password 或 key')
  return value
}

/**
 * Pick an incoming value, falling back to the stored record value.
 * @param {object} draft - incoming draft.
 * @param {string} key - field name.
 * @param {object | undefined} existing - stored record.
 * @returns {unknown} effective raw value.
 */
function pick(draft, key, existing) {
  const value = draft[key]
  if (value !== undefined && value !== null) return value
  if (existing === undefined) return undefined
  return existing[key]
}

/**
 * Resolve credentials from a draft.
 *
 * `undefined` or `''` keeps a stored credential of the same authentication
 * type; a non-empty string replaces it. Changing `authType` requires a matching
 * new credential because the old one belongs to the previous method.
 *
 * @param {object} draft - incoming draft.
 * @param {object | undefined} existing - stored record when updating.
 * @param {'password' | 'key'} authType - resolved authentication type.
 * @returns {{ password?: string, privateKey?: string, passphrase?: string }} resolved secrets.
 */
function resolveSecrets(draft, existing, authType) {
  if (authType === 'password') {
    const raw = draft.password
    let password
    if (raw === undefined || raw === '') password = existing && existing.authType === 'password' ? existing.password : undefined
    else if (typeof raw === 'string') password = raw
    else throw invalid('密码格式无效')
    if (typeof password !== 'string' || password === '') {
      if (existing && existing.authType !== 'password') throw invalid('切换认证方式需要提供新的密码')
      throw invalid('密码认证需要填写密码')
    }
    return { password }
  }

  const rawKey = draft.privateKey
  let privateKey
  if (rawKey === undefined || rawKey === '') privateKey = existing && existing.authType === 'key' ? existing.privateKey : undefined
  else if (typeof rawKey === 'string') privateKey = rawKey
  else throw invalid('私钥格式无效')
  if (typeof privateKey !== 'string' || privateKey === '') {
    if (existing && existing.authType !== 'key') throw invalid('切换认证方式需要提供新的私钥')
    throw invalid('私钥认证需要填写私钥')
  }

  /** @type {{ privateKey: string, passphrase?: string }} */
  const resolved = { privateKey }
  const rawPassphrase = draft.passphrase
  if (rawPassphrase === undefined || rawPassphrase === '') {
    if (existing && existing.authType === 'key' && typeof existing.passphrase === 'string' && existing.passphrase !== '') {
      resolved.passphrase = existing.passphrase
    }
  } else if (typeof rawPassphrase === 'string') {
    resolved.passphrase = rawPassphrase
  } else {
    throw invalid('私钥口令格式无效')
  }
  return resolved
}

/**
 * Build a complete internal account record from a draft.
 * @param {object} draft - create/update/test draft.
 * @param {object | undefined} existing - stored record when updating.
 * @returns {object} complete record (contains credentials).
 */
function buildRecord(draft, existing) {
  if (!isObject(draft)) throw invalid('请求内容无效')

  const host = readString(pick(draft, 'host', existing), '主机地址')
  if (host === undefined) throw invalid('主机地址不能为空')
  if (/\s/.test(host)) throw invalid('主机地址不能包含空白字符')
  if (host.length > 255) throw invalid('主机地址不能超过 255 个字符')

  const username = readString(pick(draft, 'username', existing), '用户名')
  if (username === undefined) throw invalid('用户名不能为空')
  if (username.length > 128) throw invalid('用户名不能超过 128 个字符')

  const rawPort = pick(draft, 'port', existing)
  const port = readPort(rawPort === undefined || rawPort === null || rawPort === '' ? DEFAULT_PORT : rawPort)
  const authType = readAuthType(pick(draft, 'authType', existing))

  let name
  if (draft.name === undefined || draft.name === null) {
    name = existing && typeof existing.name === 'string' ? existing.name : undefined
  } else if (typeof draft.name !== 'string') {
    throw invalid('账户名称格式无效')
  } else {
    const trimmed = draft.name.trim()
    name = trimmed === '' && existing && typeof existing.name === 'string' ? existing.name : trimmed
  }
  if (name === undefined || name === '') name = `${username}@${host}`
  if (name.length > NAME_MAX_LENGTH) throw invalid(`账户名称最多 ${NAME_MAX_LENGTH} 个字符`)

  let note
  const rawNote = pick(draft, 'note', existing)
  if (rawNote !== undefined) {
    if (typeof rawNote !== 'string') throw invalid('备注格式无效')
    note = rawNote.trim()
    if (note.length > NOTE_MAX_LENGTH) throw invalid(`备注最多 ${NOTE_MAX_LENGTH} 个字符`)
  }

  const now = new Date().toISOString()
  const record = {
    id: existing && typeof existing.id === 'string' ? existing.id : randomUUID(),
    name,
    host,
    port,
    username,
    authType,
    ...resolveSecrets(draft, existing, authType),
    createdAt: existing && typeof existing.createdAt === 'string' ? existing.createdAt : now,
    updatedAt: now,
  }
  if (note !== undefined && note !== '') record.note = note
  return record
}

/**
 * Project an internal record to its public, secret-free view.
 * @param {object | undefined} record - internal record.
 * @returns {object | undefined} public view.
 */
function toView(record) {
  if (!isObject(record)) return undefined
  const view = {
    id: String(record.id ?? ''),
    name: typeof record.name === 'string' ? record.name : '',
    host: typeof record.host === 'string' ? record.host : '',
    port: Number.isInteger(record.port) ? record.port : DEFAULT_PORT,
    username: typeof record.username === 'string' ? record.username : '',
    authType: record.authType === 'key' ? 'key' : 'password',
    hasPassword: typeof record.password === 'string' && record.password !== '',
    hasKey: typeof record.privateKey === 'string' && record.privateKey !== '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
  if (typeof record.note === 'string' && record.note !== '') view.note = record.note
  return view
}

/**
 * Whether one parsed entry is a usable persisted account.
 * @param {unknown} entry - parsed entry.
 * @returns {boolean} validity.
 */
function isPersistedRecord(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.id !== 'string' || entry.id === '') return false
  if (typeof entry.name !== 'string' || entry.name === '') return false
  if (typeof entry.host !== 'string' || entry.host === '') return false
  if (typeof entry.username !== 'string' || entry.username === '') return false
  if (!AUTH_TYPES.has(entry.authType)) return false
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return false
  return true
}

/**
 * Keep only known fields of a persisted account so malformed extras never
 * reach a public projection.
 * @param {object} entry - parsed record.
 * @returns {object} sanitized record.
 */
function sanitizePersisted(entry) {
  const record = {
    id: entry.id,
    name: entry.name,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    authType: entry.authType,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString(),
  }
  if (entry.authType === 'password' && typeof entry.password === 'string') record.password = entry.password
  if (entry.authType === 'key' && typeof entry.privateKey === 'string') record.privateKey = entry.privateKey
  if (entry.authType === 'key' && typeof entry.passphrase === 'string' && entry.passphrase !== '') record.passphrase = entry.passphrase
  if (typeof entry.note === 'string' && entry.note !== '') record.note = entry.note
  return record
}

/**
 * The legacy ssh-manager data file locations, in priority order.
 * @returns {string[]} candidate absolute paths.
 */
function legacySources() {
  const sources = []
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') sources.push(path.join(path.resolve(home.trim()), 'ssh-manager', 'servers.json'))
  const profile = process.env.DSH_PROFILE_DIR
  if (typeof profile === 'string' && profile.trim() !== '') sources.push(path.join(path.resolve(profile.trim()), 'data', 'ssh-manager', 'servers.json'))
  return [...new Set(sources)]
}

/**
 * Read the first readable legacy array, if any.
 * @returns {{ source?: string, records: object[] }} legacy data.
 */
function readLegacy() {
  for (const source of legacySources()) {
    let text
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return { source, records: parsed }
    } catch {
      /* a corrupt legacy file is skipped; the plugin never logs its contents */
    }
  }
  return { records: [] }
}

/**
 * Whether one legacy entry has enough data to import.
 * @param {unknown} entry - legacy record.
 * @returns {boolean} usability.
 */
function isLegacyUsable(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.host !== 'string' || entry.host.trim() === '') return false
  if (typeof entry.username !== 'string' || entry.username.trim() === '') return false
  if (entry.authType !== 'password' && entry.authType !== 'key') return false
  if (entry.authType === 'password' && typeof entry.password !== 'string') return false
  if (entry.authType === 'key' && typeof entry.privateKey !== 'string') return false
  return true
}

/**
 * Stable duplicate key for import: `host:port:username`.
 * @param {{ host?: unknown, port?: unknown, username?: unknown }} entry - record.
 * @returns {string} key.
 */
function serverKey(entry) {
  const host = typeof entry.host === 'string' ? entry.host.trim().toLowerCase() : ''
  const port = Number.isInteger(entry.port) ? entry.port : DEFAULT_PORT
  const username = typeof entry.username === 'string' ? entry.username.trim().toLowerCase() : ''
  return `${host}:${port}:${username}`
}

/**
 * Create the account store.
 * @param {{ dir?: string }} [options] - `dir` overrides the resolved data directory (tests).
 * @returns {{
 *   dataDir: () => string,
 *   load: () => void,
 *   list: () => object[],
 *   get: (id: string) => object | undefined,
 *   find: (query: string) => object | undefined,
 *   getSecretRecord: (id: string) => object | undefined,
 *   create: (draft: object) => Promise<object>,
 *   update: (id: string, patch: object) => Promise<object>,
 *   remove: (id: string) => Promise<boolean>,
 *   testDraft: (draft: object) => Promise<object>,
 *   toView: (record: object) => object | undefined,
 *   legacyInfo: () => { available: boolean, count: number, source?: string },
 *   importLegacy: () => Promise<{ imported: number, skipped: number, total: number }>,
 * }} store API.
 */
export function createAccountStore({ dir } = {}) {
  const resolvedDir = typeof dir === 'string' && dir.trim() !== '' ? path.resolve(dir) : resolveDataDir()
  const file = createJsonFile({ dir: resolvedDir, filename: DATA_FILE })

  /** @type {object[]} internal records (may contain credentials). */
  let records = []
  let loaded = false
  /** @type {Promise<unknown>} tail of the serialized mutation chain. */
  let mutationTail = Promise.resolve()

  /** Read the data file once; never throws. */
  function load() {
    if (loaded) return
    loaded = true
    const parsed = file.read()
    if (!Array.isArray(parsed)) {
      records = []
      return
    }
    records = parsed.filter(isPersistedRecord).map(sanitizePersisted)
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
   * Reject a display name used by another account (case-insensitive).
   * @param {string} name - candidate name.
   * @param {string} selfId - id of the record being written.
   * @throws {Error} conflict when another account owns the name.
   */
  function assertNameAvailable(name, selfId) {
    const wanted = name.toLowerCase()
    const clash = records.find((record) => record.id !== selfId && typeof record.name === 'string' && record.name.toLowerCase() === wanted)
    if (clash) throw conflict('账户名称已存在')
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

  /** @returns {object[]} public views sorted by name. */
  function list() {
    ensureLoaded()
    return records
      .slice()
      .sort((left, right) => String(left.name).localeCompare(String(right.name)))
      .map((record) => toView(record))
  }

  /**
   * @param {string} id - record id.
   * @returns {object | undefined} public view.
   */
  function get(id) {
    ensureLoaded()
    return toView(rawById(id))
  }

  /**
   * Resolve an account by id, exact name (case-insensitive), then a unique name
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
    if (byId) return toView(byId)
    const lower = text.toLowerCase()
    const byName = records.find((record) => typeof record.name === 'string' && record.name.toLowerCase() === lower)
    if (byName) return toView(byName)
    const byPrefix = records.filter((record) => typeof record.name === 'string' && record.name.toLowerCase().startsWith(lower))
    if (byPrefix.length === 1) return toView(byPrefix[0])
    return undefined
  }

  /**
   * Host-only access to the full record including credentials.
   * @param {string} id - record id.
   * @returns {object | undefined} shallow copy of the internal record.
   */
  function getSecretRecord(id) {
    ensureLoaded()
    const record = rawById(id)
    return record === undefined ? undefined : { ...record }
  }

  /**
   * Create one account.
   * @param {object} draft - create payload.
   * @returns {Promise<object>} public view.
   */
  function create(draft) {
    ensureLoaded()
    return enqueue(async () => {
      const record = buildRecord(draft, undefined)
      assertNameAvailable(record.name, record.id)
      const previous = records
      records = [...records, record]
      try {
        await file.write(records)
      } catch (error) {
        records = previous
        throw storageError(error)
      }
      return toView(record)
    })
  }

  /**
   * Update one account. `undefined`/`''` secrets keep the stored credential.
   * @param {string} id - record id.
   * @param {object} patch - update payload.
   * @returns {Promise<object>} public view.
   */
  function update(id, patch) {
    ensureLoaded()
    return enqueue(async () => {
      const existing = rawById(id)
      if (!existing) throw notFound('账户不存在')
      const updated = buildRecord(isObject(patch) ? patch : {}, existing)
      assertNameAvailable(updated.name, existing.id)
      const previous = records
      records = records.map((record) => (record.id === id ? updated : record))
      try {
        await file.write(records)
      } catch (error) {
        records = previous
        throw storageError(error)
      }
      return toView(updated)
    })
  }

  /**
   * Remove one account.
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
   * Validate a credential test draft without persisting it. When `draft.id`
   * points at a stored account, missing secrets come from that account.
   * @param {object} draft - draft payload.
   * @returns {Promise<object>} complete record (contains credentials; host-only).
   */
  async function testDraft(draft) {
    ensureLoaded()
    if (!isObject(draft)) throw invalid('请求内容无效')
    let existing
    if (draft.id !== undefined && draft.id !== null && draft.id !== '') {
      if (typeof draft.id !== 'string') throw invalid('账户 id 格式无效')
      existing = rawById(draft.id)
      if (!existing) throw notFound('账户不存在')
    }
    return buildRecord(draft, existing)
  }

  /**
   * Report whether the legacy ssh-manager data file is importable.
   * @returns {{ available: boolean, count: number, source?: string }} legacy info.
   */
  function legacyInfo() {
    const legacy = readLegacy()
    if (legacy.source === undefined) return { available: false, count: 0 }
    return { available: legacy.records.length > 0, count: legacy.records.length, source: legacy.source }
  }

  /**
   * Import legacy accounts, skipping entries whose `host:port:username` already
   * exists. Never logs credentials.
   * @returns {Promise<{ imported: number, skipped: number, total: number }>} import summary.
   */
  function importLegacy() {
    ensureLoaded()
    return enqueue(async () => {
      const legacy = readLegacy()
      const total = legacy.records.length
      if (total === 0) return { imported: 0, skipped: 0, total: 0 }

      const seenServers = new Set(records.map((record) => serverKey(record)))
      const takenNames = new Set(records.map((record) => String(record.name).toLowerCase()))
      const additions = []
      let skipped = 0

      for (const entry of legacy.records) {
        if (!isLegacyUsable(entry)) {
          skipped += 1
          continue
        }
        const key = serverKey(entry)
        if (seenServers.has(key)) {
          skipped += 1
          continue
        }
        try {
          const record = buildRecord(
            {
              name: entry.name,
              host: entry.host,
              port: entry.port === undefined ? DEFAULT_PORT : entry.port,
              username: entry.username,
              authType: entry.authType,
              password: entry.password,
              privateKey: entry.privateKey,
              passphrase: entry.passphrase,
              note: entry.note,
            },
            undefined,
          )
          let name = record.name
          let suffix = 2
          while (takenNames.has(name.toLowerCase())) {
            name = `${record.name} (${suffix})`
            suffix += 1
          }
          record.name = name
          takenNames.add(name.toLowerCase())
          seenServers.add(key)
          additions.push(record)
        } catch {
          skipped += 1
        }
      }

      if (additions.length > 0) {
        const previous = records
        records = [...records, ...additions]
        try {
          await file.write(records)
        } catch (error) {
          records = previous
          throw storageError(error)
        }
      }
      return { imported: additions.length, skipped, total }
    })
  }

  return {
    dataDir,
    load,
    list,
    get,
    find,
    getSecretRecord,
    create,
    update,
    remove,
    testDraft,
    toView,
    legacyInfo,
    importLegacy,
  }
}
