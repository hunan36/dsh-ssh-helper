/**
 * HTTP API for the dsh-ssh-helper Settings section.
 *
 * One prefix route, `/ssh-helper/api`, answers
 * `POST /ssh-helper/api/<method>` with a JSON body and a JSON envelope:
 * `{ ok: true, data }` on success and `{ ok: false, error: { code, message } }`
 * on failure. Requests are fenced by `ctx.connection.requestRejection`, bodies
 * are bounded to 1 MiB, and no handler ever returns a password, private key or
 * passphrase.
 *
 * @module host/api
 */

/** Route prefix owned by this plugin. */
const API_PREFIX = '/ssh-helper/api'
/** Maximum accepted JSON body size (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024
/** Message shown for unexpected internal failures. */
const INTERNAL_MESSAGE = '服务器内部错误'
/** Recent history entries returned by `resources/get`. */
const RECENT_HISTORY_LIMIT = 20

/**
 * Create one tagged error.
 * @param {string} code - machine-readable code.
 * @param {string} message - friendly Chinese message.
 * @returns {Error & { code: string }} tagged error.
 */
function apiError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {unknown} value @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a response is still writable.
 * @param {object} res - ServerResponse-like object.
 * @returns {boolean} writability.
 */
function canWrite(res) {
  if (!res || typeof res !== 'object') return false
  if (res.headersSent === true || res.writableEnded === true || res.destroyed === true) return false
  return typeof res.writeHead === 'function' && typeof res.end === 'function'
}

/**
 * Write one JSON response, tolerating a client that already went away.
 * @param {object} res - ServerResponse-like object.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function writeJson(res, status, body) {
  if (!canWrite(res)) {
    try {
      res.destroy?.()
    } catch {
      /* nothing left to release */
    }
    return
  }
  let payload
  try {
    payload = JSON.stringify(body)
  } catch {
    payload = JSON.stringify({ ok: false, error: { code: 'internal', message: INTERNAL_MESSAGE } })
    status = 500
  }
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  } catch {
    try {
      res.destroy?.()
    } catch {
      /* response already gone */
    }
  }
}

/**
 * Write the success envelope.
 * @param {object} res - response.
 * @param {object} data - payload.
 */
function writeOk(res, data) {
  writeJson(res, 200, { ok: true, data })
}

/**
 * Write the failure envelope.
 * @param {object} res - response.
 * @param {number} status - HTTP status.
 * @param {string} code - machine-readable code.
 * @param {string} message - friendly Chinese message.
 */
function writeFail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Map one thrown value to the API failure envelope.
 * @param {object} ctx - host plugin context (logger optional).
 * @param {object} res - response.
 * @param {unknown} error - thrown value.
 */
function writeError(ctx, res, error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const message = error && typeof error.message === 'string' ? error.message : ''
  if (code === 'invalid-input' || code === 'invalid-path') return writeFail(res, 400, code, message || '请求参数无效')
  if (code === 'bad-request') return writeFail(res, 400, code, message || '请求格式无效')
  if (code === 'unsupported-media-type') return writeFail(res, 415, code, message || '请求 content-type 不受支持')
  if (code === 'conflict') return writeFail(res, 409, code, message || '请求存在冲突')
  if (code === 'busy') return writeFail(res, 409, code, message || '操作正在进行中')
  if (code === 'not-found' || code === 'plan-not-found' || code === 'no-backup') {
    return writeFail(res, 404, code, message || '资源不存在')
  }
  if (code === 'plan-expired') return writeFail(res, 410, code, message || '计划已过期')
  try {
    ctx?.logger?.warn?.(`dsh-ssh-helper: API request failed${message ? `: ${message}` : ''}`)
  } catch {
    /* logging is best effort */
  }
  return writeFail(res, 500, 'internal', INTERNAL_MESSAGE)
}

/**
 * Read and parse the bounded JSON request body.
 *
 * A body larger than `MAX_BODY_BYTES` destroys the request socket instead of
 * only abandoning the remainder, so an attacker cannot keep streaming bytes at
 * a bounded buffer.
 *
 * @param {object} req - IncomingMessage-like async iterable.
 * @returns {Promise<object>} parsed body (`{}` for an empty body).
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      oversized = true
      break
    }
    chunks.push(buffer)
  }
  if (oversized) {
    // Do not merely abandon the remainder: drop the socket so the sender stops
    // streaming instead of being throttled at the 1 MiB boundary.
    try {
      req.destroy?.()
    } catch {
      /* the socket is already gone */
    }
    throw apiError('bad-request', '请求体超过 1 MiB 限制')
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw apiError('bad-request', '请求体不是有效的 JSON')
  }
  if (!isObject(parsed)) throw apiError('bad-request', '请求体必须是 JSON 对象')
  return parsed
}

