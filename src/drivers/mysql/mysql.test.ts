/**
 * Runs against a real MySQL server. Skipped unless TEST_MYSQL_PORT is set:
 *
 *   docker run -d --name hedgerow-mysql-dev -e MYSQL_ROOT_PASSWORD=devpass -p 127.0.0.1:3307:3306 mysql:8.4
 *   TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=devpass pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  BinaryCell,
  CellValue,
  ConnectionParams,
  DriverSession,
  EditRequest,
  ResultColumn,
  RowChange,
  RowsResult,
  TableView,
} from '@shared/driver'
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

  describe('stopping statements', () => {
    /** How many KILL statements the server has been sent, by anyone. */
    async function kills() {
      const status = rows(await session.execute("SHOW GLOBAL STATUS LIKE 'Com_kill'", options))
      return Number(status.rows[0][1])
    }

    beforeAll(async () => {
      await session.setDatabase(DB)
      // More rows than a result may hold, by a few.
      await session.execute('SET SESSION cte_max_recursion_depth = 200000', options)
      await session.execute('CREATE TABLE plenty (n INT PRIMARY KEY)', options)
      await session.execute(
        `INSERT INTO plenty
         WITH RECURSIVE counted (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < 100050)
         SELECT n FROM counted`,
        options,
      )
    })

    it('does not interrupt a statement that the largest row limit already ended', async () => {
      const before = await kills()
      const result = rows(await session.execute('SELECT n FROM plenty', { rowLimit: 100_000 }))
      expect(result.rows).toHaveLength(100_000)
      expect(result.truncated).toBe(true)
      expect(await kills()).toBe(before)
      // A kill sent for it used to arrive after it had ended, and stop the key lookup that follows.
      expect(result.editing).toMatchObject({ key: [0] })
    })

    it('interrupts a statement that returns more rows than a result may hold', async () => {
      const result = rows(await session.execute('SELECT n FROM plenty LIMIT 200000', options))
      expect(result.rows).toHaveLength(100_000)
      expect(result.truncated).toBe(true)
      expect(result.editing).toMatchObject({ key: [0] })
      expect(rows(await session.execute('SELECT 1 AS one', options)).rows).toEqual([[1]])
    })

    it('does not let a stop that comes too late reach the next statement', async () => {
      // The stop is asked for while the first statement runs, which ends before the kill can be sent.
      const first = session.execute('SELECT 1 AS one', options)
      const stop = session.cancel()
      await first
      const started = Date.now()
      const next = rows(await session.execute('SELECT SLEEP(0.6)', options))
      await stop
      // An interrupted SLEEP returns 1, and at once.
      expect(next.rows).toEqual([[0]])
      expect(Date.now() - started).toBeGreaterThanOrEqual(550)
    })

    it('stops the statement a session is running when the session is closed', async () => {
      await session.execute('CREATE TABLE slow (n INT PRIMARY KEY, v INT NOT NULL DEFAULT 0)', options)
      const values = Array.from({ length: 40 }, (_, n) => `(${n}, 0)`).join(',')
      await session.execute(`INSERT INTO slow VALUES ${values}`, options)

      const other = await mysqlDriver.connect({ ...params, database: DB })
      // Ten seconds of work, unless it is stopped.
      const pending = other.execute('UPDATE slow SET v = v + 1 WHERE SLEEP(0.25) = 0', options)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const started = Date.now()
      await other.close()
      const result = await pending
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(result).toMatchObject({ kind: 'error', code: 'ER_QUERY_INTERRUPTED' })

      // Nothing is left running that could still change the rows. A lock it held would make this wait.
      const untouched = rows(await session.execute('SELECT COUNT(*) FROM slow WHERE v = 0 FOR UPDATE NOWAIT', options))
      expect(untouched.rows).toEqual([[40]])
    })

    it('says when it was the connection that failed, so that a new one can be opened', async () => {
      const other = await mysqlDriver.connect({ ...params, database: DB })
      const id = rows(await other.execute('SELECT CONNECTION_ID()', options)).rows[0][0]
      await session.execute(`KILL ${Number(id)}`, options)
      await new Promise((resolve) => setTimeout(resolve, 200))

      const result = await other.execute('SELECT 1', options)
      expect(result).toMatchObject({ kind: 'error', connectionLost: true })
      const saved = await other.applyEdits(['UPDATE `x`.`y` SET `a` = 1 WHERE `b` = 2'])
      expect(saved).toMatchObject({ ok: false, connectionLost: true })

      // A statement that the server refuses says nothing of the kind.
      expect(await session.execute('SELEC nonsense', options)).not.toHaveProperty('connectionLost')
    })
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
        // `email` has no default and refuses NULL. `balance` refuses NULL too, but has a default.
        adding: { required: [1], auto: [0] },
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

    it('is not fooled by a subquery or a WITH clause that takes the name of its own table', async () => {
      await run(
        'CREATE TABLE staff (id INT PRIMARY KEY, name VARCHAR(30) NOT NULL, boss INT NOT NULL, KEY staff_boss (boss))',
      )
      await run("INSERT INTO staff VALUES (1, 'ada', 3), (2, 'bob', 1), (3, 'cy', 2)")

      // Each of these shows a person's boss as their id, and the server reports it as the table's
      // `id`. Saved by that, a change typed into ada's row would be written to cy's.
      for (const sql of [
        'WITH staff AS (SELECT boss AS id, name, id AS boss FROM staff) SELECT * FROM staff',
        'WITH staff (id, name, boss) AS (SELECT boss, name, id FROM staff) SELECT * FROM staff',
        'SELECT * FROM (SELECT boss AS id, name, id AS boss FROM staff) AS staff',
        'SELECT * FROM (SELECT boss AS id, name, id AS boss FROM staff) `staff`',
      ]) {
        const result = await select(sql)
        expect(result.rows, sql).toContainEqual([3, 'ada', 1])
        expect(result.editing, sql).toBeUndefined()
        expect(result.readOnly, sql).toMatch(/gives the name `staff` to a subquery or a WITH clause/)
      }

      // Read directly, the rows can be edited, also when the table is named again in a condition.
      for (const sql of [
        'SELECT staff.* FROM staff WHERE staff.id > 0',
        'SELECT * FROM staff WHERE boss IN (SELECT id FROM staff)',
        `SELECT * FROM \`${DB}\`.\`staff\` AS staff`,
      ]) {
        expect((await select(sql)).editing, sql).toMatchObject({ table: { database: DB, table: 'staff' }, key: [0] })
      }
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

    it('leaves a table read-only when its engine cannot undo a change', async () => {
      await run('CREATE TABLE ledger (id INT PRIMARY KEY, name VARCHAR(5) NOT NULL) ENGINE = MyISAM')
      await run("INSERT INTO ledger VALUES (1, 'a')")
      const result = await select('SELECT * FROM ledger')
      expect(result.editing).toBeUndefined()
      expect(result.readOnly).toMatch(/`ledger` is a MyISAM table, and MyISAM cannot undo a change/)
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

    it('says so when the server could not undo everything a stopped save had done', async () => {
      // The table itself can be rolled back. The journal its trigger writes to cannot.
      await run('CREATE TABLE journal (note VARCHAR(40)) ENGINE = MyISAM')
      await run('CREATE TABLE guarded (id INT PRIMARY KEY, name VARCHAR(5) NOT NULL)')
      await run("INSERT INTO guarded VALUES (1, 'a'), (2, 'b')")
      await run(
        `CREATE TRIGGER guarded_journal AFTER UPDATE ON guarded
         FOR EACH ROW INSERT INTO journal VALUES (CONCAT('changed ', NEW.id))`,
      )
      const result = await select('SELECT * FROM guarded')
      const statements = await session.planEdits(
        request(result, [
          { kind: 'update', key: [1], set: [{ column: 1, value: 'fine' }] },
          { kind: 'update', key: [2], set: [{ column: 1, value: 'far too long' }] },
        ]),
      )
      const saved = await session.applyEdits(statements)
      expect(saved).toMatchObject({ ok: false, code: 'ER_DATA_TOO_LONG', statement: 1 })
      expect(saved.ok === false && saved.notUndone).toMatch(/could not undo all of it/)
      expect((await select('SELECT name FROM guarded ORDER BY id')).rows).toEqual([['a'], ['b']])
      expect((await select('SELECT note FROM journal')).rows).toEqual([['changed 1']])

      // A save that is undone whole says nothing of the kind.
      const whole = await session.applyEdits([`UPDATE ${TABLE} SET \`email\` = NULL WHERE \`id\` = 1`])
      expect(whole).toMatchObject({ ok: false })
      expect(whole).not.toHaveProperty('notUndone')
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

    describe('adding rows', () => {
      const add = (set: [column: number, value: string | null][]): RowChange => ({
        kind: 'insert',
        set: set.map(([column, value]) => ({ column, value })),
      })

      it('lets a row be added only where every column that needs a value can be given one', async () => {
        const reason = async (sql: string) => {
          const result = await select(sql)
          expect(result.editing, sql).toBeDefined()
          expect(result.editing!.adding, sql).toBeUndefined()
          return result.editing!.cannotAdd
        }
        // `email` is not on screen, so no new row could ever be saved.
        expect(await reason('SELECT id, nick FROM people')).toBe(
          'To add rows here, add `email` to the query. A new row of `people` needs a value for it.',
        )
        // An expression over the column is not the column.
        expect(await reason('SELECT id, UPPER(email) AS email FROM people')).toMatch(/add `email` to the query/)
        // A column that is left out but accepts NULL, or has a default, is no obstacle.
        expect((await select('SELECT order_id, line_no FROM order_lines')).editing?.adding).toBeDefined()

        // Named in the order the table has them, not the order of their names.
        await run(
          `CREATE TABLE wide (id INT PRIMARY KEY AUTO_INCREMENT, zed INT NOT NULL, b INT NOT NULL, a INT NOT NULL,
             d INT NOT NULL, e INT NOT NULL, note VARCHAR(10))`,
        )
        expect(await reason('SELECT id, note, zed, b FROM wide')).toBe(
          'To add rows here, add `a`, `d` and `e` to the query. A new row of `wide` needs a value for each of them.',
        )
        expect(await reason('SELECT id, note FROM wide')).toBe(
          'To add rows here, add `zed`, `b`, `a` and 2 other columns to the query. ' +
            'A new row of `wide` needs a value for each of them.',
        )
        // A binary value cannot be typed, so a table that needs one cannot be added to.
        expect(await reason('SELECT * FROM tokens')).toBe(
          'A new row of `tokens` needs a value for `id`, and a binary value cannot be typed here.',
        )
      })

      it('marks the columns a new row is expected to fill, and the ones the database numbers', async () => {
        // The key here is `email`, the only key the result holds whole.
        const byEmail = await select('SELECT email, balance, bio FROM people')
        expect(byEmail.editing).toMatchObject({ key: [0], adding: { required: [0], auto: [] } })

        // No default and NOT NULL, but part of a key the database does not number: still for the person to give.
        const lines = await select('SELECT * FROM order_lines')
        expect(lines.editing).toMatchObject({ adding: { required: [0, 1], auto: [] } })
      })

      it('plans an INSERT that names only what was given, and runs nothing', async () => {
        const result = await select('SELECT * FROM people ORDER BY id')
        const count = (await select('SELECT COUNT(*) FROM people')).rows[0][0]
        const statements = await session.planEdits(
          request(result, [
            add([
              [1, "new'o@example.com"],
              [2, null],
              [3, ''],
              [5, '9007199254740995'],
            ]),
            add([]),
          ]),
        )
        expect(statements).toEqual([
          `INSERT INTO ${TABLE} (\`email\`, \`nick\`, \`bio\`, \`big\`) VALUES ('new''o@example.com', NULL, '', 9007199254740995)`,
          `INSERT INTO ${TABLE} () VALUES ()`,
        ])
        expect((await select('SELECT COUNT(*) FROM people')).rows[0][0]).toBe(count)
      })

      it('stores a new row exactly as typed, leaves the rest to the table, and says which id it got', async () => {
        const typed = {
          email: "o'neil@example.com",
          bio: 'C:\\temp\\new\n\t"quoted" and \'single\' \u00e9\u{1F994} 100%_',
          big: '-9007199254740993',
          prefs: '{"path": "C:\\\\x", "n": 12345678901234567890}',
          seen: '2026-11-24 23:59:58',
        }
        const result = await select('SELECT * FROM people ORDER BY id')
        const statements = await session.planEdits(
          request(result, [
            add([
              [1, typed.email],
              [3, typed.bio],
              [5, typed.big],
              [6, typed.prefs],
              [7, typed.seen],
            ]),
          ]),
        )
        const outcome = await session.applyEdits(statements)
        expect(outcome).toMatchObject({ ok: true })
        const [id] = (outcome.ok && outcome.insertIds) || []
        expect(id).toMatch(/^\d+$/)

        const [stored] = (
          await select(`SELECT email, nick, bio, balance, big, prefs, seen, initials FROM people WHERE id = ${id}`)
        ).rows
        expect(stored[0]).toBe(typed.email)
        // Not given, so the table decided: NULL where it allows it, its default where it has one.
        expect(stored[1]).toBeNull()
        expect(stored[2]).toBe(typed.bio)
        expect(stored[3]).toBe('0.0000')
        expect(stored[4]).toBe(typed.big)
        expect(stored[5]).toContain('12345678901234567890')
        expect(stored[6]).toBe(typed.seen)
        expect(stored[7]).toBe("o'")
      })

      it('adds rows in the same transaction as other changes, after them', async () => {
        await run("INSERT INTO people (id, email) VALUES (60, 'swap@example.com'), (61, 'stay@example.com')")
        const result = await select('SELECT * FROM people WHERE id >= 60 ORDER BY id')
        // The new row takes the address the deleted one had, which only works in this order.
        const statements = await session.planEdits(
          request(result, [
            { kind: 'delete', key: [60] },
            { kind: 'update', key: [61], set: [{ column: 3, value: 'kept' }] },
            add([[1, 'swap@example.com']]),
          ]),
        )
        const outcome = await session.applyEdits(statements)
        expect(outcome).toMatchObject({ ok: true })
        expect(outcome.ok && outcome.insertIds).toEqual([null, null, expect.stringMatching(/^\d+$/)])
        const after = await select("SELECT id, bio FROM people WHERE email IN ('swap@example.com', 'stay@example.com') ORDER BY id")
        expect(after.rows).toEqual([
          [61, 'kept'],
          [Number((outcome.ok && outcome.insertIds?.[2]) || 0), null],
        ])
      })

      it('says no id when the row was given its own key', async () => {
        const lines = await select('SELECT * FROM order_lines')
        const statements = await session.planEdits(
          request(lines, [
            add([
              [0, '8'],
              [1, '1'],
              [2, 'typed key'],
            ]),
          ]),
        )
        expect(statements).toEqual([
          `INSERT INTO \`${DB}\`.\`order_lines\` (\`order_id\`, \`line_no\`, \`note\`) VALUES (8, 1, 'typed key')`,
        ])
        expect(await session.applyEdits(statements)).toMatchObject({ ok: true, insertIds: [null] })
        expect((await select('SELECT note FROM order_lines WHERE order_id = 8')).rows).toEqual([['typed key']])
      })

      it('saves nothing when a new row is refused, whatever came before it', async () => {
        await run("UPDATE people SET bio = 'before' WHERE id = 1")
        const result = await select('SELECT * FROM people ORDER BY id')
        const count = (await select('SELECT COUNT(*) FROM people')).rows[0][0]

        // The address is taken.
        const duplicate = await session.applyEdits(
          await session.planEdits(
            request(result, [
              { kind: 'update', key: [1], set: [{ column: 3, value: 'after' }] },
              add([[1, 'fresh@example.com']]),
              add([[1, 'ada@example.com']]),
            ]),
          ),
        )
        expect(duplicate).toMatchObject({ ok: false, statement: 2, code: 'ER_DUP_ENTRY' })

        // `email` has no default, and nothing gave it a value.
        const missing = await session.applyEdits(
          await session.planEdits(
            request(result, [{ kind: 'update', key: [1], set: [{ column: 3, value: 'after' }] }, add([[2, 'nobody']])]),
          ),
        )
        expect(missing).toMatchObject({ ok: false, statement: 1, code: 'ER_NO_DEFAULT_FOR_FIELD' })

        expect(await bio(1)).toBe('before')
        expect((await select('SELECT COUNT(*) FROM people')).rows[0][0]).toBe(count)
      })

      it('saves nothing when a lenient server would make up a value for a new row', async () => {
        const result = await select('SELECT * FROM people ORDER BY id')
        const count = (await select('SELECT COUNT(*) FROM people')).rows[0][0]
        const statements = await session.planEdits(request(result, [add([[2, 'lenient']])]))
        await run("SET SESSION sql_mode = ''")
        try {
          // Without strict mode the server stores an empty address and only warns.
          const outcome = await session.applyEdits(statements)
          expect(outcome).toMatchObject({ ok: false, statement: 0, code: 'WARNING' })
          expect(outcome.ok === false && outcome.message).toMatch(/'email' doesn't have a default value/)
        } finally {
          await run('SET SESSION sql_mode = DEFAULT')
        }
        expect((await select('SELECT COUNT(*) FROM people')).rows[0][0]).toBe(count)
      })

      it('lets a trigger give the value a new row left out', async () => {
        await run('CREATE TABLE stamped (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(20) NOT NULL, note VARCHAR(20))')
        await run("CREATE TRIGGER stamped_code BEFORE INSERT ON stamped FOR EACH ROW SET NEW.code = CONCAT('S-', COALESCE(NEW.note, ''))")
        const result = await select('SELECT * FROM stamped')
        // `code` is marked as expected, but leaving it out is the server's call, not ours.
        expect(result.editing).toMatchObject({ adding: { required: [1], auto: [0] } })
        const outcome = await session.applyEdits(await session.planEdits(request(result, [add([[2, 'x']])])))
        expect(outcome).toMatchObject({ ok: true })
        expect((await select('SELECT code, note FROM stamped')).rows).toEqual([['S-x', 'x']])
      })

      it('counts an INSERT that adds more or fewer rows than one as a failure', async () => {
        const count = (await select('SELECT COUNT(*) FROM order_lines')).rows[0][0]
        const two = await session.applyEdits([
          `INSERT INTO \`${DB}\`.\`order_lines\` (\`order_id\`, \`line_no\`) VALUES (9, 1), (9, 2)`,
        ])
        expect(two).toMatchObject({ ok: false, statement: 0, code: 'ROW_COUNT' })
        expect(two.ok === false && two.message).toBe('The statement added 2 rows instead of one.')
        const none = await session.applyEdits([
          `INSERT INTO \`${DB}\`.\`order_lines\` (\`order_id\`, \`line_no\`) SELECT 9, 1 FROM DUAL WHERE FALSE`,
        ])
        expect(none).toMatchObject({ ok: false, statement: 0, code: 'ROW_COUNT' })
        expect((await select('SELECT COUNT(*) FROM order_lines')).rows[0][0]).toBe(count)
      })

      it('offers adding to a table that has no rows yet', async () => {
        await run('CREATE TABLE fresh (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(10) NOT NULL DEFAULT \'new\')')
        const empty = await select('SELECT * FROM fresh')
        expect(empty.rows).toEqual([])
        expect(empty.editing).toMatchObject({ key: [0], adding: { required: [], auto: [0] } })
        const outcome = await session.applyEdits(await session.planEdits(request(empty, [add([])])))
        expect(outcome).toMatchObject({ ok: true, insertIds: ['1'] })
        expect((await select('SELECT * FROM fresh')).rows).toEqual([[1, 'new']])
      })
    })

    describe('a table opened with a filter and an order', () => {
      const stock = { database: DB, table: 'stock' }
      const all: TableView = { where: '', orderBy: '' }

      /** The rows a view keeps, read the way the app reads them. */
      async function open(view: TableView): Promise<RowsResult> {
        return select(await session.tableQuery(stock, view))
      }

      /** The view after a click on a cell: only the rows with this value, or only the others. */
      async function filtered(column: ResultColumn, value: CellValue, exclude = false, from = all) {
        return session.changeView(from, { kind: 'filter', column, value, exclude })
      }

      const ids = (result: RowsResult) => result.rows.map((row) => row[0])

      beforeAll(async () => {
        await run(
          `CREATE TABLE stock (
             id INT PRIMARY KEY AUTO_INCREMENT,
             sku VARCHAR(20) NOT NULL,
             bin CHAR(2),
             qty INT,
             big BIGINT UNSIGNED,
             cost DECIMAL(10, 2),
             weight FLOAT,
             meta JSON,
             seen DATETIME,
             note TEXT
           )`,
        )
        await run(
          `INSERT INTO stock (sku, bin, qty, big, cost, weight, meta, seen, note) VALUES
             ('bolt', 'A1', 5, 9007199254740993, 9.50, 1.1, '{"tags": ["m6", "steel"], "n": 1}', '2026-01-02 03:04:05', 'plain'),
             ('nut', 'A1', 12, 9007199254740992, 0.10, 0.2, '{"n": 1, "tags": ["m6", "steel"]}', '2026-01-02 03:04:06', 'it''s'),
             ('washer', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
             ('screw', 'B2', 5, 1, 9.5, 3, '[]', NULL, 'C:\\\\temp\\\\x'),
             ('rivet', 'b2', 0, 2, 12.00, 4, '{"tags": []}', '2026-01-02 03:04:05', '100%_done')`,
        )
      })

      it('says for each column whether it can hold NULL', async () => {
        const result = await open(all)
        expect(result.columns.map((column) => [column.name, column.nullable]).slice(0, 4)).toEqual([
          ['id', false],
          ['sku', false],
          ['bin', true],
          ['qty', true],
        ])
      })

      it('reads only the rows a view keeps, in its order, and they can still be edited', async () => {
        const view = { where: "bin = 'A1' OR qty = 0", orderBy: 'qty DESC, id' }
        expect(await session.tableQuery(stock, view)).toBe(
          `SELECT * FROM \`${DB}\`.\`stock\`\nWHERE bin = 'A1' OR qty = 0\nORDER BY qty DESC, id`,
        )
        const result = await open(view)
        expect(result.rows.map((row) => row[1])).toEqual(['nut', 'bolt', 'rivet'])
        expect(result.readOnly).toBeUndefined()
        expect(result.editing).toMatchObject({ table: stock, key: [0], adding: { required: [1], auto: [0] } })

        // And a change made there is planned against the table itself.
        const statements = await session.planEdits(
          request(result, [{ kind: 'update', key: [result.rows[0][0]], set: [{ column: 3, value: '13' }] }]),
        )
        expect(statements).toEqual([`UPDATE \`${DB}\`.\`stock\` SET \`qty\` = 13 WHERE \`id\` = 2`])
      })

      it('finds the rows that hold a value picked from a cell, whatever its type', async () => {
        const table = await open({ where: '', orderBy: 'id' })
        const column = (name: string) => table.columns.findIndex((item) => item.name === name)
        /** The ids of the rows that hold what row `row` holds in `name`. */
        const sameAs = async (row: number, name: string) => {
          const index = column(name)
          return ids(await open({ ...(await filtered(table.columns[index], table.rows[row][index])), orderBy: 'id' }))
        }

        expect(await sameAs(0, 'sku')).toEqual([1])
        expect(await sameAs(0, 'qty')).toEqual([1, 4])
        // One apart, and both beyond what a double can tell apart.
        expect(await sameAs(0, 'big')).toEqual([1])
        expect(await sameAs(1, 'big')).toEqual([2])
        // 9.50 and 9.5 are the same amount.
        expect(await sameAs(0, 'cost')).toEqual([1, 4])
        expect(await sameAs(0, 'seen')).toEqual([1, 5])
        // The same document, whatever order its keys were written in.
        expect(await sameAs(0, 'meta')).toEqual([1, 2])
        expect(await sameAs(3, 'meta')).toEqual([4])
        // Quotes, backslashes and the wildcards of LIKE are all just text.
        expect(await sameAs(1, 'note')).toEqual([2])
        expect(await sameAs(3, 'note')).toEqual([4])
        expect(await sameAs(4, 'note')).toEqual([5])
        // The column's own collation decides what counts as the same text.
        expect(await sameAs(3, 'bin')).toEqual([4, 5])
      })

      it('finds text with a backslash when the session does not treat it as an escape', async () => {
        const table = await open({ where: '', orderBy: 'id' })
        const note = table.columns.findIndex((item) => item.name === 'note')
        await run("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')")
        try {
          const view = await filtered(table.columns[note], table.rows[3][note])
          expect(view.where).toBe("`note` = 'C:\\temp\\x'")
          expect(ids(await open(view))).toEqual([4])
        } finally {
          await run('SET SESSION sql_mode = DEFAULT')
        }
      })

      it('keeps the rows that hold NULL when a value is excluded', async () => {
        const table = await open({ where: '', orderBy: 'id' })
        const bin = table.columns[2]
        const view = await filtered(bin, 'A1', true)
        expect(view.where).toBe("(`bin` <> 'A1' OR `bin` IS NULL)")
        expect(ids(await open({ ...view, orderBy: 'id' }))).toEqual([3, 4, 5])
        // A column that cannot hold NULL needs no such care.
        expect((await filtered(table.columns[1], 'bolt', true)).where).toBe("`sku` <> 'bolt'")
      })

      it('asks for NULL, and for anything but NULL', async () => {
        const qty = (await open(all)).columns[3]
        expect(ids(await open(await filtered(qty, null)))).toEqual([3])
        expect(ids(await open({ ...(await filtered(qty, null, true)), orderBy: 'id' }))).toEqual([1, 2, 4, 5])
      })

      it('adds to the filter that is there without changing what it meant', async () => {
        const qty = (await open(all)).columns[3]
        const view = await filtered(qty, 5, false, { where: "bin = 'A1' OR bin = 'B2'", orderBy: 'id DESC' })
        expect(view).toEqual({ where: "(bin = 'A1' OR bin = 'B2') AND `qty` = 5", orderBy: 'id DESC' })
        // Without the brackets the nut would be here too.
        expect(ids(await open(view))).toEqual([4, 1])

        // A comment at the end of what is there stays at the end, after the bracket has closed.
        const noted = await filtered(qty, 5, false, { where: "bin = 'A1' OR bin = 'B2' -- two bins", orderBy: 'id DESC' })
        expect(noted.where).toBe("(bin = 'A1' OR bin = 'B2') AND `qty` = 5 -- two bins")
        expect(ids(await open(noted))).toEqual([4, 1])
      })

      it('will not look for a row by an approximate number', async () => {
        const table = await open(all)
        const weight = table.columns.findIndex((item) => item.name === 'weight')
        await expect(filtered(table.columns[weight], table.rows[0][weight])).rejects.toThrow(/approximate numbers \(FLOAT\)/)
      })

      it('orders by one column either way, and stops', async () => {
        const qty = (await open(all)).columns[3]
        const sorted = (direction: 'asc' | 'desc' | null, from = all) =>
          session.changeView(from, { kind: 'sort', column: qty, direction })

        const up = await sorted('asc')
        expect(up).toEqual({ where: '', orderBy: '`qty`' })
        expect((await open(up)).rows.map((row) => row[3])).toEqual([null, 0, 5, 5, 12])
        const down = await sorted('desc', { where: 'qty IS NOT NULL', orderBy: '`qty`' })
        expect(down).toEqual({ where: 'qty IS NOT NULL', orderBy: '`qty` DESC' })
        expect((await open(down)).rows.map((row) => row[3])).toEqual([12, 5, 5, 0])
        expect(await sorted(null, down)).toEqual({ where: 'qty IS NOT NULL', orderBy: '' })
      })

      it('keeps a comment in the filter from swallowing the order', async () => {
        const result = await open({ where: 'qty > 0 -- in stock', orderBy: 'qty DESC, id' })
        expect(result.rows.map((row) => row[1])).toEqual(['nut', 'bolt', 'screw'])
      })

      it('leaves a condition that makes no sense for the server to refuse', async () => {
        const result = await session.execute(await session.tableQuery(stock, { where: 'colour = 1', orderBy: '' }), options)
        expect(result).toMatchObject({ kind: 'error', code: 'ER_BAD_FIELD_ERROR' })
      })
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
