/**
 * Final host-surface smoke check and test-run marker.
 *
 * Verifies that every host module loads and that the plugin entry exports the
 * contract `inject` list. The `TEST OK` line is the verification marker required
 * by CONTRACT.md.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import * as accounts from '../host/accounts.js'
import * as api from '../host/api.js'
import * as atomic from '../host/atomic.js'
import * as discover from '../host/discover.js'
import * as gate from '../host/gate.js'
import * as history from '../host/history.js'
import * as prompt from '../host/prompt.js'
import * as resources from '../host/resources.js'
import * as shell from '../host/shell.js'
import * as ssh from '../host/ssh.js'
import * as tools from '../host/tools.js'
import * as update from '../host/update.js'
import { inject } from '../index.js'

test('host module surface is complete', () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer', 'connection'])
  assert.equal(typeof atomic.createJsonFile, 'function')
  assert.equal(typeof accounts.createAccountStore, 'function')
  assert.equal(typeof resources.createResourceStore, 'function')
  assert.equal(typeof history.createHistoryStore, 'function')
  assert.equal(typeof shell.validateRemotePath, 'function')
  assert.equal(typeof ssh.createSshClient, 'function')
  assert.equal(typeof discover.createDiscoverService, 'function')
  assert.equal(typeof update.createUpdateService, 'function')
  assert.equal(typeof gate.createUpdateGate, 'function')
  assert.equal(typeof api.registerApiRoutes, 'function')
  assert.equal(typeof tools.registerTools, 'function')
  assert.equal(typeof prompt.registerPromptSection, 'function')
  console.log('TEST OK')
})
