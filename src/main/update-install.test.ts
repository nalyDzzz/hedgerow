/** Downloading and installing an update, against made-up downloads and programs. Nothing here touches the network. */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appImageInstaller,
  checksumFor,
  DOWNLOAD_HEADERS,
  downloadInstaller,
  DownloadProblem,
  installerFor,
  windowsInstaller,
  type DownloadAnswer,
  type DownloadFetch,
  type DownloadRequest,
} from './update-install'

const NAME = 'Hedgerow-0.4.0-win-x64.exe'
const FILE_URL = `https://github.com/nalyDzzz/hedgerow/releases/download/v0.4.0/${NAME}`
const CHECKSUMS_URL = 'https://github.com/nalyDzzz/hedgerow/releases/download/v0.4.0/SHA256SUMS.txt'
const CONTENT = new Uint8Array(10_000).map((_, index) => index % 251)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function listing(name = NAME, sum = sha256(CONTENT)): string {
  return `${'0'.repeat(64)}  Hedgerow-0.4.0-linux-x86_64.AppImage\n${sum}  ${name}\n`
}

/** A body that hands out `bytes` in pieces, and stops when the request is called off. */
function body(bytes: Uint8Array, signal: AbortSignal, pieces = 4, hang = false): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.byteLength / pieces)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        if (hang) return new Promise(() => {})
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason))
    },
  })
}

interface Served {
  checksums?: string | number
  file?: Uint8Array | number
  hang?: boolean
}

/** A server that knows two addresses, and records what it was asked. */
function serving(served: Served = {}) {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const fetch: DownloadFetch = async (url, init) => {
    asked.push({ url, headers: init.headers })
    const failed = (status: number): DownloadAnswer => ({ ok: false, status, body: null, text: async () => '' })
    if (url === CHECKSUMS_URL) {
      const checksums = served.checksums ?? listing()
      if (typeof checksums === 'number') return failed(checksums)
      return { ok: true, status: 200, body: null, text: async () => checksums }
    }
    if (url === FILE_URL) {
      const file = served.file ?? CONTENT
      if (typeof file === 'number') return failed(file)
      return { ok: true, status: 200, body: body(file, init.signal, 4, served.hang), text: async () => '' }
    }
    return failed(404)
  }
  return { fetch, asked }
}

let folder: string
let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hedgerow-update-test-'))
  folder = join(scratch, 'hedgerow-updater')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function request(over: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    name: NAME,
    url: FILE_URL,
    size: CONTENT.byteLength,
    checksums: CHECKSUMS_URL,
    folder,
    fetch: serving().fetch,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...over,
  }
}

describe('reading the list of checksums', () => {
  it('finds the line for one file', () => {
    const sum = 'A'.repeat(64)
    expect(checksumFor(`${'b'.repeat(64)}  other.exe\r\n${sum}  ${NAME}\r\n`, NAME)).toBe('a'.repeat(64))
    // sha256sum marks a file it read as binary with an asterisk.
    expect(checksumFor(`${sum} *${NAME}`, NAME)).toBe('a'.repeat(64))
  })

  it('finds nothing for a file that is not listed, or a line that is not a checksum', () => {
    expect(checksumFor(listing(), 'Hedgerow-0.4.0-mac-arm64.dmg')).toBeNull()
    expect(checksumFor(`abc  ${NAME}`, NAME)).toBeNull()
    expect(checksumFor(`${'a'.repeat(64)}  ${NAME}.old`, NAME)).toBeNull()
    expect(checksumFor('', NAME)).toBeNull()
  })
})

