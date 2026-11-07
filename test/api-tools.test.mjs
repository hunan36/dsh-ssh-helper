/**
 * Unit tests for host/api.js and host/tools.js: HTTP envelope/security and the
 * six tool definitions, schemas, execution and rendering.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAccountStore } from '../host/accounts.js'
import { registerApiRoutes } from '../host/api.js'
import { createHistoryStore } from '../host/history.js'
import { createResourceStore } from '../host/resources.js'
import { registerTools } from '../host/tools.js'

/**
 * Minimal JSON-schema validator for the DSH-supported subset.
 * @param {object} schema - schema node.
 * @param {unknown} value - value to validate.
 */
function validateSchema(schema, value) {
  if (!schema || typeof schema !== 'object') return
  if (Object.hasOwn(schema, 'oneOf')) {
    let matches = 0
    for (const branch of schema.oneOf) {
      try {
        validateSchema(branch, value)
        matches += 1
      } catch {
        /* not this branch */
      }
    }
    assert.equal(matches, 1, `expected exactly one oneOf branch for ${JSON.stringify(value)}`)
    return
  }
  if (!Object.hasOwn(schema, 'type')) return
  const type = schema.type
  const checks = {
    object: (entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    array: Array.isArray,
    string: (entry) => typeof entry === 'string',
    number: (entry) => typeof entry === 'number' && Number.isFinite(entry),
    integer: (entry) => Number.isInteger(entry),
    boolean: (entry) => typeof entry === 'boolean',
    null: (entry) => entry === null,
  }
  assert.ok(checks[type], `unsupported test schema type ${type}`)
  assert.ok(checks[type](value), `expected ${type}, got ${JSON.stringify(value)}`)
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), `expected enum ${schema.enum.join('|')}`)
  if (type === 'object') {
    for (const key of schema.required ?? []) assert.equal(Object.hasOwn(value, key), true, `missing required ${key}`)
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) validateSchema(child, value[key])
    }
  }
  if (type === 'array' && schema.items) {
    for (const entry of value) validateSchema(schema.items, entry)
  }
}

/**
 * Build a fake HTTP response.
 * @returns {object} response.
 */
function mockResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(payload) {
      this.body = payload
      this.writableEnded = true
    },
    destroy() {
      this.destroyed = true
    },
    once() {},
    off() {},
  }
}

/**
 * Build a fake HTTP request carrying one JSON body.
 * @param {unknown} body - body value.
 * @param {{ method?: string, url?: string, headers?: object }} [options] - request options.
 * @returns {object} request.
 */
function mockRequest(body, options = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(text, 'utf8')])
  req.method = options.method ?? 'POST'
  req.url = options.url ?? '/ssh-helper/api/accounts/list'
  req.headers = options.headers ?? { 'content-type': 'application/json' }
  return req
}

/**
 * Call one API method through the registered handler.
 * @param {Function} handler - route handler.
 * @param {string} method - API method.
 * @param {unknown} [body] - JSON body.
 * @param {{ method?: string, headers?: object }} [options] - HTTP method/header override.
 * @returns {Promise<{ status: number, json: object }>} response.
 */
async function callApi(handler, method, body, options = {}) {
  const res = mockResponse()
  const req = mockRequest(body, {
    url: `/ssh-helper/api/${method}`,
    method: options.method ?? 'POST',
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  })
  await handler(req, res)
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body), headers: res.headers }
}

/**
 * Create an API context and register the routes.
 * @param {object} services - services.
 * @param {{ trust?: boolean }} [options] - trust override.
 * @returns {{ ctx: object, routes: object[], handler: Function }} context.
 */
function createApiContext(services, options = {}) {
  const routes = []
  const ctx = {
    webServer: {
      register(config) {
        routes.push(config)
        return () => {}
      },
    },
    connection: { requestRejection: () => (options.trust === false ? { reason: 'no' } : undefined) },
    logger: { warn() {} },
  }
  registerApiRoutes(ctx, services)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/ssh-helper/api')
  return { ctx, routes, handler: routes[0].handler }
}