/**
 * Whether one request declares a JSON body.
 *
 * The check is conservative: an absent or unrelated `content-type` is rejected.
 * A browser cannot send `application/json` cross-origin without a preflight, so
 * this is a second fence behind `requestRejection` and it keeps form-encoded or
 * plain-text traffic away from the JSON parser.
 *
 * @param {object} req - IncomingMessage-like object.
 * @returns {boolean} whether the request declares `application/json`.
 */
function hasJsonContentType(req) {
  const headers = req && typeof req === 'object' ? req.headers : undefined
  const raw = headers && typeof headers === 'object' ? headers['content-type'] : undefined
  const contentType = typeof raw === 'string' ? raw.trim() : ''
  return /^application\/json\b/i.test(contentType)
}

/**
 * Require one non-empty string id.
 * @param {object} body - request body.
 * @param {string} [label] - error label.
 * @returns {string} trimmed id.
 */
function requireId(body, label = 'id') {
  const id = body && typeof body === 'object' ? body.id : undefined
  if (typeof id !== 'string' || id.trim() === '') throw apiError('invalid-input', `缺少 ${label}`)
  return id.trim()
}

/**
 * Run a connectivity test without failing the API call for a reachable
 * failure: a failed connection is a successful response with `success: false`.
 * @param {object} ssh - ssh client.
 * @param {object} record - full record including credentials.
 * @returns {Promise<{ success: boolean, latencyMs: number, message: string, output?: string }>} test result.
 */
