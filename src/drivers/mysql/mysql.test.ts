/**
 * Runs against a real MySQL server. Skipped unless TEST_MYSQL_PORT is set:
 *
 *   docker run -d --name hedgerow-mysql-dev -e MYSQL_ROOT_PASSWORD=devpass -p 127.0.0.1:3307:3306 mysql:8.4
 *   TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=devpass pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BinaryCell, ConnectionParams, DriverSession, RowsResult } from '@shared/driver'
import { mysqlDriver } from './index'

const port = Number(process.env.TEST_MYSQL_PORT)
const params: ConnectionParams = {
  host: process.env.TEST_MYSQL_HOST ?? '127.0.0.1',
  port,
  user: process.env.TEST_MYSQL_USER ?? 'root',
  password: process.env.TEST_MYSQL_PASSWORD ?? '',
  tls: 'disabled',
}

const DB = 'hedgerow_driver_test'
const options = { rowLimit: 1000 }

function rows(result: unknown): RowsResult {
  expect(result).toMatchObject({ kind: 'rows' })
  return result as RowsResult
}

describe.skipIf(!port)('mysql driver', () => {
  let session: DriverSession

  beforeAll(async () => {
    session = await mysqlDriver.connect(params)
    await session.execute(`DROP DATABASE IF EXISTS ${DB}`, options)
    await session.execute(`CREATE DATABASE ${DB}`, options)
    await session.setDatabase(DB)
    await session.execute(
      `CREATE TABLE things (
         id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
         name VARCHAR(50) NOT NULL,
         price DECIMAL(20, 4),
         big BIGINT,
         meta JSON,
         made DATETIME,
         raw VARBINARY(8),
         notes TEXT,
         UNIQUE KEY name_unique (name)
       )`,
      options,
    )
    await session.execute(
      `INSERT INTO things (name, price, big, meta, made, raw, notes) VALUES
         ('first', 12345678901234.5678, 9007199254740993, '{"a": [1, 2], "b": null}',
          '2026-01-02 03:04:05', x'DEADBEEF', NULL)`,
      options,
    )
    await session.execute('CREATE TABLE many (n INT PRIMARY KEY)', options)
    const values = Array.from({ length: 50 }, (_, n) => `(${n})`).join(',')
    await session.execute(`INSERT INTO many VALUES ${values}`, options)
  })

  afterAll(async () => {
    await session?.execute(`DROP DATABASE IF EXISTS ${DB}`, options)
    await session?.close()
  })

  it('reports the server version and selected database', () => {
    expect(session.serverVersion).toMatch(/^\d+\./)
    expect(session.database).toBe(DB)
  })

  it('returns values exactly as stored', async () => {
    const result = rows(await session.execute('SELECT * FROM things', options))

    expect(result.columns.map((c) => [c.name, c.dbType, c.kind])).toEqual([
      ['id', 'BIGINT UNSIGNED', 'number'],
      ['name', 'VARCHAR', 'text'],
      ['price', 'DECIMAL', 'number'],
      ['big', 'BIGINT', 'number'],
      ['meta', 'JSON', 'json'],
      ['made', 'DATETIME', 'datetime'],
      ['raw', 'VARBINARY', 'binary'],
      ['notes', 'TEXT', 'text'],
    ])
    expect(result.columns[0].primaryKey).toBe(true)
    expect(result.columns[1].primaryKey).toBe(false)

    const [id, name, price, big, meta, made, raw, notes] = result.rows[0]
    expect(id).toBe(1)
    expect(name).toBe('first')
    expect(price).toBe('12345678901234.5678')
    // Beyond Number.MAX_SAFE_INTEGER, so it must arrive as text.
    expect(big).toBe('9007199254740993')
    expect(JSON.parse(meta as string)).toEqual({ a: [1, 2], b: null })
    expect(made).toBe('2026-01-02 03:04:05')
    expect(raw).toEqual<BinaryCell>({ type: 'binary', bytes: 4, preview: 'deadbeef' })
    expect(notes).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('caps rows for a statement without its own LIMIT', async () => {
    const capped = rows(await session.execute('SELECT n FROM many ORDER BY n', { rowLimit: 10 }))
    expect(capped.rows).toHaveLength(10)
    expect(capped.truncated).toBe(true)

    const exact = rows(await session.execute('SELECT n FROM many ORDER BY n', { rowLimit: 50 }))
    expect(exact.rows).toHaveLength(50)
    expect(exact.truncated).toBe(false)
  })

  it('honours an explicit LIMIT above the cap', async () => {
    const result = rows(await session.execute('SELECT n FROM many LIMIT 20', { rowLimit: 10 }))
    expect(result.rows).toHaveLength(20)
    expect(result.truncated).toBe(false)
  })

  it('reports affected rows for statements without a result set', async () => {
    const result = await session.execute("UPDATE things SET notes = 'x' WHERE id = 1", options)
    expect(result).toMatchObject({ kind: 'ok', affectedRows: 1 })
  })

  it('counts rows changed, not rows matched', async () => {
    const result = await session.execute("UPDATE things SET name = name WHERE id = 1", options)
    expect(result).toMatchObject({ kind: 'ok', affectedRows: 0 })
    expect(result.kind === 'ok' && result.info).toMatch(/Rows matched: 1\s+Changed: 0/)
  })

  it('returns SQL errors as results instead of throwing', async () => {
    const result = await session.execute('SELEC nonsense', options)
    expect(result).toMatchObject({ kind: 'error', code: 'ER_PARSE_ERROR' })

    const missing = await session.execute('SELECT * FROM does_not_exist', options)
    expect(missing).toMatchObject({ kind: 'error', code: 'ER_NO_SUCH_TABLE' })
  })

  it('describes tables, columns and keys', async () => {
    const tables = await session.describeDatabase(DB)
    expect(tables.map((t) => t.name)).toEqual(['many', 'things'])

    const things = tables.find((t) => t.name === 'things')!
    expect(things.type).toBe('table')
    expect(things.columns.find((c) => c.name === 'id')).toMatchObject({
      dataType: 'bigint unsigned',
      nullable: false,
      key: 'primary',
    })
    expect(things.columns.find((c) => c.name === 'name')?.key).toBe('unique')
    expect(things.columns.find((c) => c.name === 'meta')).toMatchObject({ dataType: 'json', nullable: true })
  })

  it('is not limited by a previous row cap when describing', async () => {
    await session.execute('SELECT n FROM many', { rowLimit: 1 })
    expect((await session.listDatabases()).length).toBeGreaterThan(1)
    expect(await session.describeDatabase(DB)).toHaveLength(2)
  })

  it('tracks the selected database across USE', async () => {
    const result = await session.execute('USE information_schema', options)
    expect(result.database).toBe('information_schema')
    await session.setDatabase(DB)
    expect(session.database).toBe(DB)
  })

  it('interrupts a running statement and stays usable', async () => {
    const started = Date.now()
    const pending = session.execute('SELECT SLEEP(15)', options)
    setTimeout(() => void session.cancel(), 300)
    await pending
    expect(Date.now() - started).toBeLessThan(5_000)

    const after = rows(await session.execute('SELECT 1 AS one', options))
    expect(after.rows).toEqual([[1]])
  })

  it('explains a refused connection in plain words', async () => {
    await expect(mysqlDriver.connect({ ...params, port: 1 })).rejects.toThrow(/Nothing is listening at/)
  })

  it('rejects a wrong password with the server message', async () => {
    await expect(mysqlDriver.connect({ ...params, password: 'definitely-wrong' })).rejects.toThrow(
      /Access denied/,
    )
  })
})
