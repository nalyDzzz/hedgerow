/**
 * Messages between the main process and the driver host (a utility process
 * that owns every database connection).
 */
import type {
  ConnectionParams,
  DriverId,
  ExecuteOptions,
  StatementResult,
  TableInfo,
} from '@shared/driver'

export interface HostMethods {
  test(driver: DriverId, params: ConnectionParams): { serverVersion: string }
  open(driver: DriverId, params: ConnectionParams): {
    sessionId: string
    serverVersion: string
    database: string | null
  }
  close(sessionId: string): void
  listDatabases(sessionId: string): string[]
  describeDatabase(sessionId: string, database: string): TableInfo[]
  setDatabase(sessionId: string, database: string): void
  execute(sessionId: string, sql: string, options: ExecuteOptions): StatementResult
  cancel(sessionId: string): void
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
