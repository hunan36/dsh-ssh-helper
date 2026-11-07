/**
 * Atomic JSON file storage.
 *
 * Every data file of the plugin goes through this module. Writes are serialized
 * through one promise chain, written to `<file>.tmp` with mode `0600`, then
 * renamed over the live file so a reader never observes a half-written JSON
 * document. A file whose content is not valid JSON is moved aside to
 * `<file>.corrupt-<timestamp>` and treated as absent, which lets the plugin
 * start from an empty store instead of crashing.
 *
 * @module host/atomic
 */

import { chmodSync, copyFileSync, readFileSync, renameSync } from 'node:fs'
import { chmod, mkdir, open, rename } from 'node:fs/promises'
import path from 'node:path'

/** POSIX mode for data files and their temporary siblings. */
const FILE_MODE = 0o600
/** POSIX mode for the plugin data directory (owner-only). */
const DIR_MODE = 0o700

/**
 * Move an unreadable file aside without throwing.
 *
 * The quarantine copy can hold the credential JSON, so it is tightened to
 * `0600` on both paths: `renameSync` preserves the mode of the source file
 * (which a foreign writer may have created loosely) and `copyFileSync` creates
 * the copy with the process umask.
 *
 * @param {string} filePath - absolute path of the unreadable file.
 * @returns {void}
 */
function quarantine(filePath) {
  const backup = `${filePath}.corrupt-${Date.now()}`
  try {
    renameSync(filePath, backup)
    chmodSync(backup, FILE_MODE)
    return
  } catch {
    /* fall through: rename can fail across odd filesystems or permissions */
  }
  try {
    copyFileSync(filePath, backup)
    chmodSync(backup, FILE_MODE)
  } catch {
    /* best effort: the caller still starts from an empty in-memory store */
  }
}

/**
 * Create one atomically written JSON file handle.
 *
 * @param {{ dir: string, filename: string }} options - directory and file name.
 * @returns {{
 *   path: string,
 *   read: () => unknown,
 *   write: (value: unknown) => Promise<void>,
 *   update: (mutate: (current: unknown) => unknown | Promise<unknown>) => Promise<unknown>,
 * }} file handle.
 */
export function createJsonFile({ dir, filename } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createJsonFile: dir is required')
  if (typeof filename !== 'string' || filename.trim() === '') throw new TypeError('createJsonFile: filename is required')

  const filePath = path.join(path.resolve(dir), filename)
  const tmpPath = `${filePath}.tmp`
  /** @type {Promise<unknown>} tail of the serialized write chain. */
  let chain = Promise.resolve()

  /**
   * Read and parse the file synchronously. A missing file or invalid JSON
   * yields `undefined`; invalid JSON is quarantined first.
   * @returns {unknown} parsed JSON value or undefined.
   */
  function read() {
    let text
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') quarantine(filePath)
      return undefined
    }
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      quarantine(filePath)
      return undefined
    }
  }

  /**
   * Write one already-serialized text body atomically.
   *
   * The temporary file is created with the final mode up front, so the
   * credential-bearing body is never readable by other local users, not even
   * for the instant between creation and an after-the-fact `chmod`.
   *
   * @param {string} text - JSON text.
   * @returns {Promise<void>} resolves after the rename.
   */
  async function writeText(text) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE })
    const handle = await open(tmpPath, 'w', FILE_MODE)
    try {
      await handle.writeFile(text, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(tmpPath, filePath)
    await chmod(filePath, FILE_MODE).catch(() => {})
  }

  /**
   * Enqueue one task behind every earlier write/update.
   * @template T
   * @param {() => Promise<T>} task - task to run.
   * @returns {Promise<T>} task outcome.
   */
  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Write a value atomically.
   * @param {unknown} value - JSON-serializable value.
   * @returns {Promise<void>} resolves after the rename.
   */
  function write(value) {
    const raw = JSON.stringify(value, null, 2)
    if (typeof raw !== 'string') throw new TypeError('createJsonFile.write: value is not JSON-serializable')
    return enqueue(() => writeText(`${raw}\n`))
  }

  /**
   * Read the current value, await the mutation and write the result. Returning
   * `undefined` from `mutate` skips the write.
   * @param {(current: unknown) => unknown | Promise<unknown>} mutate - transformer.
   * @returns {Promise<unknown>} the mutation result.
   */
  function update(mutate) {
    return enqueue(async () => {
      const current = read()
      const next = await mutate(current)
      if (next !== undefined) {
        const text = `${JSON.stringify(next, null, 2)}\n`
        if (typeof text === 'string') await writeText(text)
      }
      return next
    })
  }

  return { path: filePath, read, write, update }
}
