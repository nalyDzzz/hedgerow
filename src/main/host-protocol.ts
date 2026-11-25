/**
 * Messages between the main process and the driver host (a utility process
 * that owns every database connection).
 */
import type {
  ConnectionParams,
  DriverId,
  EditRequest,
  ExecuteOptions,
  SaveResult,
  StatementResult,
  TableInfo,
  TableRef,
  TableView,
  ViewChange,
} from '@shared/driver'

export interface HostMethods {
  test(driver: DriverId, params: ConnectionParams): { serverVersion: string }
  open(driver: DriverId, params: ConnectionParams): {
    sessionId: string
    serverVersion: string
    database: string | null
  }
  close(sessionId: string): void
  /** Closes every session, which stops whatever each is running. */
  closeAll(): void
  /** False for a session that is gone or whose connection has failed. */
  usable(sessionId: string): boolean
  listDatabases(sessionId: string): string[]
  describeDatabase(sessionId: string, database: string): TableInfo[]
  setDatabase(sessionId: string, database: string): void
  execute(sessionId: string, sql: string, options: ExecuteOptions): StatementResult
  cancel(sessionId: string): void
  tableQuery(sessionId: string, table: TableRef, view?: TableView): string
  changeView(sessionId: string, view: TableView, change: ViewChange): TableView
  planEdits(sessionId: string, request: EditRequest): string[]
  applyEdits(sessionId: string, statements: string[]): SaveResult
}

export type HostMethod = keyof HostMethods

export interface HostRequest {
  id: number
  method: HostMethod
  args: unknown[]
}

export type HostResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } }
