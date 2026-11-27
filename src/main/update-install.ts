/**
 * Downloading a new version and putting it in place of the one that is running.
 *
 * A download is held to the size GitHub gave for it and to the SHA-256 sum the
 * release job published beside it, so a file that was cut short or damaged on
 * the way is never run. Both come from the same release, so this catches a bad
 * download, not a bad release; that takes signed installers (issue #7).
 *
 * How the new version is put in place depends on how this copy was installed:
 *
 * - Windows, by the installer: the new installer runs without showing anything.
 *   It finds the folder the app was installed to, waits for the app to close,
 *   replaces it, and starts it again when asked to.
 * - Linux, as an AppImage: the new AppImage takes the old one's place under the
 *   same name, so shortcuts to it keep working.
 *
 * Any other copy, macOS among them, gets the installer through the browser.
 * macOS only accepts an update for an app that is signed.
 *
 * Nothing here imports Electron, so it can be tested with made-up downloads.
 */
import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { REQUEST_HEADERS } from './updates'

/** The headers of the original check, asking for a file this time. They say nothing more about who is asking. */
export const DOWNLOAD_HEADERS = { ...REQUEST_HEADERS, Accept: 'application/octet-stream' }

/** The parts of an HTTP answer a download needs. */
export interface DownloadAnswer {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

export type DownloadFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<DownloadAnswer>

/** Something wrong with a download, said in words the person can act on. */
export class DownloadProblem extends Error {}

/**
 * The SHA-256 sum a `sha256sum` listing gives for one file, in lower case.
 * Null when the file is not listed.
 */
export function checksumFor(listing: string, name: string): string | null {
  for (const line of listing.split(/\r?\n/)) {
    // "<64 hex digits>  <name>", or with "*" in place of the second space for a file read as binary.
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trimEnd())
    if (match && match[2] === name) return match[1].toLowerCase()
  }
  return null
}

export interface DownloadRequest {
  name: string
  url: string
  /** In bytes, as GitHub gave it. */
  size: number
  /** Where the release's list of checksums is. */
  checksums: string
  /** The folder the installer is saved in. Whatever was left there before is removed first. */
  folder: string
  fetch: DownloadFetch
  /** Calls the download off. */
  signal: AbortSignal
  /** Told how many bytes have arrived so far. */
  onProgress(received: number): void
  /** How long the download may go without a byte arriving before it is given up. */
  stallAfter?: number
}

/** Rejects as soon as `signal` is aborted. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal.reason ?? new Error('Aborted'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

/**
 * Saves the installer in `folder` and gives back its path, once its size and
 * checksum are right. Rejects otherwise, with a `DownloadProblem` that says why
 * when the reason is known, and leaves nothing half-written behind.
 */
