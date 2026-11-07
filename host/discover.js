/**
 * Read-only remote deployment discovery.
 *
 * `scan` searches common deployment roots for project markers and reports
 * candidate directories; `inspect` reads one directory's shape (top-level
 * entries, markers, git state and running services). The generated shell is
 * conservative POSIX (works on macOS and Linux), never reads file contents and
 * never runs `stat -c`, `find -printf`, `ss`, `readlink -f` or `xargs -r`.
 *
 * @module host/discover
 */

import path from 'node:path'
import { shQuote, validateRemotePath } from './shell.js'

/** Default roots for a scan. */
const DEFAULT_ROOTS = ['/opt', '/srv', '/var/www', '/data', '/app', '/home']
/** Marker file names searched by a scan. */
const MARKER_NAMES = [
  '.git',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'package.json',
  'pom.xml',
  'build.gradle',
  'go.mod',
  'requirements.txt',
  'manage.py',
  'index.html',
  'Caddyfile',
  'nginx.conf',
]
/** Compose markers that imply a compose deployment. */
const COMPOSE_MARKERS = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'])
/** Maximum retained raw netstat lines. */
const MAX_RAW_LINES = 100
/** Default discovery timeout (60 s). */
const DEFAULT_TIMEOUT_MS = 60_000
/** Minimum accepted timeout (1 s). */
const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted timeout (10 min). */
const MAX_TIMEOUT_MS = 600_000

/**
 * Build one tagged error.
 * @param {string} code - machine-readable code.
 * @param {string} message - Chinese message.
 * @returns {Error & { code: string }} tagged error.
 */
function taggedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {string} message @returns {Error} invalid path error. */
function invalidPath(message) {
  return taggedError('invalid-path', message)
}

/**
 * Clamp one numeric option.
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
 * Normalize one scan root. Scans are read-only, so system roots such as
 * `/home` or `/usr` are allowed; only the filesystem root and unsafe strings
 * are rejected.
 * @param {unknown} raw - candidate root.
 * @returns {string} normalized absolute root.
 */
function normalizeScanRoot(raw) {
  if (typeof raw !== 'string') throw invalidPath('扫描根目录无效')
  const text = raw.trim()
  if (text === '') throw invalidPath('扫描根目录不能为空')
  if (text.length > 1024) throw invalidPath('扫描根目录过长')
  if (!text.startsWith('/')) throw invalidPath('扫描根目录必须是绝对路径')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw invalidPath('扫描根目录不能包含控制字符')
  if (text.split('/').some((segment) => segment === '..')) throw invalidPath('扫描根目录不能包含 ".." 片段')
  const normalized = path.posix.normalize(text)
  if (normalized === '/') throw invalidPath('不允许扫描文件系统根目录')
  return normalized
}

/**
 * Build a read-only scan command.
 * @param {{ roots?: string[], maxDepth?: number, limit?: number }} [options] - scan options.
 * @returns {string} shell command with `###OS`, `###USER`, `###FIND`, `###PORTS`
 *   and `###UNITS` sections.
 */
export function buildScanCommand({ roots, maxDepth, limit } = {}) {
  const rawRoots = roots === undefined ? DEFAULT_ROOTS : roots
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) throw invalidPath('扫描根目录不能为空')
  const normalizedRoots = rawRoots.map(normalizeScanRoot)
  const depth = clampInt(maxDepth, 3, 1, 4)
  const maxCandidates = clampInt(limit, 80, 1, 200)
  const findHead = Math.min(4000, Math.max(40, maxCandidates * 10))
  const rootArgs = normalizedRoots.map(shQuote).join(' ')
  const markerExpr = MARKER_NAMES.map((name) => `-name ${shQuote(name)}`).join(' -o ')
  const findExpr = `\\( ${markerExpr} -o -name '*.jar' -o -name '*.war' \\)`

  return [
    "printf '###OS\\n'",
    'uname -srm 2>/dev/null',
    "printf '\\n###USER\\n'",
    'id -un 2>/dev/null',
    "printf '\\n###FIND\\n'",
    `find ${rootArgs} -maxdepth ${depth} ${findExpr} -print 2>/dev/null | head -n ${findHead}`,
    "printf '\\n###PORTS\\n'",
    'if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null; else netstat -an 2>/dev/null; fi | head -n 120',
    "printf '\\n###UNITS\\n'",
    'systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 80',
    "docker ps --format '{{.Names}}\\t{{.Image}}' 2>/dev/null | head -n 40",
  ].join('\n')
}

