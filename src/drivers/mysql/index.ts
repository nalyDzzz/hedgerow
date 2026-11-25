import mysql from 'mysql2'
import type { Connection, ConnectionOptions } from 'mysql2'
import type {
  BinaryCell,
  CellValue,
  ColumnInfo,
  ColumnKind,
  ConnectionParams,
  Driver,
  DriverSession,
  EditRequest,
  ExecuteOptions,
  ResultColumn,
  ResultEditing,
  RowsResult,
  SaveResult,
  StatementResult,
  TableInfo,
  TableRef,
  TableView,
  ViewChange,
} from '@shared/driver'
import { DriverError } from '../error'
import {
  changedView,
  editStatements,
  givesNameAway,
  isEditStatement,
  isInsert,
  isQuery,
  quoteIdentifier,
  tableQuery,
  type SqlMode,
} from './sql'

/**
 * Upper bound on rows held for one statement, whatever LIMIT it asks for.
 * Past this the statement is interrupted and the result marked truncated.
 * The largest row limit is one row above it, because a limit asks for one row
 * more than it shows.
 */
const HARD_ROW_CAP = 100_000

const BINARY_CHARSET = 63
/** How much of a binary value is loaded. A longer one is known only by its start. */
const BINARY_PREVIEW_BYTES = 32
const FLAG_NOT_NULL = 1
const FLAG_PRIMARY_KEY = 2
const FLAG_UNSIGNED = 32
const FLAG_ENUM = 256
const FLAG_SET = 2048
/** Set on a column that belongs to an index, as long as the row comes straight from the table. */
const FLAG_PART_OF_KEY = 16384
const ER_QUERY_INTERRUPTED = 1317
/** Bit of the status the server sends with every answer: a transaction is open. */
const STATUS_IN_TRANSACTION = 1
/**
 * Storage engines that keep no transactions, in lower case. What is written to
 * one of their tables stays written, so a save could not be all or nothing.
 */
const NO_ROLLBACK = new Set([
  'myisam',
  'aria',
  'memory',
  'heap',
  'csv',
  'archive',
  'mrg_myisam',
  'merge',
  'federated',
  'blackhole',
  'connect',
])

/** MySQL protocol column type codes mapped to a display name and a kind. */
const COLUMN_TYPES: Record<number, [dbType: string, kind: ColumnKind]> = {
  0: ['DECIMAL', 'number'],
  1: ['TINYINT', 'number'],
  2: ['SMALLINT', 'number'],
  3: ['INT', 'number'],
  4: ['FLOAT', 'number'],
  5: ['DOUBLE', 'number'],
  6: ['NULL', 'other'],
  7: ['TIMESTAMP', 'datetime'],
  8: ['BIGINT', 'number'],
  9: ['MEDIUMINT', 'number'],
  10: ['DATE', 'datetime'],
  11: ['TIME', 'datetime'],
  12: ['DATETIME', 'datetime'],
  13: ['YEAR', 'number'],
  14: ['DATE', 'datetime'],
  15: ['VARCHAR', 'text'],
  16: ['BIT', 'number'],
  242: ['VECTOR', 'binary'],
  245: ['JSON', 'json'],
  246: ['DECIMAL', 'number'],
  247: ['ENUM', 'text'],
  248: ['SET', 'text'],
  249: ['TINYBLOB', 'binary'],
  250: ['MEDIUMBLOB', 'binary'],
  251: ['LONGBLOB', 'binary'],
  252: ['BLOB', 'binary'],
  253: ['VARCHAR', 'text'],
  254: ['CHAR', 'text'],
  255: ['GEOMETRY', 'binary'],
}

const TEXT_NAMES: Record<number, string> = {
  249: 'TINYTEXT',
  250: 'MEDIUMTEXT',
  251: 'LONGTEXT',
  252: 'TEXT',
}

interface FieldLike {
  name: string
  columnType?: number
  flags?: number | string[]
  characterSet?: number
  /** The name the query used for the table, which may be an alias. */
  table?: string
  orgTable?: string
  /** The column's name in its table, whatever the query called it. */
  orgName?: string
  /** The database the table is in. */
  schema?: string
}

/** What the server answers to a statement that returns no rows. */
interface OkHeader {
  affectedRows?: number
  insertId?: number | string
  info?: string
  serverStatus?: number
  warningStatus?: number
}