async function runConnectionTest(ssh, record) {
  const startedAt = Date.now()
  try {
    const probed = await ssh.probe(record)
    return {
      success: true,
      latencyMs: typeof probed.latencyMs === 'number' ? probed.latencyMs : Date.now() - startedAt,
      message: '连接成功',
      output: typeof probed.output === 'string' ? probed.output : '',
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' && error.message !== '' ? error.message : '连接失败'
    return { success: false, latencyMs: Date.now() - startedAt, message }
  }
}

/**
 * Build the method table.
 * @param {{ accounts: object, resources: object, history: object, ssh: object }} services - stores and client.
 * @returns {Record<string, (body: object) => Promise<object>>} method handlers.
 */
function createMethods({ accounts, resources, history, ssh }) {
  return {
    /**
     * @returns {Promise<{ accounts: object[], legacy: { available: boolean, count: number } }>} accounts and legacy info.
     */
    async 'accounts/list'() {
      const info = accounts.legacyInfo()
      // `legacyInfo().source` is an absolute host path; it must not reach the
      // browser, so only the two countable fields are projected here.
      return {
        accounts: accounts.list(),
        legacy: { available: info.available === true, count: typeof info.count === 'number' ? info.count : 0 },
      }
    },
    /**
     * @param {object} body - flat account payload with optional `id`.
     * @returns {Promise<{ account: object }>} saved account view.
     */
    async 'accounts/save'(body) {
      const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : ''
      const account = id === '' ? await accounts.create(body) : await accounts.update(id, body)
      return { account }
    },
    /**
     * @param {object} body - `{ id }`.
     * @returns {Promise<{ deleted: true }>} deletion marker.
     */
    async 'accounts/delete'(body) {
      const id = requireId(body, '账户 id')
      const deleted = await accounts.remove(id)
      if (!deleted) throw apiError('not-found', '账户不存在')
      return { deleted: true }
    },
    /**
     * @param {object} body - `{ id }`.
     * @returns {Promise<object>} connectivity test result.
     */
    async 'accounts/test'(body) {
      const id = requireId(body, '账户 id')
      const record = accounts.getSecretRecord(id)
      if (!record) throw apiError('not-found', '账户不存在')
      return runConnectionTest(ssh, record)
    },
    /**
     * @param {object} body - account draft.
     * @returns {Promise<object>} connectivity test result.
     */
    async 'accounts/test-draft'(body) {
      const record = await accounts.testDraft(body)
      return runConnectionTest(ssh, record)
    },
    /** @returns {Promise<{ imported: number, skipped: number, total: number }>} import summary. */
    async 'accounts/import'() {
      return accounts.importLegacy()
    },
    /**
     * @param {object} body - optional `{ server }` filter.
     * @returns {Promise<{ resources: object[] }>} resource views.
     */
    async 'resources/list'(body) {
      return { resources: resources.list({ server: typeof body.server === 'string' ? body.server : undefined }) }
    },
    /**
     * @param {object} body - `{ id }` or `{ resource }`.
     * @returns {Promise<{ resource: object, history: object[] }>} resource and recent history.
     */
    async 'resources/get'(body) {
      const query =
        typeof body.id === 'string' && body.id.trim() !== ''
          ? body.id.trim()
          : typeof body.resource === 'string' && body.resource.trim() !== ''
            ? body.resource.trim()
            : ''
      if (query === '') throw apiError('invalid-input', '缺少资源 id')
      const resource = resources.find(query)
      if (!resource) throw apiError('not-found', '资源不存在')
      return { resource, history: history.list({ resourceId: resource.id, limit: RECENT_HISTORY_LIMIT }) }
    },
    /**
     * @param {object} body - flat resource payload with optional `id`.
     * @returns {Promise<{ resource: object }>} saved resource view.
     */
    async 'resources/save'(body) {
      return { resource: await resources.save(body) }
    },
    /**
     * @param {object} body - `{ id }`.
     * @returns {Promise<{ deleted: true }>} deletion marker.
     */
    async 'resources/delete'(body) {
      const id = requireId(body, '资源 id')
      const deleted = await resources.remove(id)
      if (!deleted) throw apiError('not-found', '资源不存在')
      return { deleted: true }
    },
    /**
     * @param {object} body - `{ resource?, limit? }`.
     * @returns {Promise<{ history: object[] }>} history entries.
     */
    async 'history/list'(body) {
      const rawResource = typeof body.resource === 'string' ? body.resource.trim() : ''
      let resourceId
      if (rawResource !== '') {
        const resource = resources.find(rawResource)
        resourceId = resource ? resource.id : rawResource
      }
      const limit =
        typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.min(200, Math.max(1, Math.round(body.limit))) : undefined
      return { history: history.list({ resourceId, limit }) }
    },
  }
}

/**
 * Register the `/ssh-helper/api` prefix route.
 * @param {object} ctx - host plugin context (`webServer`, `connection`).
 * @param {{ accounts: object, resources: object, history: object, ssh: object }} services - stores and client.
 * @returns {() => void} route disposer.
 */
export function registerApiRoutes(ctx, { accounts, resources, history, ssh } = {}) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new Error('dsh-ssh-helper: webServer service is unavailable')
  }
  if (!accounts || !resources || !history || !ssh) throw new Error('dsh-ssh-helper: API services are unavailable')
  const methods = createMethods({ accounts, resources, history, ssh })

  /**
   * Request handler for the prefix route.
   * @param {object} req - IncomingMessage.
   * @param {object} res - ServerResponse.
   * @returns {Promise<void>} resolves once the response settled.
   */
  async function handle(req, res) {
    let closed = false
    const markClosed = () => {
      closed = true
    }
    try {
      res?.once?.('close', markClosed)
      req?.once?.('error', markClosed)
    } catch {
      /* event registration is best effort */
    }
    try {
      const connection = ctx.connection
      let rejected = true
      try {
        rejected = !connection || typeof connection.requestRejection !== 'function' ? true : connection.requestRejection(req) !== undefined
      } catch {
        rejected = true
      }
      if (rejected) {
        writeFail(res, 403, 'forbidden', '请求被拒绝')
        return
      }
      if (req.method !== 'POST') {
        writeFail(res, 405, 'method-not-allowed', '仅支持 POST 请求')
        return
      }
      let method = ''
      try {
        const pathname = new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh.internal').pathname
        if (pathname.startsWith(`${API_PREFIX}/`)) method = pathname.slice(API_PREFIX.length + 1)
      } catch {
        method = ''
      }
      if (method === '' || method.startsWith('/') || method.endsWith('/') || method.includes('//')) {
        writeFail(res, 404, 'not-found', '未知的 API 方法')
        return
      }
      const handler = Object.hasOwn(methods, method) ? methods[method] : undefined
      if (typeof handler !== 'function') {
        writeFail(res, 404, 'not-found', `未知的 API 方法 "${method}"`)
        return
      }
      if (!hasJsonContentType(req)) {
        writeFail(res, 415, 'unsupported-media-type', '请求 content-type 必须是 application/json')
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        if (!closed) writeError(ctx, res, error)
        return
      }
      if (closed) return
      try {
        const data = await handler(body)
        if (!closed) writeOk(res, data)
      } catch (error) {
        if (!closed) writeError(ctx, res, error)
      }
    } catch (error) {
      if (!closed) writeError(ctx, res, error)
    } finally {
      try {
        res?.off?.('close', markClosed)
        req?.off?.('error', markClosed)
      } catch {
        /* listener cleanup is best effort */
      }
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
}
