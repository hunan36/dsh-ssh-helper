/**
 * Tests for the plugin entry point and the system-prompt section.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAccountStore } from '../host/accounts.js'
import { registerPromptSection } from '../host/prompt.js'
import { createResourceStore } from '../host/resources.js'
import { apply, inject } from '../index.js'

/**
 * Create one temporary directory.
 * @returns {string} path.
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-plugin-'))
}

/**
 * Create a fake Cordis context that records registrations.
 * @param {{ failTools?: boolean, withoutWebServer?: boolean }} [options] - failure switches.
 * @returns {{ ctx: object, state: object }} fake context and recorded state.
 */
function fakeContext(options = {}) {
  const state = { effects: [], disposers: [], listeners: [], tools: [], sections: [], routes: [], warnings: [] }
  const ctx = {
    logger: {
      warn(message) {
        state.warnings.push(String(message))
      },
    },
    effect(fn, label) {
      state.effects.push(label)
      const disposer = fn()
      state.disposers.push(disposer)
      return disposer
    },
    on(event, handler) {
      state.listeners.push({ event, handler })
      return () => {}
    },
    tools: {
      register(definition) {
        if (options.failTools) throw new Error('tools unavailable')
        state.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(definition) {
        state.sections.push(definition)
        return () => {}
      },
    },
    webServer: options.withoutWebServer
      ? undefined
      : {
          register(config) {
            state.routes.push(config)
            return () => {}
          },
        },
    connection: { requestRejection: () => undefined },
  }
  return { ctx, state }
}

test('index exports the contract inject list and mounts all registrations', async () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer', 'connection'])
  const dir = tempDir()
  const previous = process.env.DSH_SSH_HELPER_DIR
  try {
    process.env.DSH_SSH_HELPER_DIR = dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'accounts.json'),
      JSON.stringify([
        {
          id: 'account-1',
          name: 'Prod',
          host: '10.0.0.1',
          port: 22,
          username: 'root',
          authType: 'password',
          password: 'never-print-this-password',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      'utf8',
    )
    const { ctx, state } = fakeContext()
    apply(ctx, {})
    assert.equal(state.effects.length, 1)
    assert.equal(state.listeners.length, 1)
    assert.equal(state.listeners[0].event, 'tools/pre-execute')
    assert.equal(typeof state.listeners[0].handler, 'function')
    assert.equal(state.routes.length, 1)
    assert.equal(state.routes[0].path, '/ssh-helper/api')
    assert.equal(state.tools.length, 7)
    assert.equal(state.sections.length, 1)
    assert.equal(state.sections[0].name, 'ssh-helper:resources')
    assert.equal(state.sections[0].order, 45)

    const prompt = state.sections[0].text()
    assert.match(prompt, /## SSH Helper/)
    assert.match(prompt, /- Prod — root@10\.0\.0\.1:22 \(password auth\)/)
    assert.match(prompt, /ssh_helper_update_apply/)
    assert.match(prompt, /always ask the user for approval/)
    assert.equal(prompt.includes('never-print-this-password'), false)
    assert.equal(JSON.stringify(state.tools).includes('never-print-this-password'), false)

    assert.equal(state.disposers.length, 1)
    assert.doesNotThrow(() => state.disposers[0]())
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_HELPER_DIR
    else process.env.DSH_SSH_HELPER_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index survives a missing optional webServer and a failing tools service', () => {
  const dir = tempDir()
  const previous = process.env.DSH_SSH_HELPER_DIR
  try {
    process.env.DSH_SSH_HELPER_DIR = dir
    const missingWeb = fakeContext({ withoutWebServer: true })
    assert.doesNotThrow(() => apply(missingWeb.ctx, {}))
    assert.equal(missingWeb.state.tools.length, 7)
    assert.equal(missingWeb.state.warnings.some((warning) => warning.includes('HTTP API')), true)

    const failingTools = fakeContext({ failTools: true })
    assert.doesNotThrow(() => apply(failingTools.ctx, {}))
    assert.equal(failingTools.state.routes.length, 1)
    assert.equal(failingTools.state.warnings.some((warning) => warning.includes('failed to register tool')), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_HELPER_DIR
    else process.env.DSH_SSH_HELPER_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prompt section lists accounts and resources and never secrets', async () => {
  const dir = tempDir()
  try {
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    accounts.load()
    resources.load()
    const account = await accounts.create({ name: 'Prod', host: '10.0.0.1', username: 'root', authType: 'password', password: 'secret-value' })
    await resources.save({ name: 'web-api', serverId: account.id, appDir: '/opt/web-api', updateCommand: 'git pull' })

    const sections = []
    const disposer = registerPromptSection(
      { systemPrompt: { section: (definition) => (sections.push(definition), () => {}) } },
      { accounts, resources },
    )
    assert.equal(typeof disposer, 'function')
    assert.equal(sections.length, 1)
    const text = sections[0].text()
    assert.match(text, /## SSH Helper/)
    assert.match(text, /- Prod — root@10\.0\.0\.1:22 \(password auth\)/)
    assert.match(text, /- web-api — Prod:\/opt\/web-api \(last update: never\)/)
    assert.match(text, /ssh_helper_discover/)
    assert.match(text, /approval/)
    assert.equal(text.includes('secret-value'), false)
    assert.equal(text.includes('password:'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prompt section empty state and missing service errors', () => {
  const dir = tempDir()
  try {
    const accounts = createAccountStore({ dir })
    const resources = createResourceStore({ dir, accounts })
    const sections = []
    registerPromptSection(
      { systemPrompt: { section: (definition) => (sections.push(definition), () => {}) } },
      { accounts, resources },
    )
    const text = sections[0].text()
    assert.match(text, /No SSH accounts are configured/)
    assert.match(text, /No deployment resources are catalogued/)
    assert.throws(() => registerPromptSection({}, { accounts, resources }))
    assert.throws(() => registerPromptSection({ systemPrompt: { section: () => {} } }, {}))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
