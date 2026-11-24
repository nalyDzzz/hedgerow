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
  TlsMode,
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
  hue: ConnectionHue
}

export type TestResult = { ok: true; serverVersion: string } | { ok: false; message: string }

export interface SessionInfo {
  sessionId: string
  serverVersion: string
  database: string | null
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
  /** The installer for this system, when the release has one. */
  download: { name: string; url: string } | null
}

/** The answer to "is there a newer version?". `current` is the version that is running. */
export type UpdateCheck =
  | { status: 'current'; current: string }
  | { status: 'available'; current: string; update: AvailableUpdate }
  | { status: 'failed'; current: string; message: string }

export interface AppApi {
  platform: 'win32' | 'darwin' | 'linux' | string
  connections: {
    list(): Promise<SavedConnection[]>
    save(input: ConnectionInput): Promise<SavedConnection>
    remove(id: string): Promise<void>
    test(input: ConnectionInput): Promise<TestResult>
  }
  sessions: {
    open(connectionId: string, database?: string): Promise<SessionInfo>
    close(sessionId: string): Promise<void>
    listDatabases(sessionId: string): Promise<string[]>
    describeDatabase(sessionId: string, database: string): Promise<TableInfo[]>
    setDatabase(sessionId: string, database: string): Promise<void>
    execute(sessionId: string, sql: string, options: ExecuteOptions): Promise<StatementResult>
    cancel(sessionId: string): Promise<void>
    /** The statement that shows a table's rows, written by the driver. */
    tableQuery(sessionId: string, table: TableRef): Promise<string>
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
  'sessions:open',
  'sessions:close',
  'sessions:listDatabases',
  'sessions:describeDatabase',
  'sessions:setDatabase',
  'sessions:execute',
  'sessions:cancel',
  'sessions:tableQuery',
  'sessions:planEdits',
  'sessions:applyEdits',
  'updates:current',
  'updates:check',
  'window:setTheme',
] as const satisfies readonly ApiChannel[]