describe('downloading an installer', () => {
  it('saves it once its size and checksum are right, and says how far it has got', async () => {
    const { fetch, asked } = serving()
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Hedgerow-0.3.9-win-x64.exe'), 'an older download')
    const progress: number[] = []

    const saved = await downloadInstaller(request({ fetch, onProgress: (received) => progress.push(received) }))

    expect(saved).toBe(join(folder, NAME))
    expect(new Uint8Array(readFileSync(saved))).toEqual(CONTENT)
    // What was left from before is gone, and so is the file it was written to on the way.
    expect(readdirSync(folder)).toEqual([NAME])
    expect(progress).toEqual([2500, 5000, 7500, 10_000])
    // The list of checksums first, and nothing about who is asking but the app's name.
    expect(asked).toEqual([
      { url: CHECKSUMS_URL, headers: DOWNLOAD_HEADERS },
      { url: FILE_URL, headers: DOWNLOAD_HEADERS },
    ])
    expect(DOWNLOAD_HEADERS).toEqual({ Accept: 'application/octet-stream', 'Accept-Language': 'en', 'User-Agent': 'Hedgerow' })
  })

  it('refuses a file that does not match its checksum, and leaves nothing behind', async () => {
    const damaged = CONTENT.slice()
    damaged[5000] ^= 1
    const download = downloadInstaller(request({ fetch: serving({ file: damaged }).fetch }))
    await expect(download).rejects.toThrow(DownloadProblem)
    await expect(download).rejects.toThrow(/does not match the checksum/)
    expect(readdirSync(folder)).toEqual([])
  })

  it('refuses a file that is shorter or longer than GitHub said', async () => {
    await expect(downloadInstaller(request({ fetch: serving({ file: CONTENT.slice(0, 9000) }).fetch }))).rejects.toThrow(
      /ended before all of it arrived/,
    )
    const longer = new Uint8Array(12_000)
    await expect(downloadInstaller(request({ fetch: serving({ file: longer }).fetch }))).rejects.toThrow(/larger than/)
    expect(readdirSync(folder)).toEqual([])
  })

  it('does not start without a checksum to hold the file to', async () => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'kept'), '')
    await expect(downloadInstaller(request({ fetch: serving({ checksums: listing('another.exe') }).fetch }))).rejects.toThrow(
      /lists no checksum for Hedgerow-0.4.0-win-x64.exe/,
    )
    await expect(downloadInstaller(request({ fetch: serving({ checksums: 404 }).fetch }))).rejects.toThrow(
      /checksums could not be downloaded.*\(404\)/,
    )
    // Nothing was touched.
    expect(readdirSync(folder)).toEqual(['kept'])
  })

  it('says what GitHub answered when the file cannot be had', async () => {
    await expect(downloadInstaller(request({ fetch: serving({ file: 503 }).fetch }))).rejects.toThrow(/error \(503\)/)
  })

  it('stops when it is called off', async () => {
    const abort = new AbortController()
    const download = downloadInstaller(
      request({
        fetch: serving({ hang: true, file: CONTENT.slice(0, 5000) }).fetch,
        signal: abort.signal,
        size: CONTENT.byteLength,
        onProgress: (received) => received >= 5000 && abort.abort(),
      }),
    )
    await expect(download).rejects.not.toBeInstanceOf(DownloadProblem)
    expect(readdirSync(folder)).toEqual([])
  })

  it('gives up when nothing arrives for too long', async () => {
    const download = downloadInstaller(
      request({ fetch: serving({ hang: true, file: CONTENT.slice(0, 5000) }).fetch, stallAfter: 50 }),
    )
    await expect(download).rejects.toThrow(/stalled/)
    expect(readdirSync(folder)).toEqual([])
  })

  it('will only write into a folder it was given in full', async () => {
    await expect(downloadInstaller(request({ folder: 'hedgerow-updater' }))).rejects.toThrow(/nowhere safe/)
    await expect(downloadInstaller(request({ name: '../Hedgerow.exe' }))).rejects.toThrow(/nowhere safe/)
  })
})

/** A stand-in for `child_process.spawn` that records what it was asked to start. */
function spawner(fails = false) {
  const started: { command: string; args: string[]; detached?: boolean }[] = []
  const spawn = (command: string, args: string[], options: { detached?: boolean }) => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} })
    started.push({ command, args, detached: options.detached })
    queueMicrotask(() => (fails ? child.emit('error', new Error('spawn EACCES')) : child.emit('spawn')))
    return child as unknown as ChildProcess
  }
  return { spawn, started }
}

