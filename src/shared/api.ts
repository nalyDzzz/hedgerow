/**
 * The API the renderer sees as `window.api`. The preload script implements it
 * by forwarding each call to the main process.
 */
import type {
  DriverId,
  ExecuteOptions,
  StatementResult,
  TableInfo,
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
  'window:setTheme',
] as const satisfies readonly ApiChannel[]