/** The keys and columns of one table, as far as editing needs them. */
interface TableShape {
  /** Every column, in lower case. */
  columns: Set<string>
  /** Columns the server computes, which cannot be assigned. */
  generated: Set<string>
  /** Columns the server numbers by itself when a new row leaves them out. */
  auto: Set<string>
  /** Columns with no default that do not accept NULL, as the table spells them. */
  required: string[]
  /** Unique indexes. A part with no column is an expression. */
  keys: { name: string; parts: { column: string | null; nullable: boolean }[] }[]
  /** The storage engine that holds the table, when the server names one. */
  engine: string | null
}

interface MysqlError extends Error {
  code?: string
  errno?: number
  sqlMessage?: string
  /** Set when the connection itself failed and cannot be used again. */
  fatal?: boolean
}

function toColumn(field: FieldLike): ResultColumn {
  const code = field.columnType ?? -1
  const flags = flagsOf(field)
  const binary = field.characterSet === BINARY_CHARSET
  let [dbType, kind] = COLUMN_TYPES[code] ?? ['UNKNOWN', 'other' as ColumnKind]

  if (code >= 249 && code <= 252 && !binary) {
    dbType = TEXT_NAMES[code]
    kind = 'text'
  } else if ((code === 253 || code === 254) && binary) {
    dbType = code === 253 ? 'VARBINARY' : 'BINARY'
    kind = 'binary'
  } else if (code === 254 && flags & FLAG_ENUM) {
    dbType = 'ENUM'
  } else if (code === 254 && flags & FLAG_SET) {
    dbType = 'SET'
  } else if (kind === 'number' && flags & FLAG_UNSIGNED && code !== 16) {
    dbType += ' UNSIGNED'
  }

  const column: ResultColumn = {
    name: field.name,
    dbType,
    kind,
    table: field.table || undefined,
    primaryKey: (flags & FLAG_PRIMARY_KEY) !== 0,
    nullable: (flags & FLAG_NOT_NULL) === 0,
  }
  if (field.schema && field.orgTable && field.orgName) {
    column.source = { database: field.schema, table: field.orgTable, column: field.orgName }
  }
  return column
}

function flagsOf(field: FieldLike): number {
  return typeof field.flags === 'number' ? field.flags : 0
}

function toBinaryCell(buffer: Buffer): BinaryCell {
  return {
    type: 'binary',
    bytes: buffer.length,
    preview: buffer.subarray(0, BINARY_PREVIEW_BYTES).toString('hex'),
  }
}

/** Keeps every value exact and cloneable: buffers are summarised, the rest passes through. */
const typeCast: ConnectionOptions['typeCast'] = (field, next) => {
  if (field.type === 'BIT') {
    const bits = field.buffer()
    if (bits === null) return null
    return bits.length <= 6 ? bits.readUIntBE(0, bits.length) : `0x${bits.toString('hex')}`
  }
  if (field.type === 'GEOMETRY') {
    const raw = field.buffer()
    return raw === null ? null : toBinaryCell(raw)
  }
  const value: unknown = next()
  if (Buffer.isBuffer(value)) return toBinaryCell(value)
  return value
}

function connectionOptions(params: ConnectionParams): ConnectionOptions {
  return {
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password,
    database: params.database || undefined,
    ssl:
      params.tls === 'disabled'
        ? undefined
        : { rejectUnauthorized: params.tls === 'verify' },
    connectTimeout: 10_000,
    charset: 'utf8mb4',
    multipleStatements: false,
    // Report rows actually changed, as the mysql client does, not rows merely matched.
    flags: ['-FOUND_ROWS'],
    // Exactness over convenience: no Date objects, no lossy numbers, JSON as sent.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    jsonStrings: true,
    typeCast,
  }
}

function describeError(error: MysqlError, params: ConnectionParams): DriverError {
  const where = `${params.host}:${params.port}`
  switch (error.code) {
    case 'ECONNREFUSED':
      return new DriverError(
        `Nothing is listening at ${where}. Check the host and port, and that the server is running.`,
        error.code,
      )
    case 'ENOTFOUND':
      return new DriverError(`The host "${params.host}" could not be found.`, error.code)
    case 'ETIMEDOUT':
      return new DriverError(`Timed out connecting to ${where}.`, error.code)
    default:
      return new DriverError(
        error.sqlMessage || error.message || error.code || 'The connection failed.',
        error.code,
      )
  }
}