/**
 * Split sectioned shell output.
 * @param {string} text - command output.
 * @returns {Map<string, string[]>} section name to raw lines.
 */
function splitSections(text) {
  /** @type {Map<string, string[]>} */
  const sections = new Map()
  /** @type {string | null} */
  let current = null
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = /^###([A-Z_]+)$/.exec(rawLine.trim())
    if (match) {
      current = match[1]
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current !== null) sections.get(current).push(rawLine)
  }
  return sections
}

/**
 * First non-empty trimmed line of one section.
 * @param {string[] | undefined} lines - section lines.
 * @returns {string} value.
 */
function firstLine(lines) {
  if (!Array.isArray(lines)) return ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * Parse scan output into candidate directories and raw host facts.
 * @param {string} text - scan command output.
 * @returns {{ os: string, user: string, candidates: { path: string, markers: string[] }[], listening: string[], services: string[], truncated: boolean }} parsed scan.
 */
export function parseScanOutput(text) {
  const sections = splitSections(text)
  const os = firstLine(sections.get('OS'))
  const user = firstLine(sections.get('USER'))

  /** @type {Map<string, { path: string, markers: string[] }>} */
  const candidates = new Map()
  for (const line of sections.get('FIND') ?? []) {
    const found = line.trim()
    if (found === '' || !found.startsWith('/')) continue
    const dir = path.posix.dirname(found)
    if (dir === '/' || dir === '.') continue
    const marker = path.posix.basename(found)
    if (marker === '') continue
    let candidate = candidates.get(dir)
    if (candidate === undefined) {
      candidate = { path: dir, markers: [] }
      candidates.set(dir, candidate)
    }
    if (!candidate.markers.includes(marker)) candidate.markers.push(marker)
  }

  /**
   * Collect trimmed non-empty raw lines.
   * @param {string[] | undefined} lines - section lines.
   * @returns {string[]} capped lines.
   */
  const rawLines = (lines) => (lines ?? []).map((line) => line.trim()).filter((line) => line !== '').slice(0, MAX_RAW_LINES)

  return {
    os,
    user,
    candidates: [...candidates.values()],
    listening: rawLines(sections.get('PORTS')),
    services: rawLines(sections.get('UNITS')),
    truncated: false,
  }
}

/**
 * Build a read-only inspect command for one directory.
 * @param {string} remotePath - absolute POSIX directory path.
 * @returns {string} shell command with sections `###PATH_EXISTS`, `###WRITABLE`,
 *   `###PHYSICAL`, `###SIZE_KB`, `###TOP`, `###MARKERS`, `###GIT` and `###UNITS`.
 * @throws {Error & { code: 'invalid-path' }} when the path is not acceptable.
 */
export function buildInspectCommand(remotePath) {
  const target = validateRemotePath(remotePath)
  const p = shQuote(target)
  const markerList = MARKER_NAMES.map(shQuote).join(' ')

  return [
    `__p=${p}`,
    "printf '###PATH_EXISTS\\n'",
    'if [ -d "$__p" ]; then printf \'yes\\n\'; else printf \'no\\n\'; fi',
    "printf '###WRITABLE\\n'",
    'if [ -d "$__p" ] && [ -w "$__p" ]; then printf \'yes\\n\'; else printf \'no\\n\'; fi',
    "printf '###PHYSICAL\\n'",
    '( cd "$__p" 2>/dev/null && pwd -P ) || printf \'\\n\'',
    "printf '###SIZE_KB\\n'",
    'du -sk "$__p" 2>/dev/null | awk \'{print $1}\'',
    "printf '###TOP\\n'",
    'if [ -d "$__p" ]; then',
    '  for __entry in "$__p"/* "$__p"/.[!.]*; do',
    '    [ -e "$__entry" ] || continue',
    '    if [ -L "$__entry" ]; then __type=link; __bytes=0',
    '    elif [ -d "$__entry" ]; then __type=dir',
    '    else __type=file',
    '    fi',
    '    if [ "$__type" != link ]; then __kb=$(du -sk "$__entry" 2>/dev/null | awk \'{print $1}\'); __bytes=$(( ${__kb:-0} * 1024 )); fi',
    '    printf \'%s\\t%s\\t%s\\n\' "$__bytes" "$__type" "${__entry##*/}"',
    '  done | head -n 80',
    'fi',
    "printf '###MARKERS\\n'",
    `for __marker in ${markerList}; do [ -e "$__p/$__marker" ] && printf '%s\\n' "$__marker"; done`,
    'for __file in "$__p"/*.jar "$__p"/*.war; do [ -e "$__file" ] && printf \'%s\\n\' "${__file##*/}"; done',
    "printf '###GIT\\n'",
    'if [ -d "$__p/.git" ]; then',
    '  printf \'remote=%s\\n\' "$(git -C "$__p" remote get-url origin 2>/dev/null)"',
    '  printf \'branch=%s\\n\' "$(git -C "$__p" rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    '  printf \'commit=%s\\n\' "$(git -C "$__p" rev-parse HEAD 2>/dev/null)"',
    '  printf \'dirty=%s\\n\' "$(git -C "$__p" status --porcelain 2>/dev/null | wc -l | tr -d \' \')"',
    'fi',
    "printf '###UNITS\\n'",
    'systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 80',
    "docker ps --format '{{.Names}}' 2>/dev/null | head -n 40",
  ].join('\n')
}

/**
 * Extract a unit-like token from one raw service line.
 *
 * The token is remote-controlled output, so it is accepted only when it uses
 * the POSIX-safe systemd unit character set. Shell metacharacters (`;`, `$`,
 * `|`, backticks, whitespace, `$IFS`-style expansions) can therefore never
 * reach a suggested command, and the suggestion stays a single plain word.
 *
 * @param {string} line - raw line.
 * @returns {string | undefined} unit identifier.
 */
function unitToken(line) {
  const token = line.split(/\s+/)[0] ?? ''
  if (!/^[A-Za-z0-9@_.:-]+\.(?:service|socket|timer|mount|path|target|slice|scope)$/.test(token)) return undefined
  return token
}

/**
 * Pick a matching systemd unit for one app directory name.
 * @param {string[]} units - service units.
 * @param {string} appName - app directory basename.
 * @returns {string | undefined} matching unit.
 */
function matchingUnit(units, appName) {
  if (typeof appName !== 'string' || appName === '') return undefined
  return units.find((unit) => {
    if (!unit.endsWith('.service')) return false
    const base = unit.slice(0, -'.service'.length)
    return base === appName || base.startsWith(`${appName}-`) || base.startsWith(`${appName}_`)
  })
}

/**
 * Build update/restart suggestions from inspection facts.
 * @param {string[]} markers - marker names.
 * @param {string[]} serviceUnits - service units.
 * @param {string} remotePath - inspected directory.
 * @returns {{ suggestedUpdateCommand?: string, suggestedRestartCommand?: string }} suggestions.
 */
function suggestionsFor(markers, serviceUnits, remotePath) {
  /** @type {{ suggestedUpdateCommand?: string, suggestedRestartCommand?: string }} */
  const result = {}
  const markerSet = new Set(markers)
  const compose = [...COMPOSE_MARKERS].find((marker) => markerSet.has(marker))
  if (compose !== undefined) result.suggestedUpdateCommand = 'docker compose pull && docker compose up -d --remove-orphans'
  else if (markerSet.has('.git')) result.suggestedUpdateCommand = 'git pull --ff-only'

  const appName = path.posix.basename(remotePath)
  const unit = matchingUnit(serviceUnits, appName)
  // `unitToken` guarantees a metacharacter-free unit name, so the suggestion is
  // a plain word and needs no quoting; adding quotes would only make the text
  // that the model copies less readable.
  if (unit !== undefined) result.suggestedRestartCommand = `systemctl restart ${unit}`
  return result
}

/**
 * Parse inspect output.
 * @param {string} text - inspect command output.
 * @returns {object} parsed inspection (without the `path` field).
 */
export function parseInspectOutput(text) {
  const sections = splitSections(text)
  const exists = firstLine(sections.get('PATH_EXISTS')).toLowerCase() === 'yes'
  const writable = firstLine(sections.get('WRITABLE')).toLowerCase() === 'yes'
  const physicalPath = firstLine(sections.get('PHYSICAL'))
  const rawSize = Number.parseInt(firstLine(sections.get('SIZE_KB')), 10)
  const sizeKB = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : 0

  const topLevel = []
  for (const line of sections.get('TOP') ?? []) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue
    const bytes = Number.parseInt(parts[0], 10)
    const type = parts[1] === 'dir' || parts[1] === 'link' ? parts[1] : 'file'
    const name = parts.slice(2).join('\t')
    if (name === '') continue
    topLevel.push({ name, type, sizeBytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0 })
  }

  const markers = []
  for (const line of sections.get('MARKERS') ?? []) {
    const marker = line.trim()
    if (marker !== '' && !markers.includes(marker)) markers.push(marker)
  }

  /** @type {Record<string, string>} */
  const gitFields = {}
  for (const line of sections.get('GIT') ?? []) {
    const match = /^(remote|branch|commit|dirty)=(.*)$/.exec(line.trim())
    if (match) gitFields[match[1]] = match[2]
  }
  const hasGit = Object.keys(gitFields).length > 0
  const git = hasGit
    ? {
        remote: gitFields.remote ?? '',
        branch: gitFields.branch ?? '',
        commit: gitFields.commit ?? '',
        dirty: (Number.parseInt(gitFields.dirty ?? '0', 10) || 0) > 0,
      }
    : null

  const serviceUnits = []
  for (const line of sections.get('UNITS') ?? []) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const unit = unitToken(trimmed)
    if (unit !== undefined && !serviceUnits.includes(unit)) serviceUnits.push(unit)
  }

  const suggestions = suggestionsFor(markers, serviceUnits, physicalPath === '' ? '/' : physicalPath)
  return {
    exists,
    writable,
    physicalPath,
    sizeKB,
    topLevel,
    markers,
    git,
    serviceUnits,
    ...suggestions,
  }
}