describe('installing on Windows', () => {
  it('runs the installer as an update, silently, and starts the app after it when restarting', async () => {
    const { spawn, started } = spawner()
    await windowsInstaller(spawn).install('C:\\cache\\Hedgerow-0.4.0-win-x64.exe', true)
    await windowsInstaller(spawn).install('C:\\cache\\Hedgerow-0.4.0-win-x64.exe', false)
    expect(started).toEqual([
      { command: 'C:\\cache\\Hedgerow-0.4.0-win-x64.exe', args: ['--updated', '/S', '--force-run'], detached: true },
      { command: 'C:\\cache\\Hedgerow-0.4.0-win-x64.exe', args: ['--updated', '/S'], detached: true },
    ])
  })

  it('says so when the installer cannot be started', async () => {
    await expect(windowsInstaller(spawner(true).spawn).install('C:\\cache\\x.exe', true)).rejects.toThrow(/EACCES/)
  })
})

describe('installing an AppImage', () => {
  it('puts the new file in place of the old one, under the same name', async () => {
    const target = join(scratch, 'Hedgerow-0.3.1-linux-x86_64.AppImage')
    const downloaded = join(scratch, 'new.AppImage')
    writeFileSync(target, 'old version')
    writeFileSync(downloaded, 'new version')
    const { spawn, started } = spawner()

    await appImageInstaller(target, ['--no-sandbox'], spawn).install(downloaded, false)

    expect(readFileSync(target, 'utf8')).toBe('new version')
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o111).toBe(0o111)
    expect(readdirSync(scratch).sort()).toEqual(['Hedgerow-0.3.1-linux-x86_64.AppImage', 'new.AppImage'])
    // Closing, not restarting: nothing is started.
    expect(started).toEqual([])
  })

  it('starts the new file with the arguments this copy had, when restarting', async () => {
    const target = join(scratch, 'Hedgerow.AppImage')
    writeFileSync(target, 'old')
    writeFileSync(join(scratch, 'new'), 'new')
    const { spawn, started } = spawner()
    await appImageInstaller(target, ['--no-sandbox', '--updated'], spawn).install(join(scratch, 'new'), true)
    expect(started).toEqual([{ command: target, args: ['--no-sandbox', '--updated'], detached: true }])
  })

  it('leaves the old file alone when the new one cannot be copied', async () => {
    const target = join(scratch, 'Hedgerow.AppImage')
    writeFileSync(target, 'old')
    await expect(appImageInstaller(target, [], spawner().spawn).install(join(scratch, 'missing'), true)).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(scratch)).toEqual(['Hedgerow.AppImage'])
  })
})

describe('telling how this copy can be updated', () => {
  const copy = { name: 'Hedgerow', platform: 'win32', packaged: true, executable: '', appImage: undefined, args: [] }

  it('updates a Windows copy only when the installer put it there', () => {
    const installed = join(scratch, 'Programs', 'Hedgerow')
    mkdirSync(installed, { recursive: true })
    const executable = join(installed, 'Hedgerow.exe')
    expect(installerFor({ ...copy, executable })).toBeNull()
    writeFileSync(join(installed, 'Uninstall Hedgerow.exe'), '')
    expect(installerFor({ ...copy, executable })).not.toBeNull()
    expect(installerFor({ ...copy, executable, packaged: false })).toBeNull()
  })

  it('updates a Linux copy only when it is an AppImage', () => {
    const appImage = join(scratch, 'Hedgerow.AppImage')
    writeFileSync(appImage, '')
    expect(installerFor({ ...copy, platform: 'linux', appImage })).not.toBeNull()
    expect(installerFor({ ...copy, platform: 'linux', appImage: undefined })).toBeNull()
    expect(installerFor({ ...copy, platform: 'linux', appImage: 'Hedgerow.AppImage' })).toBeNull()
    expect(installerFor({ ...copy, platform: 'linux', appImage: join(scratch, 'gone.AppImage') })).toBeNull()
  })

  it('leaves macOS to the browser', () => {
    const executable = '/Applications/Hedgerow.app/Contents/MacOS/Hedgerow'
    expect(installerFor({ ...copy, platform: 'darwin', executable })).toBeNull()
  })
})
