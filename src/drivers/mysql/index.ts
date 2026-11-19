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
  ExecuteOptions,
  ResultColumn,
  StatementResult,
  TableInfo,
} from '@shared/driver'
import { DriverError } from '../error'

/**
 * Upper bound on rows held for one statement, whatever LIMIT it asks for.
 * Past this the statement is interrupted and the result marked truncated.
 */
const HARD_ROW_CAP = 100_000

const BINARY_CHARSET = 63
const FLAG_PRIMARY_KEY = 2
const FLAG_UNSIGNED = 32
const FLAG_ENUM = 256
const FLAG_SET = 2048
const ER_QUERY_INTERRUPTED = 1317

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
  table?: string
}

interface MysqlError extends Error {
  code?: string
  errno?: number
  sqlMessage?: string
}

function toColumn(field: FieldLike): ResultColumn {
  const code = field.columnType ?? -1
  const flags = typeof field.flags === 'number' ? field.flags : 0
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

  return {
    name: field.name,
    dbType,
    kind,
    table: field.table || undefined,
    primaryKey: (flags & FLAG_PRIMARY_KEY) !== 0,
  }
}

function toBinaryCell(buffer: Buffer): BinaryCell {
  return {
    type: 'binary',
    bytes: buffer.length,
    preview: buffer.subarray(0, 32).toString('hex'),
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

function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

type Outcome =
  | { kind: 'rows'; columns: ResultColumn[]; rows: CellValue[][]; truncated: boolean }
  | { kind: 'ok'; affectedRows: number; insertId?: string; info?: string }

class MysqlSession implements DriverSession {
  private currentDatabase: string | null
  /** The SQL_SELECT_LIMIT this session currently has; null is the server default. */
  private selectLimit: number | null = null
  private running = false
  /** Set by cancel() so a statement that has not reached the server yet is skipped. */
  private cancelRequested = false
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
      this.running = true
      this.cancelRequested = false
      // One extra row tells us whether the result was cut short.
      await this.setSelectLimit(options.rowLimit + 1)
      if (this.cancelRequested) {
        throw Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' })
      }
      const outcome = await this.runStatement(sql)
      const durationMs = elapsed()
      this.running = false

      if (/^\s*use\s/i.test(sql)) await this.refreshDatabase()

      if (outcome.kind === 'rows' && !outcome.truncated && outcome.rows.length === options.rowLimit + 1) {
        outcome.rows.pop()
        outcome.truncated = true
      }
      return { ...outcome, durationMs, database: this.currentDatabase }
    } catch (error) {
      this.running = false
      const failure = error as MysqlError
      return {
        kind: 'error',
        message: failure.sqlMessage || failure.message || 'The statement failed.',
        code: failure.code,
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
    // KILL QUERY has to come from another connection; this one is busy.
    const side = await openConnection({ ...this.params, database: undefined })
    try {
      await queryRows(side, `KILL QUERY ${Number(threadId)}`)
    } finally {
      side.destroy()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
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

  private assertOpen(): void {
    if (this.closed) throw new DriverError('The connection was closed. Reconnect to continue.', 'CLOSED')
  }

  /** Runs one of our own queries, free of any row limit set for user statements. */
  private async internalQuery(sql: string, values: unknown[] = []): Promise<unknown[][]> {
    this.assertOpen()
    try {
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

  private async refreshDatabase(): Promise<void> {
    const rows = await queryRows(this.connection, 'SELECT DATABASE()')
    const name = rows[0]?.[0]
    this.currentDatabase = typeof name === 'string' ? name : null
  }

  /**
   * Streams one statement. Only the first result set is kept; a stored
   * procedure that returns several still runs to completion.
   */
  private runStatement(sql: string): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      let columns: ResultColumn[] | null = null
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
        if (columns) resolve({ kind: 'rows', columns, rows, truncated })
        else resolve({ kind: 'ok', ...(ok ?? { affectedRows: 0 }) })
      }

      const query = this.connection.query({ sql, rowsAsArray: true })

      query.on('fields', (fields: FieldLike[] | undefined) => {
        if (fields && columns === null) {
          columns = fields.map(toColumn)
          capturedSet = setIndex
        }
      })

      query.on('result', (row: unknown, index?: number) => {
        if (typeof index === 'number') setIndex = index
        if (Array.isArray(row)) {
          if (setIndex !== capturedSet) return
          if (rows.length >= HARD_ROW_CAP) {
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