export async function downloadInstaller(request: DownloadRequest): Promise<string> {
  const { name, folder, fetch, onProgress } = request
  if (!isAbsolute(folder) || basename(name) !== name) throw new Error('The download has nowhere safe to go.')

  // Called off by the person, or given up because nothing arrived for too long.
  const stall = new AbortController()
  const stallAfter = request.stallAfter ?? 60_000
  let timer = setTimeout(() => stall.abort(), stallAfter)
  const signal = AbortSignal.any([request.signal, stall.signal])
  const stop = aborted(signal)
  // Losing the race to `stop` must not leave a rejection nobody handles.
  stop.catch(() => {})

  const problem = (message: string) => new DownloadProblem(message)

  const part = join(folder, `${name}.part`)
  try {
    const listing = await Promise.race([fetch(request.checksums, { headers: DOWNLOAD_HEADERS, signal }), stop])
    if (!listing.ok) {
      throw problem(`The release's checksums could not be downloaded. GitHub answered with an error (${listing.status}).`)
    }
    const expected = checksumFor(await Promise.race([listing.text(), stop]), name)
    if (!expected) throw problem(`The release lists no checksum for ${name}, so it cannot be checked.`)

    await rm(folder, { recursive: true, force: true })
    await mkdir(folder, { recursive: true })

    const answer = await Promise.race([fetch(request.url, { headers: DOWNLOAD_HEADERS, signal }), stop])
    if (!answer.ok || !answer.body) throw problem(`GitHub answered with an error (${answer.status}).`)

    const hash = createHash('sha256')
    const file = await open(part, 'w')
    const reader = answer.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stop])
        if (done) break
        clearTimeout(timer)
        timer = setTimeout(() => stall.abort(), stallAfter)
        received += value.byteLength
        if (received > request.size) throw problem(`The download is larger than GitHub said ${name} is.`)
        hash.update(value)
        for (let written = 0; written < value.byteLength; ) {
          written += (await file.write(value, written, value.byteLength - written)).bytesWritten
        }
        onProgress(received)
      }
    } finally {
      await file.close()
      void reader.cancel().catch(() => {})
    }

    if (received !== request.size) throw problem('The download ended before all of it arrived. Try again.')
    if (hash.digest('hex') !== expected) {
      throw problem(`${name} does not match the checksum published with the release, so it is not installed.`)
    }
    const saved = join(folder, name)
    await rename(part, saved)
    return saved
  } catch (error) {
    await rm(part, { force: true }).catch(() => {})
    if (!request.signal.aborted && stall.signal.aborted) {
      throw problem('The download stalled. Check your connection and try again.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Puts a downloaded version in place of this one. */
export interface Installer {
  /**
   * Called as the app quits. With `restart`, the new version is also started
   * once this one has gone. Resolves once that is under way.
   */
  install(file: string, restart: boolean): Promise<void>
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * The argument a new version is started with after an update. The Windows
 * installer passes it too. A copy started with it waits for the one it
 * replaces to finish closing, instead of handing over to it.
 */
export const UPDATED_ARGUMENT = '--updated'

/** Starts a program that outlives this one. Resolves once it is running, and rejects if it could not start. */
function launch(spawn: Spawn, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * The installer is told that this is an update (`--updated`), to show nothing
 * (`/S`), and to start the app when it is done (`--force-run`). It reads the
 * folder from the registry, so the app stays where the person put it.
 */
export function windowsInstaller(spawn: Spawn = spawnProcess): Installer {
  return {
    install: (file, restart) => launch(spawn, file, [UPDATED_ARGUMENT, '/S', ...(restart ? ['--force-run'] : [])]),
  }
}

/**
 * Replaces the AppImage at `target`. `args` are the ones this copy was started
 * with, which the new one is given too: `--no-sandbox`, say.
 */
export function appImageInstaller(target: string, args: string[], spawn: Spawn = spawnProcess): Installer {
  return {
    async install(file, restart) {
      // Copied next to the old one first, so that the swap is a single rename and cannot be left half done.
      const staging = join(dirname(target), `.${basename(target)}.update`)
      try {
        await copyFile(file, staging)
        await chmod(staging, 0o755)
        await rename(staging, target)
      } catch (error) {
        await rm(staging, { force: true }).catch(() => {})
        throw error
      }
      if (restart) {
        const kept = args.filter((arg) => arg !== UPDATED_ARGUMENT)
        await launch(spawn, target, [...kept, UPDATED_ARGUMENT], process.env)
      }
    },
  }
}

export interface ThisCopy {
  /** `app.getName()`: the product name, which the installer names the uninstaller after. */
  name: string
  platform: string
  /** False when running from source. */
  packaged: boolean
  /** `process.execPath`. */
  executable: string
  /** Set by the AppImage runtime to the AppImage's own path. */
  appImage: string | undefined
  /** The arguments this copy was started with, without the program. */
  args: string[]
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** How this copy of the app can be replaced by a newer one, or null when it has to be done by hand. */
export function installerFor(copy: ThisCopy): Installer | null {
  if (!copy.packaged) return null
  if (copy.platform === 'win32') {
    // Only a copy the installer put there can be updated by the next installer. One run
    // from an unpacked folder would get a second, separate installation instead.
    const uninstaller = join(dirname(copy.executable), `Uninstall ${copy.name}.exe`)
    return existsSync(uninstaller) ? windowsInstaller() : null
  }
  if (copy.platform === 'linux') {
    const target = copy.appImage
    // Replacing the file takes a new file in its folder.
    if (target && isAbsolute(target) && existsSync(target) && writable(dirname(target))) {
      return appImageInstaller(target, copy.args)
    }
  }
  return null
}
