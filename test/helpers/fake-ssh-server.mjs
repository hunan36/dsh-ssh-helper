/**
 * In-process SSH server for host-side end-to-end tests.
 *
 * The server accepts exactly one password account, generates a throwaway RSA
 * host key at module load and executes every `exec` request through the local
 * POSIX shell. A minimal filesystem-backed SFTP subsystem is served too, which
 * is enough to exercise probe/scan/inspect/plan/apply/rollback and upload
 * against a temporary directory without external services.
 *
 * @module test/helpers/fake-ssh-server
 */

import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import ssh2 from 'ssh2'

const { Server } = ssh2
const { OPEN_MODE, STATUS_CODE, flagsToString } = ssh2.utils.sftp

/** Throwaway host key shared by all servers started from this module. */
const HOST_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

/**
 * Serve one minimal but real SFTP subsystem backed by the local filesystem.
 *
 * Only the operations a client upload needs are implemented: REALPATH, STAT,
 * LSTAT, FSTAT, OPEN, WRITE, CLOSE and FSETSTAT. Unknown requests fail with
 * OP_UNSUPPORTED, which is what a real server does for unsupported extensions.
 *
 * @param {object} sftp - server-side SFTP instance.
 */
function attachSftpHandlers(sftp) {
  /** @type {Map<number, { path: string, fd: number }>} */
  const handles = new Map()
  let handleSeq = 0

  /**
   * Map one thrown fs error to an SFTP status code.
   * @param {unknown} error - thrown value.
   * @returns {number} status code.
   */
  function statusFor(error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    if (code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE
    if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED
    return STATUS_CODE.FAILURE
  }

  /**
   * Send one attrs response for a path or handle, falling back to a status.
   * @param {number} reqid - request id.
   * @param {string} target - absolute path.
   */
  function sendAttrs(reqid, target) {
    try {
      const stats = fs.statSync(target)
      sftp.attrs(reqid, {
        mode: stats.mode,
        uid: stats.uid,
        gid: stats.gid,
        size: stats.size,
        atime: Math.floor(stats.atimeMs / 1000),
        mtime: Math.floor(stats.mtimeMs / 1000),
      })
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  }

  sftp.on('REALPATH', (reqid, target) => {
    try {
      const resolved = fs.realpathSync(target)
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }])
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })

  sftp.on('STAT', (reqid, target) => sendAttrs(reqid, target))
  sftp.on('LSTAT', (reqid, target) => sendAttrs(reqid, target))

  sftp.on('FSTAT', (reqid, handle) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    sendAttrs(reqid, entry.path)
  })

  sftp.on('OPEN', (reqid, filename, flags) => {
    let fsFlags
    try {
      fsFlags = flagsToString(flags & (OPEN_MODE.READ | OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.EXCL))
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    try {
      const fd = fs.openSync(filename, fsFlags, 0o644)
      const handle = Buffer.alloc(4)
      const id = handleSeq++
      handle.writeUInt32BE(id, 0)
      handles.set(id, { path: filename, fd })
      sftp.handle(reqid, handle)
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    try {
      fs.writeSync(entry.fd, data, 0, data.length, offset)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })

  sftp.on('FSETSTAT', (reqid) => {
    // Chunk uploads never need attribute updates; report success so clients
    // that optimistically call it are not derailed.
    sftp.status(reqid, STATUS_CODE.OK)
  })

  sftp.on('SETSTAT', (reqid) => {
    sftp.status(reqid, STATUS_CODE.OK)
  })

  sftp.on('CLOSE', (reqid, handle) => {
    const id = handle.readUInt32BE(0)
    const entry = handles.get(id)
    if (!entry) {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    handles.delete(id)
    try {
      fs.closeSync(entry.fd)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })

  sftp.on('OPENDIR', (reqid) => {
    sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
  })

  sftp.on('REMOVE', (reqid, target) => {
    try {
      fs.unlinkSync(target)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })

  sftp.on('MKDIR', (reqid, target) => {
    try {
      fs.mkdirSync(target, { recursive: true })
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      sftp.status(reqid, statusFor(error))
    }
  })
}

/**
 * Start one fake SSH server on a free loopback port.
 *
 * @param {object} [options] - server options.
 * @param {string} [options.username] - accepted user name.
 * @param {string} [options.password] - accepted password.
 * @param {string} [options.cwd] - working directory for executed commands.
 * @param {(context: { command: string, stream: object, cwd: string }) => boolean | void} [options.onExec] -
 *   optional interceptor; return `true` when the callback handled the command.
 * @returns {Promise<{ port: number, commands: string[], close: () => Promise<void> }>} server handle.
 */
export async function startFakeSshServer(options = {}) {
  const username = typeof options.username === 'string' ? options.username : 'tester'
  const password = typeof options.password === 'string' ? options.password : 'test-pass'
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd()
  const onExec = typeof options.onExec === 'function' ? options.onExec : undefined

  /** @type {string[]} */
  const commands = []
  /** @type {Set<object>} */
  const clients = new Set()

  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        ctx.accept()
        return
      }
      if (ctx.method === 'none') {
        ctx.reject(['password'])
        return
      }
      ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        if (!session) return
        session.on('exec', (acceptExec, rejectExec, info) => {
          const command = info && typeof info.command === 'string' ? info.command : ''
          commands.push(command)
          const stream = acceptExec()
          if (!stream) return
          if (onExec) {
            let handled = false
            try {
              handled = onExec({ command, stream, cwd }) === true
            } catch {
              handled = false
            }
            if (handled) return
          }
          const child = spawn('/bin/sh', ['-c', command], {
            cwd,
            env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
          })
          child.stdout.on('data', (chunk) => {
            try {
              stream.write(chunk)
            } catch {
              /* stream closed */
            }
          })
          child.stderr.on('data', (chunk) => {
            try {
              stream.stderr.write(chunk)
            } catch {
              /* stream closed */
            }
          })
          child.on('error', () => {
            try {
              stream.exit(127)
              stream.end()
            } catch {
              /* stream closed */
            }
          })
          child.on('close', (code) => {
            try {
              stream.exit(typeof code === 'number' ? code : 1)
              stream.end()
            } catch {
              /* stream closed */
            }
          })
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          if (!sftp) return
          attachSftpHandlers(sftp)
        })
      })
    })
  })

  server.on('error', () => {})

  await new Promise((resolve, reject) => {
    const fail = (error) => {
      server.off('listening', done)
      reject(error)
    }
    const done = () => {
      server.off('error', fail)
      resolve()
    }
    server.once('error', fail)
    server.once('listening', done)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake ssh server did not bind a TCP port')

  /**
   * Stop the server and drop every open client connection.
   * @returns {Promise<void>} resolves once the listener closed.
   */
  async function close() {
    for (const client of clients) {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
    clients.clear()
    await new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  return { port: address.port, commands, close }
}