function openConnection(params: ConnectionParams): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = mysql.createConnection(connectionOptions(params))
    // A connection with no error listener takes the process down when the socket drops.
    connection.on('error', () => {})
    connection.connect((error) => {
      if (error) {
        connection.destroy()
        reject(describeError(error, params))
      } else {
        resolve(connection)
      }
    })
  })
}

function queryRows(connection: Connection, sql: string, values: unknown[] = []): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    connection.query({ sql, values, rowsAsArray: true }, (error, rows) => {
      if (error) reject(error)
      else resolve(Array.isArray(rows) ? (rows as unknown[][]) : [])
    })
  })
}

/** Runs a statement that must not return rows, and gives back the server's answer to it. */
function runCommand(connection: Connection, sql: string): Promise<OkHeader> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error, result) => {
      if (error) reject(error)
      else if (Array.isArray(result)) {
        reject(new DriverError('The statement returns rows instead of changing one.', 'NOT_A_CHANGE'))
      } else resolve(result as OkHeader)
    })
  })
}

/**
 * How many rows a statement reached. This connection counts rows changed, so an
 * UPDATE that finds its row already holding the new value counts none; the
 * server's message says how many it matched. A server set to another language
 * words that message differently, and then rows changed is what there is.
 */
function rowsReached(header: OkHeader): number {
  const matched = /^Rows matched: (\d+)/.exec(header.info ?? '')
  return matched ? Number(matched[1]) : (header.affectedRows ?? 0)
}

/**
 * The number the server generated for the row a statement added, if it did.
 * One too large to be exact as a JavaScript number is left out: a wrong id is worse than none.
 */
function generatedId(header: OkHeader): string | null {
  const id = typeof header.insertId === 'string' ? Number(header.insertId) : header.insertId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null
}

/** True for a binary value that was only loaded in part, so that its whole value is not known. */
function isCutShort(value: CellValue): boolean {
  return typeof value === 'object' && value !== null && value.preview.length !== value.bytes * 2
}

