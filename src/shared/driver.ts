/**
 * The contract every database driver implements.
 *
 * Drivers run in a separate utility process and must not import Electron or
 * anything from the UI. Everything that crosses this boundary has to survive
 * structured clone, so results are plain data: no Dates, Buffers or classes.
 *
 * To add a database: add its id to `DriverId` and `DRIVER_INFO` below, implement
 * `Driver` in `src/drivers/<id>/`, and register it in `src/drivers/index.ts`.
 */

export type DriverId = 'mysql'

/** What the UI needs to know about each driver without loading it. */
export const DRIVER_INFO: Record<DriverId, { label: string; defaultPort: number }> = {
  mysql: { label: 'MySQL', defaultPort: 3306 },
}

export type TlsMode = 'disabled' | 'required' | 'verify'

export interface ConnectionParams {
  host: string
  port: number
  user: string
  password: string
  /** Database selected when the session opens. Optional. */
  database?: string
  tls: TlsMode
}

/** A binary value is summarised instead of shipped whole. */
export interface BinaryCell {
  type: 'binary'
  bytes: number
  /** Hex of the first bytes, for display. */
  preview: string
}

/**
 * A single value in a result. Numbers that do not fit a double (large BIGINT,
 * DECIMAL) arrive as strings so no precision is lost. Dates arrive as the
 * exact text the server sent, with no timezone conversion.
 */
export type CellValue = string | number | null | BinaryCell

export type ColumnKind = 'number' | 'text' | 'json' | 'datetime' | 'binary' | 'other'

/** A table or view named in full, so it means the same whichever database a session has selected. */
export interface TableRef {
  database: string
  table: string
}

export interface ResultColumn {
  name: string
  /** Type name for display, e.g. `VARCHAR`, `BIGINT`, `JSON`. */
  dbType: string
  kind: ColumnKind
  /** Source table, when the server reports one. This is the name the query used, which may be an alias. */
  table?: string
  primaryKey: boolean
  /**
   * The stored column this one shows, when the server says it is a plain column
   * of a table. Absent for expressions, literals and aggregates.
   */
  source?: TableRef & { column: string }
}

/**
 * How the rows of a result can be changed. A driver offers this only when it can
 * find each row again: the rows all come from one table, and the result includes
 * a primary key or unique key of that table. Indexes point into the result's columns.
 */
export interface ResultEditing {
  table: TableRef
  /** The columns that together identify one row. */
  key: number[]
  /** The columns whose values can be changed. */
  editable: number[]
  /** Of those, the ones that accept NULL. */
  nullable: number[]
}

export interface RowsResult {
  kind: 'rows'
  columns: ResultColumn[]
  rows: CellValue[][]
  /** True when more rows existed than were returned. */
  truncated: boolean
  /** Present when changes to these rows can be written back. */
  editing?: ResultEditing
  /** When they cannot: why, in a sentence fit to show a person as-is. */
  readOnly?: string
  durationMs: number
}

export interface OkResult {
  kind: 'ok'
  affectedRows: number
  /** Present when the statement generated an auto-increment id. */
  insertId?: string
  /** Extra server message, e.g. "Rows matched: 1  Changed: 0  Warnings: 0". */
  info?: string
  durationMs: number
}

export interface ErrorResult {
  kind: 'error'
  message: string
  /** Driver-specific code, e.g. `ER_NO_SUCH_TABLE`. */
  code?: string
  durationMs: number
}

export type StatementResult = (RowsResult | OkResult | ErrorResult) & {
  /** The session's selected database after the statement ran. */
  database: string | null
}

export interface ExecuteOptions {
  /** Maximum rows returned for a statement that has no LIMIT of its own. */
  rowLimit: number
}

/** A new value for one cell: text as it was typed, or NULL. An empty string is a value, not NULL. */
export interface CellChange {
  /** Index of the result column. */
  column: number
  value: string | null
}

/**
 * One staged change to a row of an editable result. `key` holds the row's
 * values for `ResultEditing.key`, in that order and exactly as the result
 * returned them.
 */
export type RowChange =
  | { kind: 'update'; key: CellValue[]; set: CellChange[] }
  | { kind: 'delete'; key: CellValue[] }

export interface EditRequest {
  /** The columns of the result being edited. */
  columns: ResultColumn[]
  /** That result's `editing`. */
  editing: ResultEditing
  changes: RowChange[]
}

/** The outcome of saving changes. A save that is not `ok` changed nothing. */
export type SaveResult =
  | { ok: true; durationMs: number }
  | {
      ok: false
      message: string
      /** Driver-specific code, e.g. `ER_DUP_ENTRY`. */
      code?: string
      /** Index of the statement that stopped the save, when one did. */
      statement?: number
      durationMs: number
    }

export interface ColumnInfo {
  name: string
  /** Full declared type, e.g. `varchar(255)`. */
  dataType: string
  nullable: boolean
  key: 'primary' | 'unique' | 'index' | null
}

export interface TableInfo {
  name: string
  type: 'table' | 'view'
  columns: ColumnInfo[]
}

export interface DriverSession {
  readonly serverVersion: string
  /** Currently selected database, if any. */
  readonly database: string | null
  listDatabases(): Promise<string[]>
  /** Tables and views of one database, with their columns. */
  describeDatabase(database: string): Promise<TableInfo[]>
  setDatabase(database: string): Promise<void>
  /** Runs exactly one statement. Never rejects for SQL errors; returns an `ErrorResult`. */
  execute(sql: string, options: ExecuteOptions): Promise<StatementResult>
  /** Interrupts the statement that is running, if any. The session stays usable. */
  cancel(): Promise<void>
  /** The statement that reads the rows of a table, with names quoted the way this database quotes them. */
  tableQuery(table: TableRef): Promise<string>
  /**
   * Turns staged changes into the statements that make them, one per changed
   * row, with every name and value quoted for this session. Runs nothing.
   * Rejects when a change cannot be written, such as text for a number column.
   */
  planEdits(request: EditRequest): Promise<string[]>
  /**
   * Runs statements from `planEdits` in one transaction. Commits only if every
   * statement changes exactly one row and none raises a warning; otherwise
   * everything is rolled back. Never rejects for SQL errors.
   */
  applyEdits(statements: string[]): Promise<SaveResult>
  close(): Promise<void>
}

export interface Driver {
  id: DriverId
  connect(params: ConnectionParams): Promise<DriverSession>
}
