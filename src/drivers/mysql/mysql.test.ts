/**
 * Runs against a real MySQL server. Skipped unless TEST_MYSQL_PORT is set:
 *
 *   docker run -d --name hedgerow-mysql-dev -e MYSQL_ROOT_PASSWORD=devpass -p 127.0.0.1:3307:3306 mysql:8.4
 *   TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=devpass pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BinaryCell, ConnectionParams, DriverSession, EditRequest, RowChange, RowsResult } from '@shared/driver'
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

  describe('editing rows', () => {
    const TABLE = `\`${DB}\`.\`people\``

    /** Runs a statement that has to succeed. */
    async function run(sql: string) {
      const result = await session.execute(sql, options)
      expect(result, sql).not.toMatchObject({ kind: 'error' })
      return result
    }

    async function select(sql: string): Promise<RowsResult> {
      return rows(await session.execute(sql, options))
    }

    /** The request the app would send for changes to the rows of `result`. */
    function request(result: RowsResult, changes: RowChange[]): EditRequest {
      expect(result.readOnly).toBeUndefined()
      return { columns: result.columns, editing: result.editing!, changes }
    }

    /** `bio` of one person, straight from the table. */
    async function bio(id: number) {
      return (await select(`SELECT bio FROM people WHERE id = ${id}`)).rows[0]?.[0]
    }

    beforeAll(async () => {
      await session.setDatabase(DB)
      await run(
        `CREATE TABLE people (
           id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
           email VARCHAR(100) NOT NULL,
           nick VARCHAR(20),
           bio TEXT,
           balance DECIMAL(20, 4) NOT NULL DEFAULT 0,
           big BIGINT,
           prefs JSON,
           seen DATETIME,
           photo VARBINARY(8),
           initials VARCHAR(4) AS (LEFT(email, 2)) STORED,
           UNIQUE KEY people_email (email),
           UNIQUE KEY people_nick (nick)
         )`,
      )
      await run(
        `INSERT INTO people (email, nick, bio, balance, big, prefs, seen, photo) VALUES
           ('ada@example.com', 'ada', NULL, 10.5, 9007199254740993, '{"a": 1}', '2026-01-02 03:04:05', x'DEADBEEF'),
           ('bob@example.com', NULL, '', 0, NULL, NULL, NULL, NULL),
           ('cy@example.com', 'cy', 'third', 3, 3, NULL, NULL, NULL)`,
      )
      await run('CREATE TABLE order_lines (order_id INT, line_no INT, note VARCHAR(20), PRIMARY KEY (order_id, line_no))')
      await run("INSERT INTO order_lines VALUES (7, 1, 'a'), (7, 2, 'b')")
      await run('CREATE TABLE heap (a INT, b VARCHAR(10))')
      await run("INSERT INTO heap VALUES (1, 'x')")
      await run('CREATE TABLE tokens (id BINARY(4) PRIMARY KEY, label VARCHAR(10))')
      await run("INSERT INTO tokens VALUES (x'00010203', 'old')")
      await run('CREATE VIEW people_view AS SELECT id, email FROM people')
      await run('CREATE TABLE digests (digest VARBINARY(64) PRIMARY KEY, label VARCHAR(10))')
      await run("INSERT INTO digests VALUES (REPEAT(x'AB', 40), 'long'), (x'01', 'short')")
      await run('CREATE TABLE files (digest VARBINARY(64) PRIMARY KEY, code INT NOT NULL, UNIQUE KEY files_code (code))')
      await run("INSERT INTO files VALUES (REPEAT(x'CD', 40), 1)")
    })

    it('offers editing for rows read from one table with its primary key', async () => {
      const result = await select('SELECT * FROM people')
      expect(result.columns[1].source).toEqual({ database: DB, table: 'people', column: 'email' })
      expect(result.editing).toEqual({
        table: { database: DB, table: 'people' },
        key: [0],
        // Not the binary column, whose value is only loaded in part, nor the generated one.
        editable: [0, 1, 2, 3, 4, 5, 6, 7],
        nullable: [2, 3, 5, 6, 7],
      })
    })

    it('keeps the stored name of a column the query renamed, and leaves expressions read-only', async () => {
      const result = await select('SELECT id, email AS mail, UPPER(email) AS loud FROM people')
      expect(result.columns[1].source?.column).toBe('email')
      expect(result.columns[2].source).toBeUndefined()
      expect(result.editing).toMatchObject({ key: [0], editable: [0, 1] })
    })

    it('falls back to a unique key that cannot be NULL', async () => {
      const byEmail = await select('SELECT bio, email FROM people')
      expect(byEmail.editing).toMatchObject({ key: [1] })

      // `nick` is unique too, but two rows may both have none.
      const byNick = await select('SELECT nick, bio FROM people')
      expect(byNick.editing).toBeUndefined()
      expect(byNick.readOnly).toMatch(/add `id` to the query/)
    })

    it('needs every column of a key made of several', async () => {
      expect((await select('SELECT * FROM order_lines')).editing).toMatchObject({ key: [0, 1] })
      const partial = await select('SELECT order_id, note FROM order_lines')
      expect(partial.editing).toBeUndefined()
      expect(partial.readOnly).toMatch(/add `order_id` and `line_no` to the query/)
    })

    it('says why other results are read-only', async () => {
      const reason = async (sql: string) => {
        const result = await select(sql)
        expect(result.editing, sql).toBeUndefined()
        return result.readOnly
      }
      expect(await reason('SELECT 1 AS one')).toMatch(/not read straight from a table/)
      expect(await reason('SHOW TABLES')).toMatch(/Only the rows of a SELECT/)
      expect(await reason('SELECT * FROM heap')).toMatch(/`heap` has no primary key or unique key/)
      expect(await reason('SELECT * FROM people_view')).toMatch(/`people_view` has no primary key or unique key/)
      expect(await reason('SELECT p.* FROM people p')).toMatch(/reads `people` under another name \(`p`\)/)
      expect(
        await reason('SELECT p.id, p.email, l.note FROM people p JOIN order_lines l ON l.order_id = p.id'),
      ).toMatch(/more than one table/)
      expect(await reason('SELECT a.id, b.email FROM people a JOIN people b ON b.id = a.id + 1')).toMatch(
        /more than one table/,
      )
      expect(await reason('SELECT id, ROW_NUMBER() OVER (ORDER BY email) AS n FROM people')).toMatch(
        /temporary table/,
      )
    })

    it('is not fooled by a subquery that takes the name of a table', async () => {
      // Each row here pairs the id of one person with the email of another.
      const mixed = await select(
        `SELECT * FROM (SELECT a.id, b.email FROM people a JOIN people b ON b.id = a.id + 1 LIMIT 5) people`,
      )
      expect(mixed.editing).toBeUndefined()

      // These rows are order lines, whatever the query calls them.
      const renamed = await select('SELECT * FROM (SELECT people.order_id, people.note FROM order_lines people) people')
      expect(renamed.editing).toBeUndefined()
    })

    it('still offers editing when a join only filters the rows', async () => {
      const result = await select(
        'SELECT people.* FROM people JOIN order_lines l ON l.order_id = people.id + 6 WHERE l.line_no = 1',
      )
      expect(result.editing).toMatchObject({ table: { database: DB, table: 'people' }, key: [0] })
    })

    it('stays read-only when a join returns a row of the table more than once', async () => {
      // Person 1 has two order lines, so she appears twice. Typing a different name into each
      // copy would otherwise save both, and the second would silently replace the first.
      const result = await select('SELECT people.* FROM people JOIN order_lines l ON l.order_id = people.id + 6')
      expect(result.rows.map((row) => row[0])).toEqual([1, 1])
      expect(result.editing).toBeUndefined()
      expect(result.readOnly).toMatch(/rows of `people` appear more than once/)
    })

    it('does not offer a binary key that was only loaded in part', async () => {
      // Every save would fail: the row could not be named in a statement.
      const result = await select('SELECT * FROM digests')
      expect(result.editing).toBeUndefined()
      expect(result.readOnly).toMatch(/binary value longer than the 32 bytes/)

      // While every key on screen was loaded whole, the rows can be found again.
      expect((await select("SELECT * FROM digests WHERE label = 'short'")).editing).toMatchObject({ key: [0] })

      // And another key of the table will do instead.
      expect((await select('SELECT * FROM files')).editing).toMatchObject({ key: [1] })
    })

    it('writes the statement that opens a table', async () => {
      expect(await session.tableQuery({ database: DB, table: 'we`ird' })).toBe(`SELECT * FROM \`${DB}\`.\`we\`\`ird\``)
    })

    it('plans one statement per changed row and runs nothing', async () => {
      const result = await select('SELECT * FROM people ORDER BY id')
      const statements = await session.planEdits(
        request(result, [
          {
            kind: 'update',
            key: [1],
            set: [
              { column: 2, value: null },
              { column: 3, value: '' },
              { column: 5, value: '9007199254740995' },
            ],
          },
          { kind: 'delete', key: [3] },
        ]),
      )
      expect(statements).toEqual([
        `UPDATE ${TABLE} SET \`nick\` = NULL, \`bio\` = '', \`big\` = 9007199254740995 WHERE \`id\` = 1`,
        `DELETE FROM ${TABLE} WHERE \`id\` = 3`,
      ])
      expect((await select('SELECT id, nick, big FROM people ORDER BY id')).rows).toEqual([
        [1, 'ada', '9007199254740993'],
        [2, null, null],
        [3, 'cy', 3],
      ])
    })

    it('refuses to plan a change that cannot be written', async () => {
      const result = await select('SELECT * FROM people')
      const change = (column: number, value: string | null): RowChange[] => [
        { kind: 'update', key: [1], set: [{ column, value }] },
      ]
      await expect(session.planEdits(request(result, change(4, 'plenty')))).rejects.toThrow(/is not a number/)
      await expect(session.planEdits(request(result, change(1, null)))).rejects.toThrow(/does not accept NULL/)
      await expect(session.planEdits(request(result, change(9, 'zz')))).rejects.toThrow(/cannot be changed/)
    })

    it('stores exactly what was typed', async () => {
      const typed = {
        email: "o'brien@example.com",
        nick: '',
        bio: 'C:\\temp\\new\n\t"quoted" and \'single\' \u00e9\u{1F994} 100%_',
        balance: '12345678901234.5678',
        big: '-9007199254740993',
        prefs: '{"path": "C:\\\\x", "say": "\\"hi\\""}',
        seen: '2026-11-20 23:59:58',
      }
      const result = await select('SELECT * FROM people ORDER BY id')
      const statements = await session.planEdits(
        request(result, [
          {
            kind: 'update',
            key: [2],
            set: Object.values(typed).map((value, index) => ({ column: index + 1, value })),
          },
        ]),
      )
      expect(await session.applyEdits(statements)).toMatchObject({ ok: true })

      const [stored] = (await select('SELECT email, nick, bio, balance, big, prefs, seen FROM people WHERE id = 2'))
        .rows
      expect(stored.slice(0, 5)).toEqual([typed.email, typed.nick, typed.bio, typed.balance, typed.big])
      expect(JSON.parse(stored[5] as string)).toEqual({ path: 'C:\\x', say: '"hi"' })
      expect(stored[6]).toBe(typed.seen)
    })

    it('tells NULL from an empty string both ways', async () => {
      const result = await select('SELECT id, nick, bio FROM people ORDER BY id')
      const save = async (nick: string | null, text: string | null) => {
        const statements = await session.planEdits(
          request(result, [
            {
              kind: 'update',
              key: [3],
              set: [
                { column: 1, value: nick },
                { column: 2, value: text },
              ],
            },
          ]),
        )
        expect(await session.applyEdits(statements)).toMatchObject({ ok: true })
        return (await select('SELECT nick, bio FROM people WHERE id = 3')).rows[0]
      }
      expect(await save(null, '')).toEqual([null, ''])
      expect(await save('cy', null)).toEqual(['cy', null])
    })

    it('stores a backslash as typed when the session does not treat it as an escape', async () => {
      await run("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')")
      try {
        const result = await select('SELECT id, bio FROM people ORDER BY id')
        const text = "C:\\temp\\'s"
        const statements = await session.planEdits(
          request(result, [{ kind: 'update', key: [3], set: [{ column: 1, value: text }] }]),
        )
        expect(statements).toEqual([`UPDATE ${TABLE} SET \`bio\` = 'C:\\temp\\''s' WHERE \`id\` = 3`])
        expect(await session.applyEdits(statements)).toMatchObject({ ok: true })
        expect(await bio(3)).toBe(text)
      } finally {
        await run('SET SESSION sql_mode = DEFAULT')
      }
    })

    it('finds a row by a key made of several columns, and by a binary key', async () => {
      const lines = await select('SELECT * FROM order_lines ORDER BY line_no')
      const lineStatements = await session.planEdits(
        request(lines, [{ kind: 'update', key: [7, 2], set: [{ column: 2, value: 'second' }] }]),
      )
      expect(lineStatements[0]).toMatch(/WHERE `order_id` = 7 AND `line_no` = 2$/)
      expect(await session.applyEdits(lineStatements)).toMatchObject({ ok: true })
      expect((await select('SELECT note FROM order_lines ORDER BY line_no')).rows).toEqual([['a'], ['second']])

      const tokens = await select('SELECT * FROM tokens')
      expect(tokens.editing).toMatchObject({ key: [0], editable: [1] })
      const tokenStatements = await session.planEdits(
        request(tokens, [{ kind: 'update', key: [tokens.rows[0][0]], set: [{ column: 1, value: 'new' }] }]),
      )
      expect(tokenStatements[0]).toMatch(/WHERE `id` = X'00010203'$/)
      expect(await session.applyEdits(tokenStatements)).toMatchObject({ ok: true })
      expect((await select('SELECT label FROM tokens')).rows).toEqual([['new']])
    })

    it('deletes exactly the row that was marked', async () => {
      await run("INSERT INTO people (id, email) VALUES (50, 'gone@example.com'), (51, 'kept@example.com')")
      const result = await select('SELECT * FROM people WHERE id >= 50 ORDER BY id')
      const statements = await session.planEdits(request(result, [{ kind: 'delete', key: [50] }]))
      expect(await session.applyEdits(statements)).toMatchObject({ ok: true })
      expect((await select('SELECT id FROM people WHERE id >= 50')).rows).toEqual([[51]])
    })

    it('saves nothing when a statement matches no row', async () => {
      await run("UPDATE people SET bio = 'before' WHERE id = 1")
      const outcome = await session.applyEdits([
        `UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 1`,
        `UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 999`,
      ])
      expect(outcome).toMatchObject({ ok: false, statement: 1, code: 'ROW_COUNT' })
      expect(outcome.ok === false && outcome.message).toMatch(/matched no row/)
      expect(await bio(1)).toBe('before')
    })

    it('saves nothing when a statement reaches more than one row', async () => {
      const outcome = await session.applyEdits([`UPDATE ${TABLE} SET \`bio\` = 'both' WHERE \`id\` IN (1, 3)`])
      expect(outcome).toMatchObject({ ok: false, statement: 0, code: 'ROW_COUNT' })
      expect(outcome.ok === false && outcome.message).toMatch(/matched 2 rows instead of one/)
      expect(await bio(1)).toBe('before')
    })

    it('saves nothing when the server refuses a statement', async () => {
      const outcome = await session.applyEdits([
        `UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 1`,
        `UPDATE ${TABLE} SET \`email\` = 'ada@example.com' WHERE \`id\` = 3`,
      ])
      expect(outcome).toMatchObject({ ok: false, statement: 1, code: 'ER_DUP_ENTRY' })
      expect(await bio(1)).toBe('before')
    })

    it('saves nothing when the server only warns that it changed a value', async () => {
      await run("SET SESSION sql_mode = ''")
      try {
        const outcome = await session.applyEdits([
          `UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 1`,
          `UPDATE ${TABLE} SET \`nick\` = 'much too long for twenty characters' WHERE \`id\` = 1`,
        ])
        expect(outcome).toMatchObject({ ok: false, statement: 1, code: 'WARNING' })
        expect(outcome.ok === false && outcome.message).toMatch(/Data truncated for column 'nick'/)
        expect((await select('SELECT bio, nick FROM people WHERE id = 1')).rows).toEqual([['before', 'ada']])
      } finally {
        await run('SET SESSION sql_mode = DEFAULT')
      }
    })

    it('counts a row that already holds the new value as that one row', async () => {
      const outcome = await session.applyEdits([`UPDATE ${TABLE} SET \`bio\` = 'before' WHERE \`id\` = 1`])
      expect(outcome).toMatchObject({ ok: true })
    })

    it('runs nothing but changes to a row', async () => {
      const outcome = await session.applyEdits([
        `UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 1`,
        // Would commit on its own, and so could not be rolled back with the rest.
        'ALTER TABLE heap ADD COLUMN c INT',
      ])
      expect(outcome).toMatchObject({ ok: false, statement: 1, code: 'NOT_A_CHANGE' })
      expect(await bio(1)).toBe('before')
      expect((await select('SELECT * FROM heap')).columns).toHaveLength(2)
    })

    it('leaves a transaction the session already has open alone', async () => {
      await run('START TRANSACTION')
      await run("UPDATE people SET bio = 'uncommitted' WHERE id = 1")
      const outcome = await session.applyEdits([`UPDATE ${TABLE} SET \`bio\` = 'after' WHERE \`id\` = 3`])
      expect(outcome).toMatchObject({ ok: false, code: 'IN_TRANSACTION' })
      // Had the save started its own transaction, this change would now be committed.
      await run('ROLLBACK')
      expect(await bio(1)).toBe('before')
    })

    it('stays usable for ordinary statements after a save', async () => {
      expect(await session.applyEdits([`UPDATE ${TABLE} SET \`bio\` = 'last' WHERE \`id\` = 1`])).toMatchObject({
        ok: true,
      })
      const capped = rows(await session.execute('SELECT n FROM many ORDER BY n', { rowLimit: 10 }))
      expect(capped.rows).toHaveLength(10)
      expect(capped.truncated).toBe(true)
      expect(await bio(1)).toBe('last')
    })
  })
})
