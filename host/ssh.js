/**
 * SSH execution through the pure-JavaScript `ssh2` client.
 *
 * `exec` runs one command and reports stdout/stderr/exit code with bounded
 * capture; `probe` checks reachability and identity. Host keys are accepted as
 * provided by the server (documented v1 policy). Every failure is mapped to one
 * of the fixed codes `timeout`, `network`, `auth` or `unknown` with a fixed
 * Chinese message that never contains a password, private key or passphrase.
 *
 * @module host/ssh
 */

import ssh2 from 'ssh2'

const { Client } = ssh2

/** Stdout capture cap (512 KiB). */
const STDOUT_LIMIT = 512 * 1024
/** Stderr capture cap (256 KiB). */
const STDERR_LIMIT = 256 * 1024
/** Default command timeout (60 s). */
const DEFAULT_TIMEOUT_MS = 60_000
/** Default probe timeout (20 s). */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
/** Minimum accepted timeout (1 s). */
const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted timeout (10 min). */
const MAX_TIMEOUT_MS = 600_000
/** Default connect timeout (15 s). */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Keepalive interval (10 s). */
const KEEPALIVE_INTERVAL_MS = 10_000
/** Default SFTP upload timeout (5 min). */
const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000
/** Maximum accepted SFTP upload timeout (1 h). */
const MAX_UPLOAD_TIMEOUT_MS = 3_600_000
/** SFTP parallel chunk count used by `fastPut`. */
const UPLOAD_CONCURRENCY = 16
/** SFTP chunk size used by `fastPut` (32 KiB). */
const UPLOAD_CHUNK_SIZE = 32 * 1024
/** Probe command: kernel/arch plus the remote user name. */
const PROBE_COMMAND = "uname -srm; printf '\\n'; id -un"

/**
 * Create one tagged error.
 * @param {string} code - machine-readable error code.
 * @param {string} message - fixed Chinese message (never contains secrets).
 * @param {unknown} [cause] - underlying failure kept off the public message.
 * @returns {Error & { code: string }} tagged error.
 */
function sshError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp an optional numeric option.
 * @param {unknown} value - caller value.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Validate the connection fields of an account record.
 * @param {unknown} record - full record (may contain credentials).
 * @returns {{ host: string, port: number, username: string, authType: 'password' | 'key' }} normalized fields.
 */
function normalizeRecord(record) {
  if (!isObject(record)) throw sshError('invalid-input', '连接配置不完整')
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  if (host === '') throw sshError('invalid-input', '主机地址不能为空')
  const username = typeof record.username === 'string' ? record.username.trim() : ''
  if (username === '') throw sshError('invalid-input', '用户名不能为空')
  const port = record.port === undefined || record.port === null ? 22 : Number(record.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw sshError('invalid-input', '端口必须是 1-65535 之间的整数')
  if (record.authType === 'password') {
    if (typeof record.password !== 'string' || record.password === '') throw sshError('invalid-input', '缺少密码凭据')
    return { host, port, username, authType: 'password' }
  }
  if (record.authType === 'key') {
    if (typeof record.privateKey !== 'string' || record.privateKey === '') throw sshError('invalid-input', '缺少私钥凭据')
    return { host, port, username, authType: 'key' }
  }
  throw sshError('invalid-input', '认证方式无效')
}

/**
 * Translate an SFTP failure into a friendly tagged error.
 *
 * SFTP errors carry numeric `code` values from the protocol, so they are mapped
 * separately from connection errors. Messages never contain credentials.
 *
 * @param {unknown} error - thrown value from ssh2.
 * @returns {Error & { code: string }} fixed-message error.
 */
function mapSftpError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : ''
  const code = error && typeof error.code === 'number' ? error.code : undefined
  if (code === 2 || /no such file/i.test(raw)) {
    return sshError('upload', '远端路径不存在或无法创建目标文件', error)
  }
  if (code === 3 || /permission denied/i.test(raw)) {
    return sshError('upload', '远端拒绝写入：当前 SSH 用户没有目标目录的写权限', error)
  }
  if (code === 4 || /no space left/i.test(raw)) {
    return sshError('upload', '远端磁盘空间不足', error)
  }
  if (code === 8 || /not support/i.test(raw)) {
    return sshError('upload', '远端 SFTP 不支持该操作', error)
  }
  if (/(local|ENOENT)/i.test(raw)) {
    return sshError('upload', '本地文件不存在或无法读取', error)
  }
  return sshError('upload', 'SFTP 上传失败，请检查本地文件与远端目录', error)
}

/**
 * Translate an ssh2/Node connection failure into a friendly tagged error.
 * @param {unknown} error - thrown value from ssh2.
 * @returns {Error & { code: string }} fixed-message error.
 */
