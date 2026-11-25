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
  /** False when the server says this column never holds NULL. */
  nullable: boolean
  /**
   * The stored column this one shows, when the server says it is a plain column
   * of a table. Absent for expressions, literals and aggregates.
   */
  source?: TableRef & { column: string }
}

/**
 * What the UI needs to know to start a new row. Indexes point into the result's
 * columns, and all of them are editable columns.
 */
export interface RowAdding {
  /**
   * Columns the table gives no default and that do not accept NULL, so a new
   * row is expected to give them a value. This is a hint to show, not a rule to
   * enforce: a trigger may fill one in, and only the server knows.
   */
  required: number[]
  /** Columns the database numbers by itself when a new row leaves them out. */
  auto: number[]
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
  /** Present when rows can be added to the table from this result. */
  adding?: RowAdding
  /** When they cannot: why, in a sentence fit to show a person as-is. */
  cannotAdd?: string
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
  /**
   * True when it was the connection that failed, not the statement. The session
   * cannot be used again, and whatever it had open on the server is gone with it.
   */
  connectionLost?: boolean
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

/**
 * How a table's rows are narrowed and ordered when it is opened. Both parts are
 * text in the database's own SQL, as a person would type them: the app passes
 * them on to the driver and never takes them apart.
 */
export interface TableView {
  /** A condition, as it would follow WHERE. Empty for every row. */
  where: string
  /** Sort terms, as they would follow ORDER BY. Empty for the order the database gives. */
  orderBy: string
}

/**
 * One change to a view that is asked for in the grid instead of typed. The
 * driver writes it, because names and values have to be quoted its way.
 */
export type ViewChange =
  /** Keeps only the rows that hold `value` in `column`, or with `exclude` only the ones that do not. */
  | { kind: 'filter'; column: ResultColumn; value: CellValue; exclude: boolean }
  /** Orders by `column` alone. No direction takes the order away. */
  | { kind: 'sort'; column: ResultColumn; direction: 'asc' | 'desc' | null }

/** A new value for one cell: text as it was typed, or NULL. An empty string is a value, not NULL. */
export interface CellChange {
  /** Index of the result column. */
  column: number
  value: string | null
}

/**
 * One staged change to a row of an editable result. `key` holds the row's
 * values for `ResultEditing.key`, in that order and exactly as the result
 * returned them. A new row has no key yet: an insert names only the columns
 * that were given a value, and every other column is left to its default.
 */
export type RowChange =
  | { kind: 'update'; key: CellValue[]; set: CellChange[] }
  | { kind: 'delete'; key: CellValue[] }
  | { kind: 'insert'; set: CellChange[] }

export interface EditRequest {
  /** The columns of the result being edited. */
  columns: ResultColumn[]
  /** That result's `editing`. */
  editing: ResultEditing
  changes: RowChange[]
}

/** The outcome of saving changes. A save that is not `ok` changed nothing, unless it says otherwise in `notUndone`. */
export type SaveResult =
  | {
      ok: true
      durationMs: number
      /**
       * One entry per statement, in order: the number the database generated for
       * the row a statement added, or null when it added none or generated none.
       */
      insertIds?: (string | null)[]
    }
  | {
      ok: false
      message: string
      /** Driver-specific code, e.g. `ER_DUP_ENTRY`. */
      code?: string
      /** Index of the statement that stopped the save, when one did. */
      statement?: number
      /** True when the connection failed. The session cannot be used again. */
      connectionLost?: boolean
      /**
       * Present when it cannot be said that nothing was saved: the server could
       * not undo everything, or the connection failed before it answered the
       * commit. Says which, in a sentence fit to show a person as-is.
       */
      notUndone?: string
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
  /** False once the connection has failed or the session was closed. Nothing can be run on it again. */
  readonly usable: boolean
  listDatabases(): Promise<string[]>
  /** Tables and views of one database, with their columns. */
  describeDatabase(database: string): Promise<TableInfo[]>
  setDatabase(database: string): Promise<void>
  /** Runs exactly one statement. Never rejects for SQL errors; returns an `ErrorResult`. */
  execute(sql: string, options: ExecuteOptions): Promise<StatementResult>
  /**
   * Interrupts the statement that is running, if any. The session stays usable,
   * and a statement that starts afterwards is never the one interrupted.
   */
  cancel(): Promise<void>
  /**
   * The statement that reads the rows of a table, with names quoted the way
   * this database quotes them. With a view, only the rows it keeps, in its order.
   * The table is read under its own name, so the rows stay editable.
   */
  tableQuery(table: TableRef, view?: TableView): Promise<string>
  /**
   * Makes one change to a view and gives back the view that results, with the
   * name and the value written for this session. Runs nothing. Rejects when
   * rows cannot be found by the value, such as an approximate number.
   */
  changeView(view: TableView, change: ViewChange): Promise<TableView>
  /**
   * Turns staged changes into the statements that make them, one per change
   * and in the same order, with every name and value quoted for this session. Runs nothing.
   * Rejects when a change cannot be written, such as text for a number column.
   */
  planEdits(request: EditRequest): Promise<string[]>
  /**
   * Runs statements from `planEdits` in one transaction. Commits only if every
   * statement changes or adds exactly one row and none raises a warning;
   * otherwise everything is rolled back, and if the server cannot roll all of
   * it back the result says so. Never rejects for SQL errors.
   */
  applyEdits(statements: string[]): Promise<SaveResult>
  /** Ends the session. A statement it is still running is interrupted first, not left to finish unseen. */
  close(): Promise<void>
}

export interface Driver {
  id: DriverId
  connect(params: ConnectionParams): Promise<DriverSession>
}
