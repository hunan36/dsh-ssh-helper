/**
 * Browser-half smoke test: load `client.js` in a VM with a minimal React and DOM
 * stub, mount the sidebar entry + main panel, and render the console shell.
 *
 * This catches module-wrapper mistakes, missing imports, slot-registration
 * drift (the page is a sidebar panel, not a Settings section) and render-time
 * exceptions without a browser.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Create the minimal browser globals the client half touches.
 * @returns {{ window: object, document: object }} globals.
 */
function createDom() {
  const style = { id: '', textContent: '', parentNode: null }
  const document = {
    baseURI: 'http://dsh.test/',
    activeElement: null,
    documentElement: { clientWidth: 1280 },
    getElementById: () => null,
    createElement: () => style,
    head: { appendChild: () => { style.parentNode = { removeChild() {} } } },
    body: { style: {}, appendChild() {}, removeChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    innerWidth: 1280,
    setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem() {} },
  }
  return { window, document, style }
}

/**
 * Load the client module and return its captured registrations.
 * @returns {{ id: string, inject: string[], registrations: object[], apply: Function }} module facts.
 */
function loadClient() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useEffect() {},
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const { window, document, style } = createDom()
  let captured
  window.__ModuleLoader__ = {
    load(module) {
      captured = module
      captured.registrations = []
      captured.api = module.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require(${name})`)
      })
    },
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register() { return () => {} },
      bind() { return (key) => key },
    },
    slots: {
      inject(_key, callback) { callback() },
      register(options, component) {
        captured.registrations.push({ options, component })
        return () => {}
      },
    },
  }
  vm.runInNewContext(SOURCE, { window, document, console, navigator: {} })
  captured.api.apply(ctx)
  captured.style = style
  return captured
}

/**
 * Render a createElement tree, invoking function components once.
 * @param {unknown} node - tree node.
 * @returns {string} concatenated text.
 */
function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderText).join('')
  if (typeof node.type === 'function') return renderText(node.type(node.props))
  return renderText(node.children)
}

test('client registers the sidebar entry + main panel and renders the console shell', () => {
  const module = loadClient()
  // The client module id must equal the package name; the client module graph
  // keys factories by manifest package name, not by loader row id.
  assert.equal(module.id, '@hunan36/dsh-ssh-helper')
  assert.deepEqual(Array.from(module.api.inject), ['slots', 'locale'])

  assert.equal(module.registrations.length, 2)
  const main = module.registrations.find((entry) => entry.options.name === 'main')
  const rail = module.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(main, 'main panel registration')
  assert.ok(rail, 'sidebar entry registration')
  assert.equal(main.options.key, 'ssh-helper')
  assert.equal(main.options.locale, 'sshHelper')
  assert.equal(rail.options.id, 'ssh-helper')
  assert.equal(rail.options.order, 15)
  assert.equal(rail.options.locale, 'sshHelper')
  assert.equal(rail.options.label(), 'nav')
  assert.equal(module.registrations.some((entry) => entry.options.name === 'settings.section'), false, 'must not register a Settings section')

  const tree = main.component({ t: (key) => key })
  assert.doesNotThrow(() => renderText(tree))
  const rendered = renderText(tree)
  assert.match(rendered, /title/)
  assert.match(rendered, /subtitle/)
  assert.match(rendered, /approvalPill/)
  assert.match(rendered, /viewAccounts/)
  assert.match(rendered, /viewDeployments/)
  assert.match(rendered, /viewActivity/)
  assert.match(rendered, /loading/)

  assert.doesNotThrow(() => rail.component({ size: 16, active: false }))
})

test('client source only requires react and has no JSX or forbidden packages', () => {
  assert.equal(SOURCE.includes('@deepseek-ai/'), false)
  const requires = SOURCE.match(/require\(([^)]*)\)/g) || []
  assert.deepEqual(requires, ["require('react')"])
  assert.equal(/dangerouslySetInnerHTML|new Function|\beval\(/.test(SOURCE), false)
})


test('theme tokens are declared on the page root so the side sheet inherits them', () => {
  const module = loadClient()
  const css = module.style.textContent
  const page = css.match(/\.dsh-ssh-helper-page\s*\{([\s\S]*?)\}/)
  assert.ok(page, 'page root block')
  for (const token of ['--ssh-accent', '--ssh-text', '--ssh-layer-1', '--ssh-layer-2', '--ssh-border', '--ssh-on-accent']) {
    assert.match(page[1], new RegExp(`${token}:`), `${token} must be defined on the page root`)
  }
  const section = css.match(/\.dsh-ssh-helper-section\s*\{([\s\S]*?)\}/)
  assert.ok(section, 'section block')
  assert.doesNotMatch(section[1], /--ssh-accent:/, 'section must not own the token scope')
  assert.match(css, /:where\(\.dsh-ssh-helper-page\) button,/, 'form controls inside the sheet need the inherit reset')
  assert.match(css, /--ssh-on-accent, #ffffff/, 'primary button label must have an explicit light fallback')
})