/** True when two rows carry the same key, which means the result holds one row of the table twice. */
function repeatsKey(rows: CellValue[][], key: number[]): boolean {
  const seen = new Set<string>()
  for (const row of rows) {
    const values = key.map((index) => row[index])
    // An outer join can return many rows with no key at all. None of them can be edited anyway.
    if (values.includes(null)) continue
    const id = JSON.stringify(values)
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

function nameList(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``)
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted.join('')
}

type Outcome =
  | { kind: 'rows'; columns: ResultColumn[]; fields: FieldLike[]; rows: CellValue[][]; truncated: boolean }
  | { kind: 'ok'; affectedRows: number; insertId?: string; info?: string }

class MysqlSession implements DriverSession {
  private currentDatabase: string | null
  /** The SQL_SELECT_LIMIT this session currently has; null is the server default. */
  private selectLimit: number | null = null
  private running = false
  /** Counts the statements this session has started, so a kill can tell the one it was meant for. */
  private started = 0
  /** Set by cancel() so a statement that has not reached the server yet is skipped. */
  private cancelRequested = false
  /** Kills that are on their way to the server. */
  private readonly kills = new Set<Promise<void>>()
  /** True once a kill was sent, until a statement that does nothing has been run to take it. */
  private strayKill = false
  private closed = false

  constructor(
    private readonly connection: Connection,
    private readonly params: ConnectionParams,
    readonly serverVersion: string,
    database: string | null,
  ) {
    this.currentDatabase = database
    connection.on('error', () => {
      this.closed = true
    })
  }

  get database(): string | null {
    return this.currentDatabase
  }

  get usable(): boolean {
    return !this.closed
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.internalQuery('SHOW DATABASES')
    return rows.map((row) => String(row[0]))
  }

  async describeDatabase(database: string): Promise<TableInfo[]> {
    const tableRows = await this.internalQuery(
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    )
    const columnRows = await this.internalQuery(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    )

    const tables = new Map<string, TableInfo>()
    for (const [name, type] of tableRows) {
      tables.set(String(name), {
        name: String(name),
        type: String(type).toUpperCase().includes('VIEW') ? 'view' : 'table',
        columns: [],
      })
    }
    for (const [table, name, dataType, nullable, key] of columnRows) {
      const column: ColumnInfo = {
        name: String(name),
        dataType: String(dataType),
        nullable: String(nullable).toUpperCase() === 'YES',
        key: key === 'PRI' ? 'primary' : key === 'UNI' ? 'unique' : key === 'MUL' ? 'index' : null,
      }
      tables.get(String(table))?.columns.push(column)
    }
    return [...tables.values()]
  }

  async setDatabase(database: string): Promise<void> {
    await this.internalQuery(`USE ${quoteIdentifier(database)}`)
    this.currentDatabase = database
  }

  async execute(sql: string, options: ExecuteOptions): Promise<StatementResult> {
    const started = performance.now()
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10
    try {
      this.assertOpen()
      this.begin()
      await this.settle()
      // One extra row tells us whether the result was cut short.
      await this.setSelectLimit(options.rowLimit + 1)
      if (this.cancelRequested) {
        throw Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' })
      }
      // The limit already ends the result one row past what is shown. Only a statement that
      // sets its own limit, or returns rows some other way, can run past that.
      const outcome = await this.runStatement(sql, Math.max(HARD_ROW_CAP, options.rowLimit + 1))
      const durationMs = elapsed()
      this.running = false
      // What follows are our own questions, and a kill sent for the statement must not reach them.
      await this.settle()

      if (/^\s*use\s/i.test(sql)) await this.refreshDatabase()

      if (outcome.kind === 'ok') return { ...outcome, durationMs, database: this.currentDatabase }

      if (!outcome.truncated && outcome.rows.length === options.rowLimit + 1) {
        outcome.rows.pop()
        outcome.truncated = true
      }
      const { fields, ...rows } = outcome
      // Looked up after the clock stops: it is our question, not part of the statement.
      // The statement itself succeeded, so nothing that goes wrong here may turn it into a failure.
      const editing = await this.describeEditing(sql, fields, rows.columns, rows.rows).catch(() => ({
        readOnly: 'It could not be worked out whether these rows can be edited.',
      }))
      return { ...rows, ...editing, durationMs, database: this.currentDatabase }
    } catch (error) {
      this.running = false
      const failure = error as MysqlError
      if (failure.fatal) this.closed = true
      return {
        kind: 'error',
        message: failure.sqlMessage || failure.message || 'The statement failed.',
        code: failure.code,
        ...(this.closed ? { connectionLost: true } : {}),
        durationMs: elapsed(),
        database: this.currentDatabase,
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.running || this.closed) return
    this.cancelRequested = true
    const threadId = this.connection.threadId
    if (threadId == null) return
    const kill = this.kill(this.started, Number(threadId))
    const pending = kill.then(
      () => {},
      () => {},
    )
    this.kills.add(pending)
    void pending.then(() => this.kills.delete(pending))
    await kill
  }

  /** Interrupts statement number `target` of this session, if it is still the one running. */
  private async kill(target: number, threadId: number): Promise<void> {
    // KILL QUERY has to come from another connection; this one is busy.
    const side = await openConnection({ ...this.params, database: undefined })
    try {
      // Opening that connection took a moment. If the statement ended meanwhile, a kill
      // sent now would find nothing, or whatever this session runs next.
      if (!this.running || this.started !== target || this.closed) return
      this.strayKill = true
      await queryRows(side, `KILL QUERY ${threadId}`)
    } finally {
      side.destroy()
    }
  }

  /** Marks the start of a statement that cancel() can interrupt. */
  private begin(): void {
    this.running = true
    this.started += 1
    this.cancelRequested = false
  }

  /**
   * Keeps a kill meant for one statement from reaching another. A kill travels on
   * a connection of its own, so it can arrive after its statement has ended, and
   * some servers then hold it for whatever this connection runs next. So a kill
   * that is on its way is waited for, and a statement that does nothing is run to take it.
   */
  private async settle(): Promise<void> {
    while (this.kills.size > 0) await Promise.all(this.kills)
    if (!this.strayKill) return
    this.strayKill = false
    await queryRows(this.connection, 'DO 0').catch(() => {})
  }

  async tableQuery(table: TableRef, view?: TableView): Promise<string> {
    return tableQuery(table, view)
  }

  async changeView(view: TableView, change: ViewChange): Promise<TableView> {
    return changedView(view, change, await this.sqlMode())
  }

  async planEdits(request: EditRequest): Promise<string[]> {
    return editStatements(request, await this.sqlMode())
  }

  async applyEdits(statements: string[]): Promise<SaveResult> {
    const started = performance.now()
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10
    let inTransaction = false
    /** True from the moment COMMIT is sent until the server has answered it. */
    let committing = false
    /** The statement being run, while one is. */
    let at: number | undefined
    const insertIds: (string | null)[] = []
    try {
      this.assertOpen()
      this.begin()
      await this.settle()

      // START TRANSACTION would quietly commit a transaction this session already has open.
      const before = await runCommand(this.connection, 'DO 0')
      if ((before.serverStatus ?? 0) & STATUS_IN_TRANSACTION) {
        throw new DriverError(
          'This tab has a transaction open, or autocommit is off. Commit or roll back first, then save again.',
          'IN_TRANSACTION',
        )
      }

      // Anything else could commit on its own, such as an ALTER TABLE, and break the promise of all or nothing.
      at = statements.findIndex((sql) => !isEditStatement(sql))
      if (at >= 0) throw new DriverError('The statement is not a change to one row of a table.', 'NOT_A_CHANGE')
      at = undefined

      await runCommand(this.connection, 'START TRANSACTION')
      inTransaction = true
      for (const [index, sql] of statements.entries()) {
        at = index
        if (this.cancelRequested) {
          throw Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' })
        }
        const header = await runCommand(this.connection, sql)
        // A lenient server stores a value it had to cut or change and only warns about it.
        if (header.warningStatus) {
          const warnings = await queryRows(this.connection, 'SHOW WARNINGS LIMIT 3')
          const said = warnings.map((warning) => String(warning[2])).join(' ')
          throw new DriverError(`The server raised a warning: ${said || 'no details given.'}`, 'WARNING')
        }
        const reached = rowsReached(header)
        const adds = isInsert(sql)
        if (reached !== 1) {
          throw new DriverError(
            adds
              ? `The statement added ${reached} rows instead of one.`
              : reached === 0
                ? 'The statement matched no row. The row may have been changed or deleted since it was loaded.'
                : `The statement matched ${reached} rows instead of one.`,
            'ROW_COUNT',
          )
        }
        insertIds.push(adds ? generatedId(header) : null)
      }
      at = undefined
      // From here a kill could only land on the COMMIT. So none is sent any more, one that is
      // on its way is waited for, and a save that was stopped in time is not committed.
      this.running = false
      await this.settle()
      if (this.cancelRequested) {
        throw Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' })
      }
      committing = true
      await runCommand(this.connection, 'COMMIT')
      committing = false
      inTransaction = false
      return { ok: true, durationMs: elapsed(), insertIds }
    } catch (error) {
      const failure = error as MysqlError
      if (failure.fatal) this.closed = true
      // The same goes for the ROLLBACK: interrupted, it would leave the transaction open.
      this.running = false
      await this.settle()
      let notUndone: string | undefined
      if (committing && this.closed) {
        notUndone =
          'The connection failed while the changes were being committed, so it is not known whether they were ' +
          'stored. Run the statement again to see what the table holds now.'
      } else if (inTransaction) {
        notUndone = await this.rollBack()
      }
      return {
        ok: false,
        message: failure.sqlMessage || failure.message || 'The save failed.',
        code: failure.code,
        statement: at,
        ...(this.closed ? { connectionLost: true } : {}),
        ...(notUndone ? { notUndone } : {}),
        durationMs: elapsed(),
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Takes back what a save has done so far. Gives the server's words when it
   * could not take all of it back: a table that keeps no transactions, written
   * to by the statements or by a trigger they set off, holds on to what it got.
   */
  private async rollBack(): Promise<string | undefined> {
    try {
      const undone = await runCommand(this.connection, 'ROLLBACK')
      if (!undone.warningStatus) return undefined
      const warnings = await queryRows(this.connection, 'SHOW WARNINGS LIMIT 3')
      const said = warnings.map((warning) => String(warning[2])).join(' ')
      return `The server could not undo all of it. It said: ${said || 'nothing more.'}`
    } catch {
      // The connection is gone, and the server rolls back whatever a connection leaves open.
      return undefined
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    // Left running, a statement would carry on and commit on the server with nobody there to see it.
    if (this.running) await this.cancel().catch(() => {})
    this.closed = true
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(() => {
        this.connection.destroy()
        resolve()
      }, 2_000)
      this.connection.end(() => {
        clearTimeout(giveUp)
        resolve()
      })
    })
  }

  /** How this session reads a string, asked each time because a statement may have changed it. */
  private async sqlMode(): Promise<SqlMode> {
    this.assertOpen()
    try {
      await this.settle()
      const rows = await queryRows(this.connection, 'SELECT @@SESSION.sql_mode')
      return { backslashEscapes: !String(rows[0]?.[0] ?? '').toUpperCase().includes('NO_BACKSLASH_ESCAPES') }
    } catch (error) {
      throw describeError(error as MysqlError, this.params)
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new DriverError('The connection was closed. Reconnect to continue.', 'CLOSED')
  }

  /** Runs one of our own queries, free of any row limit set for user statements. */
  private async internalQuery(sql: string, values: unknown[] = []): Promise<unknown[][]> {
    this.assertOpen()
    try {
      await this.settle()
      await this.setSelectLimit(null)
      return await queryRows(this.connection, sql, values)
    } catch (error) {
      throw describeError(error as MysqlError, this.params)
    }
  }

  private async setSelectLimit(limit: number | null): Promise<void> {
    if (this.selectLimit === limit) return
    await queryRows(this.connection, `SET SQL_SELECT_LIMIT = ${limit === null ? 'DEFAULT' : Number(limit)}`)
    this.selectLimit = limit
  }

  /**
   * Decides whether the rows of a result can be changed, and by which key.
   *
   * The server says where each column comes from, but it is not always the
   * whole truth: for a subquery or a view it can name an alias as if it were
   * the table. So this takes the cautious reading of everything it is told. A
   * table has to be read under its own name, every column has to exist in it,
   * and the key columns have to arrive still marked as part of a key, which
   * they are not once the server has copied the rows into a temporary table.
   */
  private async describeEditing(
    sql: string,
    fields: FieldLike[],
    columns: ResultColumn[],
    rows: CellValue[][],
  ): Promise<Pick<RowsResult, 'editing' | 'readOnly'>> {
    if (!isQuery(sql)) return { readOnly: 'Only the rows of a SELECT can be edited.' }

    const stored = columns.flatMap((column, index) => (column.source ? [index] : []))
    const table = columns[stored[0]]?.source
    if (!table) return { readOnly: 'These values are not read straight from a table.' }

    const alias = fields[stored[0]].table
    const oneTable = stored.every((index) => {
      const source = columns[index].source!
      return source.database === table.database && source.table === table.table && fields[index].table === alias
    })
    if (!oneTable) return { readOnly: 'These rows combine more than one table.' }
    if (alias !== table.table) {
      return {
        readOnly:
          `The query reads \`${table.table}\` under another name (\`${alias}\`): an alias, a view or a subquery. ` +
          'Rows can be edited when the table is read under its own name.',
      }
    }
    // Its own name is not proof either. A subquery or a WITH clause can be given the table's
    // name, and the server then passes off what that returns as the table's columns.
    if (givesNameAway(sql, table.table)) {
      return {
        readOnly:
          `The query gives the name \`${table.table}\` to a subquery or a WITH clause, so these may not be the ` +
          "table's rows as it stores them. Rows can be edited when the table is read directly.",
      }
    }

    let shape: TableShape
    try {
      shape = await this.tableShape(table)
    } catch {
      return { readOnly: `The keys of \`${table.table}\` could not be read.` }
    }
    if (!stored.every((index) => shape.columns.has(columns[index].source!.column.toLowerCase()))) {
      return { readOnly: 'These values are not read straight from a table.' }
    }
    if (shape.engine && NO_ROLLBACK.has(shape.engine.toLowerCase())) {
      return {
        readOnly:
          `\`${table.table}\` is a ${shape.engine} table, and ${shape.engine} cannot undo a change. A save that ` +
          'stopped part way would leave some of it behind, so its rows are changed with statements instead.',
      }
    }

    const find = (name: string) =>
      stored.find((index) => columns[index].source!.column.toLowerCase() === name.toLowerCase())
    // A nullable column, or an expression, cannot pick out one row.
    const usable = shape.keys.filter((key) => key.parts.every((part) => part.column !== null && !part.nullable))
    if (usable.length === 0) {
      return {
        readOnly: `\`${table.table}\` has no primary key or unique key, so one row cannot be told from another.`,
      }
    }

    let copied = false
    let cutShort = false
    for (const key of usable) {
      const found = key.parts.map((part) => find(part.column!))
      if (found.some((index) => index === undefined)) continue
      const keyColumns = found as number[]
      // Comparing against a FLOAT or DOUBLE does not reliably find the row again.
      if (keyColumns.some((index) => /^(FLOAT|DOUBLE)/.test(columns[index].dbType))) continue
      if (!keyColumns.every((index) => flagsOf(fields[index]) & FLAG_PART_OF_KEY)) {
        copied = true
        continue
      }
      // A binary key identifies a row only if all of it was loaded, for every row.
      if (rows.some((row) => keyColumns.some((index) => isCutShort(row[index])))) {
        cutShort = true
        continue
      }
      // A join can return one row of the table several times. Each copy could then be given
      // a different value, and the save would keep the last one and say nothing.
      if (repeatsKey(rows, keyColumns)) {
        return {
          readOnly:
            `Some rows of \`${table.table}\` appear more than once here, as a join can make them. ` +
            'Rows can be edited when each appears once.',
        }
      }
      const nameOf = (index: number) => columns[index].source!.column.toLowerCase()
      const editable = stored.filter(
        (index) => columns[index].kind !== 'binary' && !shape.generated.has(nameOf(index)),
      )
      return {
        editing: {
          table: { database: table.database, table: table.table },
          key: keyColumns,
          editable,
          nullable: editable.filter((index) => !(flagsOf(fields[index]) & FLAG_NOT_NULL)),
          ...this.describeAdding(table, shape, columns, stored, editable),
        },
      }
    }

    if (cutShort) {
      return {
        readOnly:
          `The key of \`${table.table}\` is a binary value longer than the ${BINARY_PREVIEW_BYTES} bytes that ` +
          'are loaded of it, so a row could not be found again.',
      }
    }
    if (copied) {
      return {
        readOnly:
          'The server gathered these rows in a temporary table before returning them, so it no longer says which ' +
          'row each one is. Grouping, window functions and some subqueries and sorts do this.',
      }
    }
    const wanted = usable[0].parts.map((part) => part.column!)
    return {
      readOnly:
        `To edit these rows, add ${nameList(wanted)} to the query. ` +
        `${wanted.length > 1 ? 'Together they identify' : 'It identifies'} a row of \`${table.table}\`.`,
    }
  }

  /**
   * Decides whether a row can be added through a result. It can as long as the
   * result can give a value to every column that has to be given one. Whether a
   * value is in fact given is left to the server at save time: a trigger may
   * fill a column in, and only the server knows.
   */
  private describeAdding(
    table: TableRef,
    shape: TableShape,
    columns: ResultColumn[],
    /** The columns of the result that are stored in the table. */
    stored: number[],
    editable: number[],
  ): Pick<ResultEditing, 'adding' | 'cannotAdd'> {
    const nameOf = (index: number) => columns[index].source!.column.toLowerCase()
    const shown = new Set(stored.map(nameOf))
    const settable = new Set(editable.map(nameOf))

    const hidden = shape.required.filter((name) => !shown.has(name.toLowerCase()))
    if (hidden.length > 0) {
      const names =
        hidden.length > 4
          ? `${hidden.slice(0, 3).map((name) => `\`${name}\``).join(', ')} and ${hidden.length - 3} other columns`
          : nameList(hidden)
      return {
        cannotAdd:
          `To add rows here, add ${names} to the query. ` +
          `A new row of \`${table.table}\` needs a value for ${hidden.length > 1 ? 'each of them' : 'it'}.`,
      }
    }
    const fixed = shape.required.filter((name) => !settable.has(name.toLowerCase()))
    if (fixed.length > 0) {
      return {
        cannotAdd:
          `A new row of \`${table.table}\` needs a value for ${nameList(fixed)}, ` +
          'and a binary value cannot be typed here.',
      }
    }

    const required = new Set(shape.required.map((name) => name.toLowerCase()))
    return {
      adding: {
        required: editable.filter((index) => required.has(nameOf(index))),
        auto: editable.filter((index) => shape.auto.has(nameOf(index))),
      },
    }
  }

  /** One round trip for everything. A row with no index name describes a column, and names the table's engine. */
  private async tableShape(table: TableRef): Promise<TableShape> {
    const rows = await queryRows(
      this.connection,
      `(SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NULLABLE, NULL
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0)
       UNION ALL
       (SELECT NULL, ORDINAL_POSITION, COLUMN_NAME,
               CASE WHEN GENERATION_EXPRESSION <> '' THEN 'GENERATED'
                    WHEN EXTRA LIKE '%auto_increment%' THEN 'AUTO'
                    WHEN IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL THEN 'REQUIRED'
                    ELSE '' END,
               (SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)
          FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)
       LIMIT 100000`,
      [table.database, table.table, table.database, table.table, table.database, table.table],
    )

    const shape: TableShape = {
      columns: new Set(),
      generated: new Set(),
      auto: new Set(),
      required: [],
      keys: [],
      engine: null,
    }
    const parts = new Map<string, { position: number; column: string | null; nullable: boolean }[]>()
    const required: { name: string; position: number }[] = []
    for (const [index, position, column, note, engine] of rows) {
      if (index === null) {
        const name = String(column).toLowerCase()
        shape.columns.add(name)
        // Every column row carries it, and says the same.
        if (typeof engine === 'string') shape.engine = engine
        if (note === 'GENERATED') shape.generated.add(name)
        else if (note === 'AUTO') shape.auto.add(name)
        else if (note === 'REQUIRED') required.push({ name: String(column), position: Number(position) })
      } else {
        const list = parts.get(String(index)) ?? []
        list.push({
          position: Number(position),
          column: column === null ? null : String(column),
          nullable: String(note).toUpperCase() === 'YES',
        })
        parts.set(String(index), list)
      }
    }
    // In the order the table has them, which is the order a person knows them in.
    shape.required = required.sort((a, b) => a.position - b.position).map(({ name }) => name)
    shape.keys = [...parts]
      .map(([name, list]) => ({ name, parts: list.sort((a, b) => a.position - b.position) }))
      // The primary key first; after it, the same order every time.
      .sort((a, b) => Number(b.name === 'PRIMARY') - Number(a.name === 'PRIMARY') || a.name.localeCompare(b.name))
    return shape
  }

  private async refreshDatabase(): Promise<void> {
    const rows = await queryRows(this.connection, 'SELECT DATABASE()')
    const name = rows[0]?.[0]
    this.currentDatabase = typeof name === 'string' ? name : null
  }

  /**
   * Streams one statement. Only the first result set is kept; a stored
   * procedure that returns several still runs to completion. Past `cap` rows
   * the statement is interrupted.
   */
  private runStatement(sql: string, cap: number): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      let columns: ResultColumn[] | null = null
      let captured: FieldLike[] = []
      let capturedSet = -1
      let setIndex = 0
      const rows: CellValue[][] = []
      let ok: { affectedRows: number; insertId?: string; info?: string } | null = null
      let truncated = false
      let interruptedAtCap = false
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        if (columns) resolve({ kind: 'rows', columns, fields: captured, rows, truncated })
        else resolve({ kind: 'ok', ...(ok ?? { affectedRows: 0 }) })
      }

      const query = this.connection.query({ sql, rowsAsArray: true })

      query.on('fields', (fields: FieldLike[] | undefined) => {
        if (fields && columns === null) {
          columns = fields.map(toColumn)
          captured = fields
          capturedSet = setIndex
        }
      })

      query.on('result', (row: unknown, index?: number) => {
        if (typeof index === 'number') setIndex = index
        if (Array.isArray(row)) {
          if (setIndex !== capturedSet) return
          if (rows.length >= cap) {
            truncated = true
            if (!interruptedAtCap) {
              interruptedAtCap = true
              void this.cancel().catch(() => {})
            }
            return
          }
          rows.push(row as CellValue[])
          return
        }
        // A non-row result is the server's OK packet for a statement without a result set.
        const header = row as { affectedRows?: number; insertId?: number | string; info?: string }
        setIndex += 1
        if (ok === null) {
          ok = {
            affectedRows: header.affectedRows ?? 0,
            insertId: header.insertId ? String(header.insertId) : undefined,
            info: header.info || undefined,
          }
        }
      })

      query.on('error', (error: MysqlError) => {
        if (interruptedAtCap && error.errno === ER_QUERY_INTERRUPTED) {
          finish()
          return
        }
        if (settled) return
        settled = true
        reject(error)
      })

      query.on('end', finish)
    })
  }
}

export const mysqlDriver: Driver = {
  id: 'mysql',

  async connect(params: ConnectionParams): Promise<DriverSession> {
    const connection = await openConnection(params)
    try {
      const rows = await queryRows(connection, 'SELECT VERSION(), DATABASE()')
      const [version, database] = rows[0] ?? []
      return new MysqlSession(
        connection,
        params,
        String(version ?? ''),
        typeof database === 'string' ? database : null,
      )
    } catch (error) {
      connection.destroy()
      throw describeError(error as MysqlError, params)
    }
  },
}