function mapSshError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : ''
  const code = error && typeof error.code === 'string' ? error.code : ''
  const level = error && typeof error.level === 'string' ? error.level : ''
  if (
    level === 'client-authentication' ||
    /all configured authentication methods failed|permission denied|authentication failed/i.test(raw)
  ) {
    return sshError('auth', '认证失败，请检查用户名和凭据', error)
  }
  if (code === 'ECONNREFUSED') return sshError('network', '连接被拒绝：目标主机的端口没有在监听', error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return sshError('network', '无法解析主机名，请检查服务器地址', error)
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return sshError('network', '网络不可达，请检查网络连接', error)
  if (code === 'ECONNRESET' || /reset|socket hang up/i.test(raw)) return sshError('network', '连接被服务器重置', error)
  if (code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(raw)) return sshError('timeout', '连接超时，请检查服务器地址和网络', error)
  return sshError('unknown', 'SSH 连接失败，请检查主机、端口和认证信息', error)
}

/**
 * Build the ssh2 connection configuration. Credentials never leave this
 * function; host keys are accepted as-is for v1.
 * @param {object} record - full record.
 * @param {{ host: string, port: number, username: string, authType: 'password' | 'key' }} fields - normalized fields.
 * @param {number} connectTimeoutMs - ssh2 ready timeout.
 * @returns {object} ssh2 connect configuration.
 */
function connectionConfig(record, fields, connectTimeoutMs) {
  const config = {
    host: fields.host,
    port: fields.port,
    username: fields.username,
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    hostVerifier: () => true,
  }
  if (fields.authType === 'key') {
    config.privateKey = record.privateKey
    if (typeof record.passphrase === 'string' && record.passphrase !== '') config.passphrase = record.passphrase
  } else {
    config.password = record.password
  }
  return config
}

/**
 * Bounded byte capture for one output stream.
 * @param {number} limit - maximum captured bytes.
 * @returns {{ push: (chunk: unknown) => void, text: () => string, isTruncated: () => boolean }} capture handle.
 */
function createCapture(limit) {
  const chunks = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk) {
      if (truncated) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (buffer.length === 0) return
      const remaining = limit - bytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
      chunks.push(slice)
      bytes += slice.length
      if (slice.length < buffer.length) truncated = true
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    },
    isTruncated() {
      return truncated
    },
  }
}

/**
 * Create the SSH client used by the API, tools, discovery and update services.
 * @returns {{
 *   exec: (record: object, command: string, options?: { timeoutMs?: number, connectTimeoutMs?: number }) => Promise<object>,
 *   probe: (record: object, options?: { timeoutMs?: number, connectTimeoutMs?: number }) => Promise<object>,
 *   upload: (record: object, options: { localPath: string, remotePath: string, timeoutMs?: number, connectTimeoutMs?: number, onProgress?: Function }) => Promise<object>,
 * }} client operations.
 */
