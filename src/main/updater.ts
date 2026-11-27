/**
 * Keeps track of a new version from the moment a check finds it until it is
 * installed: the download, its progress, and what happens when the app closes.
 *
 * A downloaded version is installed as the app quits, after the database
 * sessions have been closed, so that the installer never cuts off a statement
 * that is still running. Restarting is quitting with the new version started
 * afterwards.
 *
 * The renderer only ever says "download what you found" and "restart": which
 * file is fetched and run is decided here, from the last check's answer.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AvailableUpdate, UpdateCheck, UpdateDownload } from '@shared/api'
import { downloadInstaller, DownloadProblem, type DownloadFetch, type Installer } from './update-install'
import { checkForUpdate, type CheckContext } from './updates'

export interface UpdaterContext {
  /** What the check needs, apart from whether this copy can install an update. */
  check: Omit<CheckContext, 'canInstall'>
  fetchFile: DownloadFetch
  /** How this copy is replaced, or null when it cannot replace itself. */
  installer: Installer | null
  /** Where downloads are kept until they are installed. */
  folder: string
  /** Starts closing the app. `finish` is called on the way out. */
  quit(): void
  /** How long a download may go without a byte arriving. */
  stallAfter?: number
}

export class Updater {
  private found: AvailableUpdate | null = null
  private state: UpdateDownload = { state: 'none' }
  /** The downloaded installer, once it has been checked. */
  private file: string | null = null
  private running: Promise<UpdateDownload> | null = null
  private abort: AbortController | null = null
  private restartAsked = false
  private finished = false

  constructor(private readonly context: UpdaterContext) {}

  async check(): Promise<UpdateCheck> {
    const answer = await checkForUpdate({ ...this.context.check, canInstall: this.context.installer !== null })
    // A failed check says nothing about what was found before.
    if (answer.status === 'available') this.found = answer.update
    if (answer.status === 'current') this.found = null
    return answer
  }

  progress(): UpdateDownload {
    return this.state
  }

  download(): Promise<UpdateDownload> {
    if (this.running) return this.running
    const update = this.found
    const download = update?.installable ? update.download : null
    if (!update || !download?.checksums || this.finished) return Promise.resolve(this.state)
    if (this.state.state === 'ready' && this.state.version === update.version) return Promise.resolve(this.state)

    const { version } = update
    const total = download.size
    const abort = new AbortController()
    this.abort = abort
    this.file = null
    this.state = { state: 'downloading', version, received: 0, total }

    this.running = downloadInstaller({
      ...download,
      checksums: download.checksums,
      folder: this.context.folder,
      fetch: this.context.fetchFile,
      signal: abort.signal,
      stallAfter: this.context.stallAfter,
      onProgress: (received) => {
        if (this.abort === abort) this.state = { state: 'downloading', version, received, total }
      },
    })
      .then((file): UpdateDownload => {
        this.file = file
        return { state: 'ready', version }
      })
      .catch((error: unknown): UpdateDownload => {
        if (abort.signal.aborted) return { state: 'none' }
        const message =
          error instanceof DownloadProblem
            ? error.message
            : `The download stopped: ${(error as Error)?.message || 'something went wrong.'}`
        return { state: 'failed', version, message }
      })
      .then((state) => {
        this.state = state
        this.running = null
        this.abort = null
        return state
      })
    return this.running
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** Closes the app so that the downloaded version is installed and started. */
  restart(): UpdateDownload {
    if (this.state.state !== 'ready' || !this.file) return this.state
    if (!existsSync(this.file)) {
      this.file = null
      this.state = {
        state: 'failed',
        version: this.state.version,
        message: 'The downloaded update has gone missing. Download it again.',
      }
      return this.state
    }
    this.restartAsked = true
    this.context.quit()
    return this.state
  }

  /**
   * Called once as the app quits, after its sessions have been closed. Installs a
   * downloaded version, and starts it afterwards if a restart was asked for. A
   * download still under way is dropped.
   */
  async finish(): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.abort?.abort()
    if (this.state.state !== 'ready' || !this.file || !this.context.installer) return
    try {
      await this.context.installer.install(this.file, this.restartAsked)
    } catch (error) {
      // The app is closing either way. This version stays, and offers the update again next time.
      console.error('The update could not be installed:', error)
    }
  }

  /** Removes what earlier downloads left behind. An installer that is still running is left alone. */
  async clearDownloads(): Promise<void> {
    if (this.running || this.file || !isAbsolute(this.context.folder)) return
    await rm(this.context.folder, { recursive: true, force: true }).catch(() => {})
  }
}