/**
 * Create the discovery service.
 * @param {{ ssh: { exec: Function } }} options - ssh client.
 * @returns {{ scan: Function, inspect: Function }} discovery operations.
 */
export function createDiscoverService({ ssh } = {}) {
  if (!ssh || typeof ssh.exec !== 'function') throw new TypeError('createDiscoverService: ssh client is required')

  /**
   * Scan common deployment roots for project markers.
   * @param {object} record - full account record.
   * @param {{ roots?: string[], maxDepth?: number, limit?: number, timeoutMs?: number }} [options] - scan options.
   * @returns {Promise<object>} scan result.
   */
  async function scan(record, options = {}) {
    const limit = clampInt(options.limit, 80, 1, 200)
    const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const command = buildScanCommand({
      roots: options.roots,
      maxDepth: options.maxDepth,
      limit,
    })
    const result = await ssh.exec(record, command, { timeoutMs })
    const parsed = parseScanOutput(result.stdout)
    const candidates = parsed.candidates.slice(0, limit)
    const truncated = parsed.truncated || parsed.candidates.length > limit || result.truncated === true
    const output = {
      os: parsed.os,
      user: parsed.user,
      candidates,
      listening: parsed.listening,
      services: parsed.services,
      truncated,
    }
    if (typeof record.name === 'string' && record.name !== '') output.server = record.name
    return output
  }

  /**
   * Inspect one remote directory (read-only).
   * @param {object} record - full account record.
   * @param {{ path: string, timeoutMs?: number }} options - directory and timeout.
   * @returns {Promise<object>} inspection result.
   */
  async function inspect(record, { path: remotePath, timeoutMs } = {}) {
    const target = validateRemotePath(remotePath)
    const timeout = clampInt(timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const command = buildInspectCommand(target)
    const result = await ssh.exec(record, command, { timeoutMs: timeout })
    const parsed = parseInspectOutput(result.stdout)
    return { path: target, ...parsed, ...suggestionsFor(parsed.markers, parsed.serviceUnits, target) }
  }

  return { scan, inspect }
}
