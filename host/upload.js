/**
 * Approval-gated local-to-remote file upload.
 *
 * `resolve` validates the request without touching the remote host beyond
 * nothing at all: it only stats the local file and looks up the account, so the
 * approval gate can describe the transfer before anything happens. `execute`
 * creates the remote directory, pushes the file over SFTP, verifies size and
 * SHA-256 on the server and records the attempt in the update history.
 *
 * Like `host/update.js`, this service knows nothing about the approval
 * pipeline; `host/gate.js` is the only place that turns a valid upload target
 * into an approval ask.
 *
 * @module host/upload
 */

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { remotePathWarnings, shQuote, validateRemotePath } from './shell.js'

/** Default upload timeout (5 min). */
const DEFAULT_TIMEOUT_MS = 300_000
/** Minimum accepted timeout (5 s). */
const MIN_TIMEOUT_MS = 5_000
/** Maximum accepted timeout (1 h). */
const MAX_TIMEOUT_MS = 3_600_000
/** Refuse to push files larger than this (2 GiB) by accident. */
const MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024
/** Captured output tail length. */
const TAIL_MAX_LENGTH = 8192
/** Maximum accepted local path length. */
const MAX_LOCAL_PATH_LENGTH = 4096

/**
 * Build one tagged error.
 * @param {string} code - machine-readable error code.
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

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one error message without leaking internals.
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
 * Clip one captured output tail.
 * @param {unknown} value - raw output.
 * @returns {string} clipped text.
 */
function clipTail(value) {
  if (typeof value !== 'string') return ''
  return value.length <= TAIL_MAX_LENGTH ? value : value.slice(value.length - TAIL_MAX_LENGTH)
}

/**
 * Validate one absolute local file path and read its size.
 *
 * Error messages deliberately never echo the rejected path: `resolve()` runs
 * before any approval prompt, so a path-echoing error would hand the model a
 * pre-approval existence/size oracle and disclose the operator's home layout.
 *
 * @param {unknown} raw - candidate path.
 * @returns {{ localPath: string, fileName: string, sizeBytes: number }} facts.
 * @throws {Error & { code: 'invalid-input' }} when the file cannot be uploaded.
 */
function inspectLocalFile(raw) {
  if (typeof raw !== 'string') throw invalid('本地文件路径无效')
  const text = raw.trim()
  if (text === '') throw invalid('本地文件路径不能为空')
  if (text.length > MAX_LOCAL_PATH_LENGTH) throw invalid(`本地文件路径不能超过 ${MAX_LOCAL_PATH_LENGTH} 个字符`)
  if (!path.isAbsolute(text)) throw invalid('本地文件路径必须是绝对路径')
  let stats
  try {
    stats = statSync(text)
  } catch {
    throw invalid('本地文件不存在或无法读取')
  }
  if (!stats.isFile()) throw invalid('本地路径不是普通文件')
  if (stats.size <= 0) throw invalid('本地文件为空，没有可上传的内容')
  if (stats.size > MAX_LOCAL_BYTES) throw invalid('本地文件超过 2 GiB，请改用其他分发方式')
  return { localPath: text, fileName: path.basename(text), sizeBytes: stats.size }
}

/**
 * Compute the SHA-256 of one local file.
 * @param {string} localPath - absolute file path.
 * @returns {Promise<string>} lowercase hex digest.
 */
