/**
 * The API the renderer sees as `window.api`. The preload script implements it
 * by forwarding each call to the main process.
 */
import type {
  DriverId,
  EditRequest,
  ExecuteOptions,
  SaveResult,
  StatementResult,
  TableInfo,
  TableRef,
  TableView,
  TlsMode,
  ViewChange,
} from './driver'

/** Hue (0-360) that tints the workspace while this connection is active. */
export type ConnectionHue = number

/** A saved connection as the UI sees it. The password never leaves the main process. */
export interface SavedConnection {
  id: string
  name: string
  driver: DriverId
  host: string
  port: number
  user: string
  database: string
  tls: TlsMode
  /** The certificate authorities to trust when the server is verified, as PEM text. Empty for the public ones. */
  ca: string
  hue: ConnectionHue
  hasPassword: boolean
}

export interface ConnectionInput {
  /** Omit to create a new connection. */
  id?: string
  name: string
  driver: DriverId
  host: string
  port: number
  user: string
  /** `undefined` keeps the stored password when editing. */
  password?: string
  database: string
  tls: TlsMode
  /** As in `SavedConnection`. Left out, it is empty. */
  ca?: string
  hue: ConnectionHue
}

/** A certificate file that was chosen, or why it cannot be used. Null when no file was chosen. */
export type ChosenCertificate = { name: string; ca: string } | { problem: string } | null

export type TestResult = { ok: true; serverVersion: string } | { ok: false; message: string }

export interface SessionInfo {
  sessionId: string
  serverVersion: string
  database: string | null
  /** Whether the session reads a backslash in a string as an escape. See `DriverSession.backslashEscapes`. */
  backslashEscapes: boolean
}

export type ThemeMode = 'system' | 'light' | 'dark'

/** A release that is newer than the app that is running. */
export interface AvailableUpdate {
  /** Its version, such as `0.3.0`. */
  version: string
  /** The opening lines of its release notes, as plain text. Empty when it has none. */
  summary: string
  /** When it came out, as an ISO date. */
  publishedAt: string | null
  /** The page that describes it. */
  releaseUrl: string
  /**
   * The installer for this system, when the release has one. `size` is in bytes, and
   * `checksums` is the release's list of SHA-256 sums, when it has one.
   */
  download: { name: string; url: string; size: number; checksums: string | null } | null
  /**
   * True when the app can download this release and install it by itself. Otherwise
   * the installer is handed to the browser, as on macOS until the app is signed.
   */
  installable: boolean
}

/** The answer to "is there a newer version?". `current` is the version that is running. */
export type UpdateCheck =
  | { status: 'current'; current: string }
  | { status: 'available'; current: string; update: AvailableUpdate }
  | { status: 'failed'; current: string; message: string }

/** How far the app has got with downloading a new version. `received` and `total` are bytes. */
export type UpdateDownload =
  | { state: 'none' }
  | { state: 'downloading'; version: string; received: number; total: number }
  /** Downloaded and checked. It is installed when the app restarts or closes. */
  | { state: 'ready'; version: string }
  | { state: 'failed'; version: string; message: string }

export interface AppApi {
  platform: 'win32' | 'darwin' | 'linux' | string
  connections: {
    list(): Promise<SavedConnection[]>
    save(input: ConnectionInput): Promise<SavedConnection>
    remove(id: string): Promise<void>
    test(input: ConnectionInput): Promise<TestResult>
    /** Asks for a file of certificate authorities and reads the certificates in it. */
    chooseCertificate(): Promise<ChosenCertificate>
  }
  sessions: {
    open(connectionId: string, database?: string): Promise<SessionInfo>
    /** Ends the session. A statement it is running is stopped first. */
    close(sessionId: string): Promise<void>
    /** False once the session's connection has failed. A new one has to be opened to carry on. */
    usable(sessionId: string): Promise<boolean>
    listDatabases(sessionId: string): Promise<string[]>
    describeDatabase(sessionId: string, database: string): Promise<TableInfo[]>
    setDatabase(sessionId: string, database: string): Promise<void>
    execute(sessionId: string, sql: string, options: ExecuteOptions): Promise<StatementResult>
    cancel(sessionId: string): Promise<void>
    /** The statement that shows a table's rows, or the rows a view keeps, written by the driver. */
    tableQuery(sessionId: string, table: TableRef, view?: TableView): Promise<string>
    /** A view after one change asked for in the grid, with the name and value written by the driver. Nothing is run. */
    changeView(sessionId: string, view: TableView, change: ViewChange): Promise<TableView>
    /** The statements that would make these changes. Nothing is run. */
    planEdits(sessionId: string, request: EditRequest): Promise<string[]>
    /** Runs planned statements in one transaction that commits only if each changes exactly one row. */
    applyEdits(sessionId: string, statements: string[]): Promise<SaveResult>
  }
  updates: {
    /** The version that is running. */
    current(): Promise<string>
    /** Asks GitHub for the latest release. Sends nothing else, and never rejects. */
    check(): Promise<UpdateCheck>
    /**
     * Downloads the release the last check found, when it is installable, and checks
     * it against the release's checksums. Resolves once that is done, has failed or
     * was called off, and never rejects.
     */
    download(): Promise<UpdateDownload>
    /** Calls off a download that is under way. */
    cancelDownload(): Promise<void>
    /** How far the download has got. */
    downloadState(): Promise<UpdateDownload>
    /** Closes the app, installs the downloaded version and starts it. */
    restart(): Promise<UpdateDownload>
  }
  window: {
    /** Keeps native window chrome in step with the app theme. */
    setTheme(mode: ThemeMode, titleBar: { background: string; symbols: string }): Promise<void>
  }
}

/** Every call crosses IPC wrapped in this envelope so errors arrive intact. */
export type IpcEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } }

/** `connections.list` -> `"connections:list"` */
export type ApiChannel = {
  [G in keyof AppApi]: AppApi[G] extends object
    ? { [M in keyof AppApi[G]]: `${G & string}:${M & string}` }[keyof AppApi[G]]
    : never
}[keyof AppApi]

export const API_CHANNELS = [
  'connections:list',
  'connections:save',
  'connections:remove',
  'connections:test',
  'connections:chooseCertificate',
  'sessions:open',
  'sessions:close',
  'sessions:usable',
  'sessions:listDatabases',
  'sessions:describeDatabase',
  'sessions:setDatabase',
  'sessions:execute',
  'sessions:cancel',
  'sessions:tableQuery',
  'sessions:changeView',
  'sessions:planEdits',
  'sessions:applyEdits',
  'updates:current',
  'updates:check',
  'updates:download',
  'updates:cancelDownload',
  'updates:downloadState',
  'updates:restart',
  'window:setTheme',
] as const satisfies readonly ApiChannel[]
