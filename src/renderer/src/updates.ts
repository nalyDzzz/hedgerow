import { create } from 'zustand'
import type { AvailableUpdate, UpdateDownload } from '@shared/api'

const api = window.api

/** Set to "off" when the person does not want the app to look by itself. */
const AUTOMATIC_KEY = 'updateCheck'
/** A version the person asked not to be told about again. */
const SKIPPED_KEY = 'skippedVersion'
/** A moment after the window opens, so the check does not compete with starting up. */
const FIRST_CHECK_AFTER = 4_000
const CHECK_EVERY = 4 * 60 * 60 * 1000
/** How often the progress of a download is asked for. */
const PROGRESS_EVERY = 250

interface UpdatesState {
  /** The version that is running. Null until the main process has said. */
  version: string | null
  /** Whether the app looks for a new version by itself. Asking by hand always works. */
  automatic: boolean
  checking: boolean
  /** True once a check has been answered, so "this is the latest" is only said when it is known. */
  checked: boolean
  /** The newer release, when there is one. */
  available: AvailableUpdate | null
  /** Why the last check could not be made, when it could not. */
  problem: string | null
  skipped: string | null
  dialogOpen: boolean
  /** How far downloading a new version has got. The main process keeps the real state. */
  download: UpdateDownload

  /** Call once when the app starts. */
  start(): void
  check(): Promise<void>
  setAutomatic(automatic: boolean): void
  /** Stops the notice for one version. A later version is announced again. */
  skip(version: string): void
  setDialogOpen(open: boolean): void
  /** Downloads the version that was found, when the app can install it by itself. */
  startDownload(): Promise<void>
  cancelDownload(): void
  /** Closes the app, installs the downloaded version and starts it. */
  restart(): Promise<void>
}

let firstCheck: ReturnType<typeof setTimeout> | undefined
let laterChecks: ReturnType<typeof setInterval> | undefined
let watchingDownload: ReturnType<typeof setInterval> | undefined

export const useUpdates = create<UpdatesState>()((set, get) => {
  /**
   * Makes the app look by itself, or stop, to match the setting. Everything
   * that was waiting to run is dropped first, so switching the setting off
   * also calls off a check that was about to be made.
   */
  const schedule = (startingUp: boolean) => {
    clearTimeout(firstCheck)
    clearInterval(laterChecks)
    if (!get().automatic) return
    if (startingUp) firstCheck = setTimeout(() => void get().check(), FIRST_CHECK_AFTER)
    laterChecks = setInterval(() => void get().check(), CHECK_EVERY)
  }

  return {
    version: null,
    automatic: localStorage.getItem(AUTOMATIC_KEY) !== 'off',
    checking: false,
    checked: false,
    available: null,
    problem: null,
    skipped: localStorage.getItem(SKIPPED_KEY),
    dialogOpen: false,
    download: { state: 'none' },

    start() {
      void api.updates.current().then((version) => set({ version }))
      // The window may have been reloaded while the main process went on downloading.
      void api.updates.downloadState().then((download) => {
        set({ download })
        if (download.state === 'downloading') void get().startDownload()
      })
      schedule(true)
    },

    async check() {
      if (get().checking) return
      set({ checking: true })
      const answer = await api.updates.check()
      if (answer.status === 'failed') {
        // A release found earlier is still there, whatever went wrong this time.
        set({ checking: false, version: answer.current, problem: answer.message })
      } else {
        set({
          checking: false,
          checked: true,
          version: answer.current,
          problem: null,
          available: answer.status === 'available' ? answer.update : null,
        })
      }
    },

    setAutomatic(automatic) {
      if (automatic) localStorage.removeItem(AUTOMATIC_KEY)
      else localStorage.setItem(AUTOMATIC_KEY, 'off')
      set({ automatic })
      schedule(false)
    },

    skip(version) {
      localStorage.setItem(SKIPPED_KEY, version)
      set({ skipped: version })
    },

    setDialogOpen(open) {
      set({ dialogOpen: open })
    },

    async startDownload() {
      const { available, download } = get()
      let version: string
      if (download.state === 'downloading') {
        // Only following one that is already under way.
        version = download.version
      } else {
        if (!available?.installable || !available.download) return
        version = available.version
        set({ download: { state: 'downloading', version, received: 0, total: available.download.size } })
      }
      clearInterval(watchingDownload)
      watchingDownload = setInterval(() => {
        void api.updates.downloadState().then((latest) => {
          // The last word comes from the download itself, and an answer that arrives after it is old.
          if (latest.state === 'downloading' && get().download.state === 'downloading') set({ download: latest })
        })
      }, PROGRESS_EVERY)
      try {
        set({ download: await api.updates.download() })
      } catch (error) {
        set({ download: { state: 'failed', version, message: (error as Error).message } })
      } finally {
        clearInterval(watchingDownload)
      }
    },

    cancelDownload() {
      void api.updates.cancelDownload()
    },

    async restart() {
      // When this works the app closes, and nothing after it runs.
      set({ download: await api.updates.restart() })
    },
  }
})

const NO_DOWNLOAD: UpdateDownload = { state: 'none' }

/** The download that belongs to the release that was found, if one has been started. */
export function downloadFor(available: AvailableUpdate | null, download: UpdateDownload): UpdateDownload {
  // The same object every time, so that a selector returning it does not count as a change.
  return available && download.state !== 'none' && download.version === available.version ? download : NO_DOWNLOAD
}

/**
 * The release to tell the person about: a newer one they have not asked to skip,
 * or one they have started downloading anyway.
 */
export function useAnnouncedUpdate(): AvailableUpdate | null {
  return useUpdates((state) => {
    const { available } = state
    if (!available) return null
    const started = downloadFor(available, state.download).state !== 'none'
    return available.version !== state.skipped || started ? available : null
  })
}

/** The download of the release that was found. */
export function useUpdateDownload(): UpdateDownload {
  return useUpdates((state) => downloadFor(state.available, state.download))
}