async function hashLocalFile(localPath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(localPath)
    stream.on('error', (error) => reject(taggedError('upload', '无法读取本地文件', error)))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Create the upload service.
 *
 * @param {{ ssh: object, accounts: object, resources?: object, history: object, now?: () => number }} options - services.
 * @returns {{
 *   resolve: (args: object) => object,
 *   execute: (target: object, options?: { agentId?: string }) => Promise<object>,
 * }} upload service.
 */
export function createUploadService({ ssh, accounts, resources, history, now = () => Date.now() } = {}) {
  if (!ssh || typeof ssh.upload !== 'function') throw new TypeError('createUploadService: ssh client with upload() is required')
  if (!accounts || typeof accounts.find !== 'function' || typeof accounts.getSecretRecord !== 'function') {
    throw new TypeError('createUploadService: accounts store is required')
  }
  if (!history || typeof history.append !== 'function') throw new TypeError('createUploadService: history store is required')

  /**
   * Resolve one account by id or name.
   * @param {unknown} query - account id or name.
   * @returns {{ view: object, record: object }} account view and secret record.
   */
  function resolveAccount(query) {
    const text = typeof query === 'string' ? query.trim() : ''
    if (text === '') throw invalid('缺少服务器参数：请提供账户 id 或名称')
    const view = accounts.find(text)
    if (!view) throw invalid(`未找到账户 "${text}"`)
    const record = accounts.getSecretRecord(view.id)
    if (!record) throw invalid(`无法读取账户 "${view.name}" 的连接凭据`)
    return { view, record }
  }

  /**
   * Validate an upload request without touching the remote host.
   * @param {object} args - raw tool arguments.
   * @returns {object} upload target.
   * @throws {Error & { code: string }} when the request is not executable.
   */
  function resolve(args) {
    if (!isObject(args)) throw invalid('上传参数无效')
    const { view, record } = resolveAccount(args.server)
    const local = inspectLocalFile(args.local_path)
    const remotePath = validateRemotePath(args.remote_path)
    const remoteDir = path.posix.dirname(remotePath)
    if (remotePath === remoteDir) throw invalid('远程路径必须是具体文件，不能是根目录')

    const timeoutMs = clampInt(args.timeout_seconds, DEFAULT_TIMEOUT_MS / 1000, MIN_TIMEOUT_MS / 1000, MAX_TIMEOUT_MS / 1000) * 1000

    /** @type {object | undefined} */
    let resource
    const resourceQuery = typeof args.resource === 'string' ? args.resource.trim() : ''
    if (resourceQuery !== '' && resources && typeof resources.find === 'function') {
      const found = resources.find(resourceQuery)
      if (!found) throw invalid(`未找到资源 "${resourceQuery}"`)
      if (found.serverId !== view.id) throw invalid(`资源 "${found.name}" 属于另一台服务器，不能用于 ${view.name}`)
      resource = found
    }

    const warnings = remotePathWarnings(remotePath)
    if (resource && typeof resource.appDir === 'string' && resource.appDir !== '') {
      for (const warning of remotePathWarnings(remotePath, { appDir: resource.appDir })) {
        if (!warnings.includes(warning)) warnings.push(warning)
      }
    }

    return {
      serverId: view.id,
      serverName: view.name,
      account: record,
      resourceId: resource ? resource.id : '',
      resourceName: resource ? resource.name : '',
      localPath: local.localPath,
      fileName: local.fileName,
      sizeBytes: local.sizeBytes,
      remotePath,
      remoteDir,
      timeoutMs,
      warnings,
    }
  }

  /**
   * Run one remote command as a history step.
   * @param {object} target - upload target.
   * @param {{ id: string, title: string, command: string }} definition - step definition.
   * @returns {Promise<object>} history step.
   */
  async function runCommandStep(target, definition) {
    const startedAt = now()
    try {
      const result = await ssh.exec(target.account, definition.command, { timeoutMs: target.timeoutMs })
      const ok = result.exitCode === 0
      return {
        id: definition.id,
        title: definition.title,
        status: ok ? 'success' : 'failed',
        command: definition.command,
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
        durationMs: Math.max(0, now() - startedAt),
        stdoutTail: clipTail(result.stdout),
        stderrTail: clipTail(result.stderr),
        truncated: result.truncated === true,
      }
    } catch (error) {
      return {
        id: definition.id,
        title: definition.title,
        status: 'failed',
        command: definition.command,
        exitCode: null,
        durationMs: Math.max(0, now() - startedAt),
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      }
    }
  }

  /**
   * Execute one resolved upload: mkdir, SFTP put, verify, record history.
   * @param {object} target - value returned by `resolve`.
   * @param {{ agentId?: string }} [options] - execution options.
   * @returns {Promise<object>} stored history entry.
   */
  async function execute(target, options = {}) {
    if (!isObject(target) || typeof target.remotePath !== 'string' || target.remotePath === '') {
      throw invalid('上传目标无效，请重新调用 ssh_helper_upload')
    }
    void options
    const startedAt = now()
    /** @type {object[]} */
    const steps = []
    /** @type {string} */
    let message = ''
    /** @type {string} */
    let sha256 = ''
    /** @type {number} */
    let bytes = target.sizeBytes

    /**
     * Persist the attempt and return its history entry.
     * @param {string} status - final status.
     * @param {string} note - final message.
     * @returns {Promise<object>} stored entry.
     */
    const finish = async (status, note) => {
      if (typeof note === 'string' && note !== '') message = note
      const finishedAt = now()
      return await history.append({
        action: 'upload',
        resourceId: target.resourceId || '',
        resourceName: target.resourceName || target.fileName,
        serverId: target.serverId,
        serverName: target.serverName,
        appDir: target.remoteDir,
        backupPath: '',
        status,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: Math.max(0, finishedAt - startedAt),
        steps,
        ...(message === '' ? {} : { message }),
      })
    }

    // 1. Make sure the destination directory exists.
    const mkdirStep = await runCommandStep(target, {
      id: 'mkdir',
      title: 'Create the remote directory',
      command: `mkdir -p ${shQuote(target.remoteDir)}`,
    })
    steps.push(mkdirStep)
    if (mkdirStep.status !== 'success') return await finish('failed', '无法创建远端目录，未上传任何文件。')

    // 2. Hash locally so the remote copy can be compared byte for byte.
    try {
      sha256 = await hashLocalFile(target.localPath)
    } catch (error) {
      steps.push({
        id: 'hash',
        title: 'Hash the local file',
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      })
      return await finish('failed', '读取本地文件失败，未执行上传。')
    }

    // 3. Push the file over SFTP.
    const uploadStartedAt = now()
    try {
      const uploaded = await ssh.upload(target.account, {
        localPath: target.localPath,
        remotePath: target.remotePath,
        timeoutMs: target.timeoutMs,
      })
      if (typeof uploaded.bytes === 'number' && uploaded.bytes > 0) bytes = uploaded.bytes
      steps.push({
        id: 'sftp',
        title: 'Upload the file over SFTP',
        status: 'success',
        command: `sftp put ${target.localPath} -> ${target.remotePath}`,
        exitCode: 0,
        durationMs: Math.max(0, now() - uploadStartedAt),
        stdoutTail: `${bytes} bytes in ${Math.max(0, now() - uploadStartedAt)} ms`,
        stderrTail: '',
        truncated: false,
      })
    } catch (error) {
      steps.push({
        id: 'sftp',
        title: 'Upload the file over SFTP',
        status: 'failed',
        command: `sftp put ${target.localPath} -> ${target.remotePath}`,
        exitCode: null,
        durationMs: Math.max(0, now() - uploadStartedAt),
        stdoutTail: '',
        stderrTail: errorMessage(error),
        truncated: false,
      })
      return await finish('failed', 'SFTP 上传失败，远端文件可能不完整，请不要用它执行更新。')
    }

    // 4. Verify size and digest on the server. `stat` and the SHA-256 utility are
    // spelled differently on GNU and BSD userlands, so both branches are tried.
    const verifyStep = await runCommandStep(target, {
      id: 'verify',
      title: 'Verify the uploaded file',
      command: [
        'set -e',
        `f=${shQuote(target.remotePath)}`,
        'test -f "$f"',
        'if stat -c %s "$f" >/dev/null 2>&1; then stat -c %s "$f"; else stat -f %z "$f"; fi',
        'if command -v sha256sum >/dev/null 2>&1; then sha256sum "$f" | cut -d" " -f1; else shasum -a 256 "$f" | cut -d" " -f1; fi',
      ].join('; '),
    })
    steps.push(verifyStep)
    if (verifyStep.status !== 'success') return await finish('partial', '上传完成，但远端校验失败，请不要用它执行更新。')

    const lines = String(verifyStep.stdoutTail || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const remoteSize = Number.parseInt(lines[0] ?? '', 10)
    const remoteSha = (lines[1] ?? '').toLowerCase()
    if (!Number.isFinite(remoteSize) || remoteSize !== bytes) {
      return await finish('partial', `上传完成但大小不一致：本地 ${bytes} 字节，远端 ${Number.isFinite(remoteSize) ? remoteSize : '未知'} 字节。`)
    }
    if (remoteSha !== '' && remoteSha !== sha256) {
      return await finish('partial', '上传完成但 SHA-256 不一致，文件可能在传输中损坏。')
    }
    return await finish('success', '上传完成并通过校验。')
  }

  return { resolve, execute }
}
