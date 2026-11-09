/**
 * POSIX shell quoting, remote path validation and backup layout helpers.
 *
 * Every remote command built by the plugin must pass user-controlled values
 * through {@link shQuote}; every remote directory must pass
 * {@link validateRemotePath}. The module is intentionally free of I/O so it can
 * be unit-tested and reused by the discovery, resource and update services.
 *
 * @module host/shell
 */

import path from 'node:path'

/** Maximum accepted remote path length. */
const MAX_PATH_LENGTH = 1024
/** Maximum accepted sanitized path segment length. */
const MAX_SEGMENT_LENGTH = 64

/** System roots that may never be used as an app or backup directory. */
const BLOCKED_EXACT = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
  '/var/lib',
  '/var/log',
  '/var/run',
  '/home',
])

/** System roots whose whole subtree is off limits. */
const BLOCKED_PREFIXES = [
  '/bin/',
  '/boot/',
  '/dev/',
  '/etc/',
  '/lib/',
  '/lib64/',
  '/proc/',
  '/run/',
  '/sbin/',
  '/sys/',
  '/usr/',
]

/**
 * Build one error carrying the stable `invalid-path` code.
 * @param {string} message - Chinese human-readable message.
 * @returns {Error & { code: string }} tagged error.
 */
function invalidPath(message) {
  const error = new Error(message)
  error.code = 'invalid-path'
  return error
}

/**
 * Quote one value for a POSIX shell as a single-quoted literal.
 * @param {unknown} value - value to quote (coerced with `String`).
 * @returns {string} safely quoted shell word.
 */
export function shQuote(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * Validate and normalize one absolute POSIX path.
 *
 * Rejects non-strings, empty values, relative paths, `..` segments, control
 * characters, over-long values and the blocked system roots listed in
 * `BLOCKED_EXACT` / `BLOCKED_PREFIXES`. Returns a normalized absolute path with
 * redundant separators and trailing slashes removed.
 *
 * @param {unknown} raw - candidate remote path.
 * @returns {string} normalized absolute path.
 * @throws {Error & { code: 'invalid-path' }} when the path is not acceptable.
 */
export function validateRemotePath(raw) {
  if (typeof raw !== 'string') throw invalidPath('远程路径无效')
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw invalidPath('远程路径不能包含控制字符')
  const text = raw.trim()
  if (text === '') throw invalidPath('远程路径不能为空')
  if (text.length > MAX_PATH_LENGTH) throw invalidPath(`远程路径不能超过 ${MAX_PATH_LENGTH} 个字符`)
  if (!text.startsWith('/')) throw invalidPath('远程路径必须是绝对路径')
  if (text.split('/').some((segment) => segment === '..')) throw invalidPath('远程路径不能包含 ".." 片段')

  let normalized = path.posix.normalize(text)
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.replace(/\/+$/, '')
  if (!normalized.startsWith('/')) throw invalidPath('远程路径必须是绝对路径')
  if (normalized === '/' || BLOCKED_EXACT.has(normalized)) throw invalidPath(`不允许使用系统目录 ${normalized}`)
  for (const prefix of BLOCKED_PREFIXES) {
    if (normalized.startsWith(prefix)) throw invalidPath(`不允许使用系统目录 ${normalized}`)
  }
  return normalized
}

/**
 * Collect human-readable warnings for one remote path. The path itself is
 * assumed to be valid.
 * @param {string} remotePath - normalized absolute path.
 * @param {{ appDir?: string }} [options] - when `appDir` is provided, a path
 *   inside it is reported as a backup-inside-app warning.
 * @returns {string[]} warnings (English, model-facing).
 */
export function remotePathWarnings(remotePath, options = {}) {
  const warnings = []
  if (typeof remotePath !== 'string' || remotePath === '') return warnings
  const normalized = path.posix.normalize(remotePath)
  if (normalized === '/tmp' || normalized.startsWith('/tmp/')) {
    warnings.push('Path is under /tmp, which may be cleared on reboot.')
  }
  if (normalized === '/root') {
    warnings.push('Path is /root itself; the app and its backups would mix with the user home.')
  }
  const depth = normalized.split('/').filter(Boolean).length
  if (depth < 2) warnings.push('Path is very shallow; a mistake could affect unrelated services.')
  if (typeof options.appDir === 'string' && options.appDir !== '') {
    const appDir = path.posix.normalize(options.appDir)
    if (normalized === appDir || normalized.startsWith(`${appDir}/`)) {
      warnings.push('Backup directory is inside the app directory; a backup could include itself.')
    }
  }
  return warnings
}

/**
 * Sanitize one value into a safe path segment matching `[A-Za-z0-9._-]`.
 * @param {unknown} value - raw value.
 * @returns {string} safe segment, never empty and at most 64 characters.
 */
export function safeSegment(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  let result = text.replace(/[^A-Za-z0-9._-]+/g, '-')
  result = result.replace(/^[.-]+/, '').replace(/[.-]+$/, '')
  if (result === '' || result === '.' || result === '..') result = 'item'
  return result.slice(0, MAX_SEGMENT_LENGTH)
}

/**
 * Format a compact UTC timestamp such as `20261106T131500Z`.
 * @param {Date | number | string | undefined} value - timestamp source.
 * @returns {string} compact UTC stamp.
 */
function compactStamp(value) {
  /** @type {Date | undefined} */
  let date
  if (value instanceof Date) date = value
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value)
  else if (typeof value === 'string') {
    if (/^\d{8}T\d{6}Z$/.test(value)) return value
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) date = parsed
  }
  if (date === undefined || Number.isNaN(date.getTime())) date = new Date()
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Compute the backup parent, directory and archive path for one resource.
 *
 * The archive path is `<dir>/<safeName>-<compactStamp>.tar.gz`; the default
 * directory is `<appParent>/.ssh-helper-backups/<safeName>`.
 *
 * @param {{ appDir: string, backupDir?: string, name?: string, timestamp?: Date | number | string }} options - resource data.
 * @returns {{ parent: string, baseName: string, dir: string, file: string }} layout.
 * @throws {Error & { code: 'invalid-path' }} when a path is not acceptable.
 */
export function backupLayout({ appDir, backupDir, name, timestamp } = {}) {
  const app = validateRemotePath(appDir)
  const parent = path.posix.dirname(app)
  const baseName = path.posix.basename(app)
  const segment = safeSegment(name === undefined || name === null || name === '' ? baseName : name)
  const dir =
    backupDir === undefined || backupDir === null || backupDir === ''
      ? path.posix.join(parent, '.ssh-helper-backups', segment)
      : validateRemotePath(backupDir)
  const stamp = compactStamp(timestamp)
  return {
    parent,
    baseName,
    dir,
    file: path.posix.join(dir, `${segment}-${stamp}.tar.gz`),
  }
}
