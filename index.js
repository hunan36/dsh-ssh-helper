/**
 * dsh-ssh-helper host entry.
 *
 * Creates the account/resource/history stores, the SSH and discovery clients,
 * the update and upload services and the approval gate, then mounts the HTTP API,
 * the seven agent tools, the `## SSH Helper` system-prompt section and the
 * `tools/pre-execute` gate inside one `ctx.effect`, so disposing the plugin
 * fiber releases every registration.
 *
 * @module dsh-ssh-helper
 */

import { createAccountStore, resolveDataDir } from './host/accounts.js'
import { registerApiRoutes } from './host/api.js'
import { createDiscoverService } from './host/discover.js'
import { createUpdateGate } from './host/gate.js'
import { createHistoryStore } from './host/history.js'
import { registerPromptSection } from './host/prompt.js'
import { createResourceStore } from './host/resources.js'
import { createSshClient } from './host/ssh.js'
import { registerTools } from './host/tools.js'
import { createUpdateService } from './host/update.js'
import { createUploadService } from './host/upload.js'

/** Services that must exist before this plugin mounts. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/**
 * Log one warning without ever throwing.
 * @param {object} ctx - plugin context.
 * @param {string} message - warning text (never contains credentials).
 */
function warn(ctx, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.warn === 'function') logger.warn(`dsh-ssh-helper: ${message}`)
  } catch {
    /* logging is best effort */
  }
}

/**
 * Register one resource, keeping the plugin tree alive if it fails.
 * @param {object} ctx - plugin context.
 * @param {string} label - resource label for warnings.
 * @param {() => Function | Function[]} register - registration callback.
 * @param {Function[]} collected - disposer accumulator.
 */
function safelyRegister(ctx, label, register, collected) {
  try {
    const registered = register()
    const queue = Array.isArray(registered) ? registered : [registered]
    for (const disposer of queue) {
      if (typeof disposer === 'function') collected.push(disposer)
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error)
    warn(ctx, `${label} registration failed: ${message}`)
  }
}

/**
 * Load one store eagerly, reporting a failure as a warning.
 * @param {object} ctx - plugin context.
 * @param {string} label - store label.
 * @param {{ load: Function }} store - store instance.
 */
function loadStore(ctx, label, store) {
  try {
    store.load()
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error)
    warn(ctx, `failed to load ${label}: ${message}`)
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx - host plugin context.
 * @param {object} [_config] - loader config (unused; the bundle passes `{}`).
 */
export function apply(ctx, _config) {
  const dir = resolveDataDir()
  const accounts = createAccountStore({ dir })
  const resources = createResourceStore({ dir, accounts })
  const history = createHistoryStore({ dir })
  const ssh = createSshClient()
  const discover = createDiscoverService({ ssh })
  const update = createUpdateService({ ssh, resources, history })
  const upload = createUploadService({ ssh, accounts, resources, history })
  const gate = createUpdateGate({ update, upload, resources })

  loadStore(ctx, 'accounts', accounts)
  loadStore(ctx, 'resources', resources)
  loadStore(ctx, 'history', history)

  const mount = () => {
    /** @type {Function[]} */
    const disposers = []
    // The approval gate must mount before any remote-write tool. If it does not,
    // the DSH `tools/pre-execute` waterfall would default to `allow`, turning
    // apply/rollback/upload into unguarded writes, so writes are disabled
    // instead of proceeding without a gate.
    let gateReady = false
    safelyRegister(
      ctx,
      'approval gate',
      () => {
        const dispose = ctx.on('tools/pre-execute', gate)
        gateReady = true
        return dispose
      },
      disposers,
    )
    safelyRegister(ctx, 'HTTP API', () => registerApiRoutes(ctx, { accounts, resources, history, ssh }), disposers)
    safelyRegister(
      ctx,
      'agent tools',
      () =>
        registerTools(ctx, { accounts, resources, history, ssh, discover, update, upload, allowWrites: gateReady }),
      disposers,
    )
    safelyRegister(ctx, 'system prompt section', () => registerPromptSection(ctx, { accounts, resources }), disposers)
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          const message = error && typeof error.message === 'string' ? error.message : String(error)
          warn(ctx, `dispose failed: ${message}`)
        }
      }
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(mount, 'dsh-ssh-helper: accounts, resources, history, tools, prompt, API and approval gate')
  } else {
    mount()
  }
}
