/** Following a new version from the check to the install, with a made-up GitHub and installer. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadAnswer, DownloadFetch, Installer } from './update-install'
import { Updater, type UpdaterContext } from './updater'

const DOWNLOADS = 'https://github.com/nalyDzzz/hedgerow/releases/download/v0.4.0'
const NAME = 'Hedgerow-0.4.0-win-x64.exe'
const CONTENT = new TextEncoder().encode('the next version')
const SUM = createHash('sha256').update(CONTENT).digest('hex')

const RELEASE = {
  tag_name: 'v0.4.0',
  html_url: 'https://github.com/nalyDzzz/hedgerow/releases/tag/v0.4.0',
  body: 'Hedgerow 0.4.0.',
  assets: [
    { name: NAME, size: CONTENT.byteLength, browser_download_url: `${DOWNLOADS}/${NAME}` },
    { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${DOWNLOADS}/SHA256SUMS.txt` },
  ],
}

let folder: string
beforeEach(() => {
  folder = join(mkdtempSync(join(tmpdir(), 'hedgerow-updater-test-')), 'hedgerow-updater')
})
afterEach(() => {
  rmSync(join(folder, '..'), { recursive: true, force: true })
})

interface Setup {
  /** Holds the file back until called. */
  gate?: Promise<void>
  sum?: string
  installer?: Installer | null
}

function setup({ gate, sum = SUM, installer }: Setup = {}) {
  const installs: { file: string; restart: boolean }[] = []
  let quits = 0
  const fetchFile: DownloadFetch = async (url, init) => {
    if (url.endsWith('SHA256SUMS.txt')) {
      return { ok: true, status: 200, body: null, text: async () => `${sum}  ${NAME}\n` }
    }
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason))
        await gate
        controller.enqueue(CONTENT)
        controller.close()
      },
    })
    return { ok: true, status: 200, body, text: async () => '' } satisfies DownloadAnswer
  }
  const context: UpdaterContext = {
    check: {
      fetch: async () => ({ ok: true, status: 200, json: async () => RELEASE }),
      current: '0.3.1',
      platform: 'win32',
      arch: 'x64',
    },
    fetchFile,
    installer:
      installer === undefined
        ? { install: async (file, restart) => void installs.push({ file, restart }) }
        : installer,
    folder,
    quit: () => quits++,
  }
  return { updater: new Updater(context), installs, quits: () => quits }
}

describe('updating', () => {
  it('downloads what the check found, and installs it on the way out when asked to restart', async () => {
    const { updater, installs, quits } = setup()
    const check = await updater.check()
    expect(check).toMatchObject({ status: 'available', update: { version: '0.4.0', installable: true } })

    expect(await updater.download()).toEqual({ state: 'ready', version: '0.4.0' })
    expect(updater.progress()).toEqual({ state: 'ready', version: '0.4.0' })

    expect(updater.restart()).toEqual({ state: 'ready', version: '0.4.0' })
    expect(quits()).toBe(1)
    // Nothing is run until the app is on its way out.
    expect(installs).toEqual([])
    await updater.finish()
    expect(installs).toEqual([{ file: join(folder, NAME), restart: true }])
  })

  it('installs a downloaded version when the app is closed instead, without starting it', async () => {
    const { updater, installs, quits } = setup()
    await updater.check()
    await updater.download()
    await updater.finish()
    await updater.finish()
    expect(installs).toEqual([{ file: join(folder, NAME), restart: false }])
    expect(quits()).toBe(0)
  })

  it('says how far a download has got while it runs', async () => {
    let release = () => {}
    const { updater } = setup({ gate: new Promise((resolve) => (release = resolve)) })
    await updater.check()
    const download = updater.download()
    expect(updater.progress()).toEqual({ state: 'downloading', version: '0.4.0', received: 0, total: CONTENT.byteLength })
    // Asking again while it runs follows the same download.
    expect(updater.download()).toBe(download)
    release()
    expect(await download).toEqual({ state: 'ready', version: '0.4.0' })
  })

  it('goes back to nothing when the download is called off, and installs nothing', async () => {
    const { updater, installs } = setup({ gate: new Promise(() => {}) })
    await updater.check()
    const download = updater.download()
    updater.cancel()
    expect(await download).toEqual({ state: 'none' })
    await updater.finish()
    expect(installs).toEqual([])
  })

  it('says why a download failed, and offers no restart for it', async () => {
    const { updater, quits } = setup({ sum: '0'.repeat(64) })
    await updater.check()
    expect(await updater.download()).toEqual({
      state: 'failed',
      version: '0.4.0',
      message: `${NAME} does not match the checksum published with the release, so it is not installed.`,
    })
    expect(updater.restart()).toMatchObject({ state: 'failed' })
    expect(quits()).toBe(0)
  })

  it('downloads nothing for a copy that cannot install it, or before anything was found', async () => {
    const unable = setup({ installer: null })
    expect(await unable.updater.download()).toEqual({ state: 'none' })
    await unable.updater.check()
    expect(await unable.updater.download()).toEqual({ state: 'none' })
  })

  it('does not restart when the download has gone missing', async () => {
    const { updater, quits } = setup()
    await updater.check()
    await updater.download()
    rmSync(folder, { recursive: true, force: true })
    expect(updater.restart()).toMatchObject({ state: 'failed', message: /gone missing/ })
    expect(quits()).toBe(0)
  })

  it('drops a download that is still running when the app closes', async () => {
    const { updater, installs } = setup({ gate: new Promise(() => {}) })
    await updater.check()
    const download = updater.download()
    await updater.finish()
    expect(await download).toEqual({ state: 'none' })
    expect(installs).toEqual([])
  })

  it('closes regardless when the installer cannot be started', async () => {
    const { updater } = setup({
      installer: {
        install: async () => {
          throw new Error('spawn EACCES')
        },
      },
    })
    await updater.check()
    await updater.download()
    const logged = console.error
    console.error = () => {}
    try {
      await expect(updater.finish()).resolves.toBeUndefined()
    } finally {
      console.error = logged
    }
  })
})
