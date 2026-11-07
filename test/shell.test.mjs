/**
 * Unit tests for host/shell.js: quoting, path safety and backup layout.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { backupLayout, remotePathWarnings, safeSegment, shQuote, validateRemotePath } from '../host/shell.js'

test('shQuote produces one safe POSIX single-quoted word', () => {
  const values = [
    'plain',
    'with space',
    "it's mine",
    '$HOME `whoami` ; rm -rf /',
    'line\nfeed',
    '中文',
    '',
  ]
  for (const value of values) {
    assert.equal(typeof shQuote(value), 'string')
    const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${shQuote(value)}`], { encoding: 'utf8' })
    assert.equal(output, value, `round-trip failed for ${JSON.stringify(value)}`)
  }
})

test('shQuote coerces non-strings', () => {
  assert.equal(shQuote(42), "'42'")
  assert.equal(shQuote(null), "''")
  assert.equal(shQuote(undefined), "''")
})

test('validateRemotePath accepts deployment directories', () => {
  const accepted = [
    '/opt/app',
    '/opt/app/',
    '/opt//app',
    '/var/www/site',
    '/srv/api',
    '/data/releases/web',
    '/app',
    '/home/alice/app',
    '/root/app',
    '/tmp/scratch',
    '/opt/中文目录',
  ]
  for (const candidate of accepted) {
    const normalized = validateRemotePath(candidate)
    assert.ok(normalized.startsWith('/'), candidate)
    assert.equal(normalized.includes('//'), false, candidate)
  }
  assert.equal(validateRemotePath('/opt/app/'), '/opt/app')
  assert.equal(validateRemotePath('/opt//app'), '/opt/app')
})

test('validateRemotePath rejects unsafe and system paths', () => {
  const rejected = [
    '',
    '  ',
    'relative/path',
    './opt/app',
    '/',
    '/bin',
    '/bin/sh',
    '/boot',
    '/boot/grub',
    '/dev',
    '/dev/shm',
    '/etc',
    '/etc/passwd',
    '/lib',
    '/lib/x',
    '/lib64',
    '/proc',
    '/proc/1',
    '/run',
    '/run/app',
    '/sbin',
    '/sys',
    '/usr',
    '/usr/local/app',
    '/var',
    '/var/lib',
    '/var/log',
    '/var/run',
    '/home',
    '/opt/../etc',
    '/opt/a/../b',
    '/opt/app/\u0000',
    '/opt/app\n/etc',
    `/${'a'.repeat(1100)}`,
  ]
  for (const candidate of rejected) {
    assert.throws(
      () => validateRemotePath(candidate),
      (error) => error instanceof Error && error.code === 'invalid-path',
      `expected ${JSON.stringify(candidate)} to be rejected`,
    )
  }
  assert.throws(() => validateRemotePath(42), (error) => error.code === 'invalid-path')
})

test('remotePathWarnings reports risky locations', () => {
  assert.ok(remotePathWarnings('/tmp/app').some((warning) => warning.includes('/tmp')))
  assert.ok(remotePathWarnings('/root').some((warning) => warning.includes('/root')))
  assert.ok(remotePathWarnings('/opt').some((warning) => warning.toLowerCase().includes('shallow')))
  assert.deepEqual(remotePathWarnings('/opt/app'), [])
  const inside = remotePathWarnings('/opt/app/backups', { appDir: '/opt/app' })
  assert.ok(inside.some((warning) => warning.toLowerCase().includes('inside')))
})

test('safeSegment sanitizes and never returns an empty segment', () => {
  assert.equal(safeSegment('web-api_2.0'), 'web-api_2.0')
  assert.equal(safeSegment('web api/../../etc'), 'web-api-..-..-etc')
  assert.ok(!safeSegment('').includes(' '))
  assert.equal(safeSegment(''), 'item')
  assert.equal(safeSegment('..'), 'item')
  assert.equal(safeSegment('.hidden'), 'hidden')
  assert.equal(safeSegment('中文'), 'item')
  assert.ok(safeSegment('a'.repeat(200)).length <= 64)
  assert.match(safeSegment('a b\tc'), /^[A-Za-z0-9._-]+$/)
})

test('backupLayout uses the contract default directory and compact stamp', () => {
  const layout = backupLayout({
    appDir: '/opt/web-api/',
    name: 'web-api',
    timestamp: Date.parse('2026-11-06T13:15:00Z'),
  })
  assert.equal(layout.parent, '/opt')
  assert.equal(layout.baseName, 'web-api')
  assert.equal(layout.dir, '/opt/.ssh-helper-backups/web-api')
  assert.equal(layout.file, '/opt/.ssh-helper-backups/web-api/web-api-20261106T131500Z.tar.gz')
  assert.equal(path.posix.dirname(layout.file), layout.dir)
})

test('backupLayout honors an explicit backup directory', () => {
  const layout = backupLayout({
    appDir: '/srv/api',
    backupDir: '/var/www/backups/api',
    name: 'API Service',
    timestamp: 0,
  })
  assert.equal(layout.dir, '/var/www/backups/api')
  assert.equal(layout.file, '/var/www/backups/api/API-Service-19700101T000000Z.tar.gz')
})

test('backupLayout rejects unsafe app directories', () => {
  assert.throws(() => backupLayout({ appDir: '/etc', name: 'x' }), (error) => error.code === 'invalid-path')
})