export function createSshClient() {
  /**
   * Run one shell command over SSH.
   * @param {object} record - full record including credentials.
   * @param {string} command - shell command to run remotely.
   * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - timeout overrides.
   * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, durationMs: number, truncated: boolean }>} execution result.
   */
  async function exec(record, command, options = {}) {
    const fields = normalizeRecord(record)
    if (typeof command !== 'string' || command.trim() === '') throw sshError('invalid-input', '命令不能为空')

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const connectTimeoutMs = clampNumber(
      options.connectTimeoutMs,
      Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )
    const config = connectionConfig(record, fields, connectTimeoutMs)
    const startedAt = Date.now()
    const client = new Client()
    /** @type {NodeJS.Timeout | undefined} */
    let timer

    const execution = new Promise((resolve, reject) => {
      let settled = false
      /**
       * Settle the execution once.
       * @param {Error | null} error - failure.
       * @param {object} [value] - success value.
       */
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const stdout = createCapture(STDOUT_LIMIT)
      const stderr = createCapture(STDERR_LIMIT)

      timer = setTimeout(() => {
        finish(sshError('timeout', `SSH 操作超时（${Math.round(timeoutMs / 1000)} 秒）`))
        try {
          client.end()
        } catch {
          /* already closed */
        }
      }, timeoutMs)

      client.on('ready', () => {
        client.exec(command, (error, channel) => {
          if (error) {
            finish(mapSshError(error))
            return
          }
          if (!channel) {
            finish(sshError('unknown', 'SSH 连接失败，请检查主机、端口和认证信息'))
            return
          }
          channel.on('data', (chunk) => {
            if (!settled) stdout.push(chunk)
          })
          channel.on('error', (streamError) => finish(mapSshError(streamError)))
          if (channel.stderr && typeof channel.stderr.on === 'function') {
            channel.stderr.on('data', (chunk) => {
              if (!settled) stderr.push(chunk)
            })
            channel.stderr.on('error', (streamError) => finish(mapSshError(streamError)))
          }
          channel.on('close', (code, signal) => {
            finish(null, {
              exitCode: typeof code === 'number' ? code : null,
              signal: typeof signal === 'string' ? signal : null,
              stdout: stdout.text(),
              stderr: stderr.text(),
              durationMs: Date.now() - startedAt,
              truncated: stdout.isTruncated() || stderr.isTruncated(),
            })
          })
        })
      })
      client.on('error', (error) => finish(mapSshError(error)))
      client.on('close', () => finish(mapSshError(new Error('连接已关闭'))))

      try {
        client.connect(config)
      } catch (error) {
        finish(mapSshError(error))
      }
    })

    try {
      return await execution
    } finally {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Check that one account is reachable and readable.
   * @param {object} record - full record including credentials.
   * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - timeout overrides.
   * @returns {Promise<{ success: true, latencyMs: number, output: string }>} probe result.
   */
  async function probe(record, options = {}) {
    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const connectTimeoutMs = clampNumber(
      options.connectTimeoutMs,
      Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )
    const result = await exec(record, PROBE_COMMAND, { timeoutMs, connectTimeoutMs })
    return { success: true, latencyMs: result.durationMs, output: result.stdout.trim() }
  }

  /**
   * Upload one local file over SFTP.
   *
   * This is the only remote write this module performs; it deliberately takes an
   * already-validated local path and remote path and never decides policy. The
   * caller (`host/upload.js`) is responsible for approval and verification.
   *
   * @param {object} record - full record including credentials.
   * @param {{ localPath: string, remotePath: string, timeoutMs?: number, connectTimeoutMs?: number, onProgress?: (sent: number, total: number) => void }} options - upload options.
   * @returns {Promise<{ bytes: number, durationMs: number, bytesPerSecond: number }>} upload result.
   */
  async function upload(record, options = {}) {
    const fields = normalizeRecord(record)
    const localPath = typeof options.localPath === 'string' ? options.localPath : ''
    const remotePath = typeof options.remotePath === 'string' ? options.remotePath : ''
    if (localPath === '') throw sshError('invalid-input', '本地文件路径不能为空')
    if (remotePath === '') throw sshError('invalid-input', '远程路径不能为空')

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_UPLOAD_TIMEOUT_MS)
    const connectTimeoutMs = clampNumber(
      options.connectTimeoutMs,
      Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )
    const config = connectionConfig(record, fields, connectTimeoutMs)
    const startedAt = Date.now()
    const client = new Client()
    /** @type {NodeJS.Timeout | undefined} */
    let timer

    const transfer = new Promise((resolve, reject) => {
      let settled = false
      /**
       * Settle the transfer once.
       * @param {Error | null} error - failure.
       * @param {object} [value] - success value.
       */
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }

      timer = setTimeout(() => {
        finish(sshError('timeout', `SFTP 上传超时（${Math.round(timeoutMs / 1000)} 秒）`))
        try {
          client.end()
        } catch {
          /* already closed */
        }
      }, timeoutMs)

      client.on('ready', () => {
        client.sftp((error, sftp) => {
          if (error) {
            finish(mapSftpError(error))
            return
          }
          if (!sftp) {
            finish(sshError('unknown', '无法启动 SFTP 子系统，请确认服务器已启用 SFTP'))
            return
          }
          /** @type {number} */
          let lastSent = 0
          sftp.fastPut(
            localPath,
            remotePath,
            { concurrency: UPLOAD_CONCURRENCY, chunkSize: UPLOAD_CHUNK_SIZE },
            (putError, bytes) => {
              if (putError) {
                finish(mapSftpError(putError))
                return
              }
              if (typeof options.onProgress === 'function' && typeof bytes === 'number' && bytes > 0) {
                try {
                  options.onProgress(bytes, bytes)
                } catch {
                  /* progress reporting is best effort */
                }
              }
              lastSent = typeof bytes === 'number' && bytes > 0 ? bytes : lastSent
              const durationMs = Math.max(1, Date.now() - startedAt)
              finish(null, {
                bytes: lastSent,
                durationMs,
                bytesPerSecond: Math.round((lastSent / durationMs) * 1000),
              })
            },
          )
        })
      })
      client.on('error', (error) => finish(mapSshError(error)))
      client.on('close', () => finish(sshError('network', '连接已关闭')))

      try {
        client.connect(config)
      } catch (error) {
        finish(mapSshError(error))
      }
    })

    try {
      return await transfer
    } finally {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
  }

  return { exec, probe, upload }
}