test('API serves account, resource and history methods through the envelope', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-api-'))
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  try {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    const history = createHistoryStore({ dir })
    accounts.load()
    resources.load()
    history.load()
    const ssh = {
      async probe() {
        return { success: true, latencyMs: 7, output: 'Linux test' }
      },
    }
    const { handler } = createApiContext({ accounts, resources, history, ssh })

    const empty = await callApi(handler, 'accounts/list')
    assert.equal(empty.status, 200)
    assert.equal(empty.json.ok, true)
    assert.deepEqual(empty.json.data.accounts, [])
    assert.deepEqual(empty.json.data.legacy, { available: false, count: 0 })
    assert.equal(empty.headers['cache-control'], 'no-store')

    const saved = await callApi(handler, 'accounts/save', {
      name: 'Prod',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'api-secret-password',
      note: 'n',
    })
    assert.equal(saved.status, 200)
    const account = saved.json.data.account
    assert.equal(account.name, 'Prod')
    assert.equal(account.hasPassword, true)
    assert.equal(JSON.stringify(saved.json).includes('api-secret-password'), false)
    assert.equal(path.isAbsolute(dir), true)

    const tested = await callApi(handler, 'accounts/test', { id: account.id })
    assert.equal(tested.status, 200)
    assert.equal(tested.json.data.success, true)
    assert.equal(tested.json.data.latencyMs, 7)
    assert.equal(tested.json.data.output, 'Linux test')

    const draft = await callApi(handler, 'accounts/test-draft', {
      host: '10.0.0.1',
      username: 'root',
      authType: 'password',
      password: 'draft-secret',
    })
    assert.equal(draft.status, 200)
    assert.equal(draft.json.data.success, true)

    const badDraft = await callApi(handler, 'accounts/test-draft', { host: 'h', username: 'u', authType: 'password' })
    assert.equal(badDraft.status, 400)
    assert.equal(badDraft.json.ok, false)
    assert.equal(badDraft.json.error.code, 'invalid-input')

    const resource = await callApi(handler, 'resources/save', {
      name: 'web-api',
      serverId: account.id,
      appDir: '/opt/web-api',
      updateCommand: 'git pull --ff-only',
      tags: ['prod'],
    })
    assert.equal(resource.status, 200)
    assert.equal(resource.json.data.resource.serverName, 'Prod')

    const listed = await callApi(handler, 'resources/list', {})
    assert.equal(listed.json.data.resources.length, 1)
    const filtered = await callApi(handler, 'resources/list', { server: 'Prod' })
    assert.equal(filtered.json.data.resources.length, 1)

    const fetched = await callApi(handler, 'resources/get', { id: resource.json.data.resource.id })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.json.data.resource.name, 'web-api')
    assert.deepEqual(fetched.json.data.history, [])

    const historyList = await callApi(handler, 'history/list', {})
    assert.equal(historyList.status, 200)
    assert.deepEqual(historyList.json.data.history, [])

    await history.append({
      action: 'apply',
      resourceId: resource.json.data.resource.id,
      resourceName: 'web-api',
      serverId: account.id,
      serverName: 'Prod',
      appDir: '/opt/web-api',
      backupPath: '/opt/.ssh-helper-backups/web-api/x.tar.gz',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      steps: [],
    })
    const withHistory = await callApi(handler, 'resources/get', { id: resource.json.data.resource.id })
    assert.equal(withHistory.json.data.history.length, 1)
    assert.equal(JSON.stringify(withHistory.json).includes('api-secret-password'), false)

    const deletedResource = await callApi(handler, 'resources/delete', { id: resource.json.data.resource.id })
    assert.equal(deletedResource.json.data.deleted, true)
    const deletedAccount = await callApi(handler, 'accounts/delete', { id: account.id })
    assert.equal(deletedAccount.json.data.deleted, true)
    const missing = await callApi(handler, 'accounts/delete', { id: account.id })
    assert.equal(missing.status, 404)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    rmSync(dir, { recursive: true, force: true })
  }
})

