import { create } from 'zustand'
import type { AvailableUpdate } from '@shared/api'

const api = window.api

/** Set to "off" when the person does not want the app to look by itself. */
const AUTOMATIC_KEY = 'updateCheck'
/** A version the person asked not to be told about again. */
const SKIPPED_KEY = 'skippedVersion'
/** A moment after the window opens, so the check does not compete with starting up. */
const FIRST_CHECK_AFTER = 4_000
const CHECK_EVERY = 4 * 60 * 60 * 1000

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

  /** Call once when the app starts. */
  start(): void
  check(): Promise<void>
  setAutomatic(automatic: boolean): void
  /** Stops the notice for one version. A later version is announced again. */
  skip(version: string): void
  setDialogOpen(open: boolean): void
}

let firstCheck: ReturnType<typeof setTimeout> | undefined
let laterChecks: ReturnType<typeof setInterval> | undefined

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

    start() {
      void api.updates.current().then((version) => set({ version }))
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
  }
})

/** The release to tell the person about: a newer one they have not asked to skip. */
export function useAnnouncedUpdate(): AvailableUpdate | null {
  return useUpdates((state) => (state.available && state.available.version !== state.skipped ? state.available : null))
}