test('API imports legacy accounts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-api-'))
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-legacy-'))
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_HOME = home
    delete process.env.DSH_PROFILE_DIR
    const legacyDir = path.join(home, 'ssh-manager')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      path.join(legacyDir, 'servers.json'),
      JSON.stringify([{ id: 'x', name: 'Legacy', host: 'h', port: 22, username: 'u', authType: 'password', password: 'legacy-secret' }]),
      'utf8',
    )
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    const history = createHistoryStore({ dir })
    const { handler } = createApiContext({ accounts, resources, history, ssh: { async probe() { return { success: true, latencyMs: 1, output: '' } } } })
    const info = await callApi(handler, 'accounts/list')
    assert.equal(info.json.data.legacy.available, true)
    assert.equal(info.json.data.legacy.count, 1)
    const imported = await callApi(handler, 'accounts/import', {})
    assert.deepEqual(imported.json.data, { imported: 1, skipped: 0, total: 1 })
    assert.equal(JSON.stringify(imported.json).includes('legacy-secret'), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('API enforces trust, POST, body limit and unknown methods', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-api-'))
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  try {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    const history = createHistoryStore({ dir })
    const ssh = {}
    const trusted = createApiContext({ accounts, resources, history, ssh })
    const denied = createApiContext({ accounts, resources, history, ssh }, { trust: false })

    const forbidden = await callApi(denied.handler, 'accounts/list')
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.json.ok, false)

    const wrongMethod = await callApi(trusted.handler, 'accounts/list', undefined, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)

    const unknown = await callApi(trusted.handler, 'nope/nope', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'not-found')

    const wronglyTyped = await callApi(trusted.handler, 'accounts/list', {}, { headers: { 'content-type': 'text/plain' } })
    assert.equal(wronglyTyped.status, 415)
    assert.equal(wronglyTyped.json.error.code, 'unsupported-media-type')

    const missingType = await callApi(trusted.handler, 'accounts/list', {}, { headers: {} })
    assert.equal(missingType.status, 415)
    assert.equal(missingType.json.error.code, 'unsupported-media-type')

    const malformed = mockResponse()
    const req = Readable.from([Buffer.from('{not json', 'utf8')])
    req.method = 'POST'
    req.url = '/ssh-helper/api/accounts/list'
    req.headers = { 'content-type': 'application/json' }
    await trusted.handler(req, malformed)
    assert.equal(malformed.status, 400)
    assert.equal(JSON.parse(malformed.body).error.code, 'bad-request')

    const oversized = mockResponse()
    const bigReq = Readable.from([Buffer.alloc(1024 * 1024 + 1, 0x61)])
    bigReq.method = 'POST'
    bigReq.url = '/ssh-helper/api/accounts/list'
    bigReq.headers = { 'content-type': 'application/json' }
    let bigReqDestroyed = false
    bigReq.destroy = () => {
      bigReqDestroyed = true
    }
    await trusted.handler(bigReq, oversized)
    assert.equal(oversized.status, 400)
    assert.equal(JSON.parse(oversized.body).error.code, 'bad-request')
    assert.equal(bigReqDestroyed, true, 'an oversized body must destroy the request socket')

    const missingId = await callApi(trusted.handler, 'accounts/delete', {})
    assert.equal(missingId.status, 400)
    assert.equal(missingId.json.error.code, 'invalid-input')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Account fixture. */
const ACCOUNT_VIEW = {
  id: 'server-1',
  name: 'Deploy Server',
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  authType: 'password',
  hasPassword: true,
  hasKey: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** Resource fixture. */
const RESOURCE_VIEW = {
  id: 'resource-1',
  name: 'web-api',
  serverId: 'server-1',
  serverName: 'Deploy Server',
  appDir: '/opt/web-api',
  updateCommand: 'git pull --ff-only',
  backupEnabled: true,
  backupKeep: 5,
  timeoutSeconds: 600,
  tags: ['prod'],
  discovered: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** Plan fixture. */
const PLAN = {
  id: 'plan-1',
  agentId: 'agent-a',
  resourceId: 'resource-1',
  resourceName: 'web-api',
  serverId: 'server-1',
  serverName: 'Deploy Server',
  appDir: '/opt/web-api',
  updateCommand: 'git pull --ff-only',
  backup: { enabled: true, dir: '/opt/.ssh-helper-backups/web-api', file: '/opt/.ssh-helper-backups/web-api/web-api-20260101T000000Z.tar.gz' },
  preflight: {
    exists: true,
    writable: true,
    physicalPath: '/opt/web-api',
    sizeKB: 10,
    freeKB: 100000,
    markers: ['.git'],
    git: null,
    serviceUnits: [],
  },
  steps: [{ id: 'preflight', title: 'Preflight checks', detail: 'Inspect /opt/web-api' }],
  warnings: [],
  blockers: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:15:00.000Z',
  summary: { en: 'Update web-api', zh: '更新 web-api' },
}

/** History fixture. */
/** Upload target fixture (value returned by `upload.resolve`). */
const UPLOAD_TARGET = {
  serverId: 'server-1',
  serverName: 'Deploy Server',
  account: {},
  resourceId: 'resource-1',
  resourceName: 'web-api',
  localPath: '/tmp/dist.tgz',
  fileName: 'dist.tgz',
  sizeBytes: 1024,
  remotePath: '/tmp/dist.tgz',
  remoteDir: '/tmp',
  timeoutMs: 300000,
  warnings: [],
}

const HISTORY_ENTRY = {
  id: 'history-1',
  action: 'apply',
  resourceId: 'resource-1',
  resourceName: 'web-api',
  serverId: 'server-1',
  serverName: 'Deploy Server',
  appDir: '/opt/web-api',
  backupPath: '/opt/.ssh-helper-backups/web-api/x.tar.gz',
  status: 'success',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  steps: [
    {
      id: 'update',
      title: 'Run the update command',
      status: 'success',
      exitCode: 0,
      durationMs: 10,
      stdoutTail: 'ok',
      stderrTail: '',
      truncated: false,
    },
  ],
}

/** Upload history entry fixture. */
const UPLOAD_HISTORY_ENTRY = {
  ...HISTORY_ENTRY,
  action: 'upload',
  resourceName: 'dist.tgz',
  appDir: '/tmp',
  backupPath: '',
}

test('registerTools registers exactly the seven contract tools without bypass parameters', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  const disposers = registerTools(ctx, {
    accounts: { list: () => [], find: () => undefined, getSecretRecord: () => undefined },
    resources: { list: () => [], find: () => undefined, save: async () => RESOURCE_VIEW, remove: async () => true, get: () => RESOURCE_VIEW },
    history: { list: () => [] },
    ssh: { probe: async () => ({ success: true, latencyMs: 1, output: '' }) },
    discover: { scan: async () => ({}), inspect: async () => ({}) },
    update: { plan: async () => PLAN, peekPlan: () => PLAN, apply: async () => HISTORY_ENTRY, rollback: async () => HISTORY_ENTRY },
    upload: { resolve: () => UPLOAD_TARGET, execute: async () => UPLOAD_HISTORY_ENTRY },
  })
  assert.equal(disposers.length, 7)
  assert.deepEqual(
    registered.map((definition) => definition.name).sort(),
    [
      'ssh_helper_accounts',
      'ssh_helper_discover',
      'ssh_helper_resources',
      'ssh_helper_update_apply',
      'ssh_helper_update_plan',
      'ssh_helper_update_rollback',
      'ssh_helper_upload',
    ],
  )
  assert.equal(registered.some((definition) => definition.name === 'ssh_helper_exec'), false)
  const serialized = JSON.stringify(registered.map((definition) => definition.parameters))
  for (const forbidden of ['confirm', 'force', 'skip_approval', 'skipApproval']) assert.equal(serialized.includes(forbidden), false)
  for (const definition of registered) {
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.doesNotThrow(() => validateSchema(definition.output.schema, {}))
  }
  const apply = registered.find((definition) => definition.name === 'ssh_helper_update_apply')
  const rollback = registered.find((definition) => definition.name === 'ssh_helper_update_rollback')
  assert.equal(apply.isConcurrencySafe(), false)
  assert.equal(rollback.isConcurrencySafe(), false)
})

test('tools execute and their outputs validate and never leak secrets', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  const accountView = { ...ACCOUNT_VIEW }
  const secretRecord = { ...accountView, password: 'top-secret-password' }
  const services = {
    accounts: {
      list: () => [accountView],
      find: (query) => (query === accountView.id || query === accountView.name || query === 'Deploy' ? accountView : undefined),
      getSecretRecord: () => secretRecord,
    },
    resources: {
      list: () => [RESOURCE_VIEW],
      find: (query) => (query === RESOURCE_VIEW.id || query === RESOURCE_VIEW.name ? RESOURCE_VIEW : undefined),
      get: () => RESOURCE_VIEW,
      save: async () => RESOURCE_VIEW,
      remove: async () => true,
    },
    history: { list: () => [HISTORY_ENTRY], get: () => HISTORY_ENTRY },
    ssh: { probe: async () => ({ success: true, latencyMs: 4, output: 'Linux test' }) },
    discover: {
      scan: async () => ({ server: 'Deploy Server', os: 'Linux', user: 'deploy', candidates: [{ path: '/opt/web-api', markers: ['.git'] }], listening: [], services: [], truncated: false }),
      inspect: async (record, { path: value }) => ({ path: value, exists: true, writable: true, physicalPath: value, sizeKB: 1, topLevel: [], markers: ['.git'], git: null, serviceUnits: [], suggestedUpdateCommand: 'git pull --ff-only' }),
    },
    update: {
      plan: async () => PLAN,
      peekPlan: () => PLAN,
      apply: async () => HISTORY_ENTRY,
      rollback: async () => HISTORY_ENTRY,
    },
    upload: { resolve: () => UPLOAD_TARGET, execute: async () => UPLOAD_HISTORY_ENTRY },
  }
  registerTools(ctx, services)
  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  const exec = { agent: { id: 'agent-a' } }
  const cases = [
    ['ssh_helper_accounts', { action: 'list' }],
    ['ssh_helper_accounts', { action: 'test', account: 'Deploy Server' }],
    ['ssh_helper_discover', { action: 'scan', server: 'Deploy Server', roots: ['/opt'], limit: 5 }],
    ['ssh_helper_discover', { action: 'inspect', server: 'Deploy Server', path: '/opt/web-api' }],
    ['ssh_helper_resources', { action: 'list' }],
    ['ssh_helper_resources', { action: 'get', resource: 'web-api' }],
    ['ssh_helper_resources', { action: 'history', resource: 'web-api' }],
    ['ssh_helper_resources', { action: 'save', name: 'web-api', server: 'Deploy Server', app_dir: '/opt/web-api', update_command: 'git pull' }],
    ['ssh_helper_resources', { action: 'delete', resource: 'web-api' }],
    ['ssh_helper_update_plan', { resource: 'web-api' }],
    ['ssh_helper_update_apply', { plan_id: 'plan-1' }],
    ['ssh_helper_update_rollback', { resource: 'web-api' }],
  ]
  for (const [name, args] of cases) {
    const definition = byName.get(name)
    assert.ok(definition, name)
    const value = await definition.execute(args, exec)
    assert.equal(typeof value, 'object', name)
    assert.doesNotThrow(() => validateSchema(definition.output.schema, value), `${name} output schema`)
    const rendered = definition.output.render(args, value)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} render`)
    assert.equal(rendered.every((block) => block.type === 'text' && typeof block.text === 'string'), true)
    assert.equal(JSON.stringify(value).includes('top-secret-password'), false, `${name} leaked a secret`)
    assert.equal(JSON.stringify(rendered).includes('top-secret-password'), false, `${name} render leaked a secret`)
    if (name === 'ssh_helper_resources' && args.action === 'history') {
      assert.match(JSON.stringify(rendered), /web-api/, 'resources history render')
    }
  }
})

test('tools return structured messages for missing or invalid input', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  registerTools(ctx, {
    accounts: { list: () => [], find: () => undefined, getSecretRecord: () => undefined },
    resources: { list: () => [], find: () => undefined, get: () => undefined, save: async () => RESOURCE_VIEW, remove: async () => false },
    history: { list: () => [] },
    ssh: { probe: async () => ({ success: true, latencyMs: 1, output: '' }) },
    discover: { scan: async () => ({}), inspect: async () => ({}) },
    update: { plan: async () => PLAN, peekPlan: () => undefined, apply: async () => HISTORY_ENTRY, rollback: async () => HISTORY_ENTRY },
    upload: { resolve: () => UPLOAD_TARGET, execute: async () => UPLOAD_HISTORY_ENTRY },
  })
  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  const exec = { agent: { id: 'agent-a' } }
  for (const [name, args] of [
    ['ssh_helper_accounts', { action: 'test' }],
    ['ssh_helper_discover', { action: 'scan' }],
    ['ssh_helper_resources', { action: 'get' }],
    ['ssh_helper_update_plan', {}],
    ['ssh_helper_update_apply', {}],
    ['ssh_helper_update_apply', { plan_id: 'missing' }],
    ['ssh_helper_update_rollback', {}],
  ]) {
    const value = await byName.get(name).execute(args, exec)
    validateSchema(byName.get(name).output.schema, value)
    assert.equal(typeof value.message, 'string', `${name} message`)
  }
})

test('apply/rollback renderers receive (args, value) and show messages and history', async () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  registerTools(ctx, {
    accounts: { list: () => [], find: () => undefined, getSecretRecord: () => undefined },
    resources: { list: () => [], find: () => undefined, get: () => undefined, save: async () => RESOURCE_VIEW, remove: async () => false },
    history: { list: () => [] },
    ssh: { probe: async () => ({ success: true, latencyMs: 1, output: '' }) },
    discover: { scan: async () => ({}), inspect: async () => ({}) },
    update: { plan: async () => PLAN, peekPlan: () => undefined, apply: async () => HISTORY_ENTRY, rollback: async () => HISTORY_ENTRY },
    upload: { resolve: () => UPLOAD_TARGET, execute: async () => UPLOAD_HISTORY_ENTRY },
  })
  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  const apply = byName.get('ssh_helper_update_apply')
  const rollback = byName.get('ssh_helper_update_rollback')
  const exec = { agent: { id: 'agent-a' } }
  const textOf = (blocks) => blocks.map((block) => block.text).join('\n')

  const failed = await apply.execute({ plan_id: 'missing' }, exec)
  assert.match(textOf(apply.output.render({ plan_id: 'missing' }, failed)), /更新计划不存在/)

  const applied = textOf(apply.output.render({ plan_id: 'plan-1' }, HISTORY_ENTRY))
  assert.match(applied, /apply success/)
  assert.match(applied, /web-api/)

  const rolledBack = textOf(rollback.output.render({ resource: 'web-api' }, HISTORY_ENTRY))
  assert.match(rolledBack, /web-api/)
})
