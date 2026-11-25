/** How statements are written. These need no server; `mysql.test.ts` runs the same statements against one. */
import { describe, expect, it } from 'vitest'
import type { EditRequest, ResultColumn } from '@shared/driver'
import {
  andCondition,
  changedView,
  columnTest,
  editStatements,
  givesNameAway,
  isEditStatement,
  isInsert,
  isQuery,
  lineCommentStart,
  literal,
  quoteIdentifier,
  quoteString,
  tableQuery,
  tokenize,
} from './sql'

const usual = { backslashEscapes: true }
const literalBackslash = { backslashEscapes: false }

function column(name: string, kind: ResultColumn['kind'], dbType: string, stored = name): ResultColumn {
  return {
    name,
    kind,
    dbType,
    primaryKey: false,
    nullable: true,
    source: { database: 'shop', table: 'items', column: stored },
  }
}

const id = column('id', 'number', 'BIGINT UNSIGNED')
const title = column('title', 'text', 'VARCHAR')
const price = column('price', 'number', 'DECIMAL')

describe('names', () => {
  it('doubles a backtick inside a name', () => {
    expect(quoteIdentifier('order')).toBe('`order`')
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`')
  })

  it('names a table in full', () => {
    expect(tableQuery({ database: 'my db', table: 'we`ird' })).toBe('SELECT * FROM `my db`.`we``ird`')
  })
})

describe('text', () => {
  it('doubles quotes and backslashes', () => {
    expect(quoteString("it's", usual)).toBe("'it''s'")
    expect(quoteString('C:\\temp', usual)).toBe("'C:\\\\temp'")
    expect(quoteString('{"a": "say \\"hi\\""}', usual)).toBe('\'{"a": "say \\\\"hi\\\\""}\'')
  })

  it('leaves a backslash alone when the session treats it as an ordinary character', () => {
    expect(quoteString('C:\\temp', literalBackslash)).toBe("'C:\\temp'")
    expect(quoteString("it's", literalBackslash)).toBe("'it''s'")
  })

  it('keeps line breaks and tabs as typed', () => {
    expect(quoteString('one\n\ttwo', usual)).toBe("'one\n\ttwo'")
  })

  it('writes an empty string and NULL differently', () => {
    expect(literal('', title, usual)).toBe("''")
    expect(literal(null, title, usual)).toBe('NULL')
  })
})

describe('numbers', () => {
  it('writes them bare, with every digit', () => {
    expect(literal('9007199254740993', id, usual)).toBe('9007199254740993')
    expect(literal('12345678901234.5678', price, usual)).toBe('12345678901234.5678')
    expect(literal(' -0.50 ', price, usual)).toBe('-0.50')
    expect(literal(42, id, usual)).toBe('42')
  })

  it('refuses text for a number column instead of letting the server guess', () => {
    expect(() => literal('twelve', price, usual)).toThrow(/“twelve” is not a number/)
    expect(() => literal('', price, usual)).toThrow(/is not a number/)
    expect(() => literal('1; DROP TABLE items', id, usual)).toThrow(/is not a number/)
  })

  it('quotes digits that belong to a text column', () => {
    expect(literal('007', title, usual)).toBe("'007'")
  })
})

describe('binary values', () => {
  const token = column('token', 'binary', 'BINARY')

  it('writes one that was loaded whole as hex', () => {
    expect(literal({ type: 'binary', bytes: 4, preview: 'deadbeef' }, token, usual)).toBe("X'DEADBEEF'")
  })

  it('refuses one that was only loaded in part', () => {
    expect(() => literal({ type: 'binary', bytes: 64, preview: 'deadbeef' }, token, usual)).toThrow(
      /longer than was loaded/,
    )
  })

  it('refuses anything that is not hex', () => {
    expect(() => literal({ type: 'binary', bytes: 4, preview: "00' OR '" }, token, usual)).toThrow(
      /cannot be written/,
    )
  })
})

describe('statements for staged changes', () => {
  const request = (changes: EditRequest['changes'], over: Partial<EditRequest['editing']> = {}): EditRequest => ({
    columns: [id, title, price],
    editing: {
      table: { database: 'shop', table: 'items' },
      key: [0],
      editable: [0, 1, 2],
      nullable: [1],
      adding: { required: [2], auto: [0] },
      ...over,
    },
    changes,
  })

  it('writes one UPDATE per row, naming the row by its key', () => {
    const statements = editStatements(
      request([
        {
          kind: 'update',
          key: ['9007199254740993'],
          set: [
            { column: 1, value: "it's" },
            { column: 2, value: '9.50' },
          ],
        },
        { kind: 'update', key: [2], set: [{ column: 1, value: null }] },
      ]),
      usual,
    )
    expect(statements).toEqual([
      "UPDATE `shop`.`items` SET `title` = 'it''s', `price` = 9.50 WHERE `id` = 9007199254740993",
      'UPDATE `shop`.`items` SET `title` = NULL WHERE `id` = 2',
    ])
  })

  it('writes a DELETE for a row marked to be deleted', () => {
    expect(editStatements(request([{ kind: 'delete', key: [7] }]), usual)).toEqual([
      'DELETE FROM `shop`.`items` WHERE `id` = 7',
    ])
  })

  it('uses every column of a key made of several', () => {
    const statements = editStatements(
      request([{ kind: 'delete', key: [7, 'a b'] }], { key: [0, 1] }),
      usual,
    )
    expect(statements).toEqual(["DELETE FROM `shop`.`items` WHERE `id` = 7 AND `title` = 'a b'"])
  })

  it('uses the name a column has in the table, not the one the query gave it', () => {
    const renamed: EditRequest = {
      columns: [id, column('label', 'text', 'VARCHAR', 'title')],
      editing: { table: { database: 'shop', table: 'items' }, key: [0], editable: [1], nullable: [] },
      changes: [{ kind: 'update', key: [1], set: [{ column: 1, value: 'x' }] }],
    }
    expect(editStatements(renamed, usual)).toEqual(["UPDATE `shop`.`items` SET `title` = 'x' WHERE `id` = 1"])
  })

  it('refuses a row it could not find again', () => {
    expect(() => editStatements(request([{ kind: 'delete', key: [null] }]), usual)).toThrow(/is NULL/)
    expect(() => editStatements(request([{ kind: 'delete', key: [] }]), usual)).toThrow(/which row/)
  })

  it('refuses two changes to the same row', () => {
    const twice = request([
      { kind: 'update', key: [1], set: [{ column: 1, value: 'first' }] },
      { kind: 'update', key: [1], set: [{ column: 1, value: 'second' }] },
    ])
    expect(() => editStatements(twice, usual)).toThrow(/same row of `items`/)
  })

  it('writes an INSERT that names only the columns that were given a value', () => {
    const statements = editStatements(
      request([
        {
          kind: 'insert',
          set: [
            { column: 1, value: "it's" },
            { column: 2, value: '9.50' },
          ],
        },
        { kind: 'insert', set: [{ column: 0, value: '9007199254740993' }, { column: 1, value: null }] },
      ]),
      usual,
    )
    expect(statements).toEqual([
      "INSERT INTO `shop`.`items` (`title`, `price`) VALUES ('it''s', 9.50)",
      'INSERT INTO `shop`.`items` (`id`, `title`) VALUES (9007199254740993, NULL)',
    ])
  })

  it('writes a row that was given no values at all, which takes every default', () => {
    expect(editStatements(request([{ kind: 'insert', set: [] }]), usual)).toEqual([
      'INSERT INTO `shop`.`items` () VALUES ()',
    ])
  })

  it('keeps the order the changes were given in', () => {
    const statements = editStatements(
      request([
        { kind: 'delete', key: [7] },
        { kind: 'insert', set: [{ column: 1, value: 'new' }] },
      ]),
      usual,
    )
    expect(statements.map((statement) => statement.split(' ')[0])).toEqual(['DELETE', 'INSERT'])
  })

  it('refuses a new row the result does not allow', () => {
    const add = (column: number, value: string | null): EditRequest['changes'] => [
      { kind: 'insert', set: [{ column, value }] },
    ]
    expect(() => editStatements(request(add(2, '1'), { editable: [1] }), usual)).toThrow(/`price` cannot be changed/)
    expect(() => editStatements(request(add(2, null)), usual)).toThrow(/`price` does not accept NULL/)
    expect(() => editStatements(request(add(2, 'cheap')), usual)).toThrow(/is not a number/)
    expect(() =>
      editStatements(
        request(
          [
            {
              kind: 'insert',
              set: [
                { column: 1, value: 'a' },
                { column: 1, value: 'b' },
              ],
            },
          ],
        ),
        usual,
      ),
    ).toThrow(/`title` is given a value twice/)
    // A result that cannot add rows says why, and the driver holds to it.
    const closed = { adding: undefined, cannotAdd: 'To add rows here, add `sku` to the query.' }
    expect(() => editStatements(request(add(1, 'x'), closed), usual)).toThrow(/add `sku` to the query/)
  })

  it('refuses a change the result does not allow', () => {
    const change = (column: number, value: string | null): EditRequest['changes'] => [
      { kind: 'update', key: [1], set: [{ column, value }] },
    ]
    expect(() => editStatements(request(change(2, '1'), { editable: [1] }), usual)).toThrow(/`price` cannot be changed/)
    expect(() => editStatements(request(change(2, null)), usual)).toThrow(/`price` does not accept NULL/)
    expect(() => editStatements(request(change(2, 'cheap')), usual)).toThrow(/is not a number/)
  })
})

describe('the statement that opens a table', () => {
  const items = { database: 'shop', table: 'items' }

  it('reads the table under its own name, with nothing added when there is no view', () => {
    expect(tableQuery(items)).toBe('SELECT * FROM `shop`.`items`')
    expect(tableQuery(items, { where: '  ', orderBy: '' })).toBe('SELECT * FROM `shop`.`items`')
  })

  it('puts each part of a view on a line of its own', () => {
    expect(tableQuery(items, { where: "title LIKE 'a%'", orderBy: 'price DESC, id' })).toBe(
      "SELECT * FROM `shop`.`items`\nWHERE title LIKE 'a%'\nORDER BY price DESC, id",
    )
    expect(tableQuery(items, { where: '', orderBy: 'id' })).toBe('SELECT * FROM `shop`.`items`\nORDER BY id')
  })

  it('keeps a comment typed after a condition from swallowing the order', () => {
    const statement = tableQuery(items, { where: 'price > 5 -- the dear ones', orderBy: 'id' })
    expect(statement.split('\n')).toEqual(['SELECT * FROM `shop`.`items`', 'WHERE price > 5 -- the dear ones', 'ORDER BY id'])
  })

  it('drops a semicolon typed out of habit', () => {
    expect(tableQuery(items, { where: 'price > 5; ', orderBy: 'id;' })).toBe(
      'SELECT * FROM `shop`.`items`\nWHERE price > 5\nORDER BY id',
    )
  })
})

describe('a condition written from a cell', () => {
  const required: ResultColumn = { ...title, nullable: false }

  it('compares numbers bare and text quoted', () => {
    expect(columnTest(id, '9007199254740993', false, usual)).toBe('`id` = 9007199254740993')
    expect(columnTest(price, '9.50', false, usual)).toBe('`price` = 9.50')
    expect(columnTest(title, "it's", false, usual)).toBe("`title` = 'it''s'")
    expect(columnTest(title, 'C:\\temp', false, literalBackslash)).toBe("`title` = 'C:\\temp'")
  })

  it('uses the name the column has in the table', () => {
    expect(columnTest(column('label', 'text', 'VARCHAR', 'title'), 'x', false, usual)).toBe("`title` = 'x'")
  })

  it('asks for NULL with IS, never with =', () => {
    expect(columnTest(title, null, false, usual)).toBe('`title` IS NULL')
    expect(columnTest(title, null, true, usual)).toBe('`title` IS NOT NULL')
  })

  it('keeps the rows that hold NULL when a value is excluded', () => {
    expect(columnTest(title, 'x', true, usual)).toBe("(`title` <> 'x' OR `title` IS NULL)")
    expect(columnTest(required, 'x', true, usual)).toBe("`title` <> 'x'")
  })

  it('reads the value as JSON for a JSON column', () => {
    const tags = column('tags', 'json', 'JSON')
    expect(columnTest(tags, '["a", "b"]', false, usual)).toBe('`tags` = CAST(\'["a", "b"]\' AS JSON)')
  })

  it('refuses what a row cannot be found by', () => {
    expect(() => columnTest(column('weight', 'number', 'FLOAT'), 1.1, false, usual)).toThrow(/approximate numbers/)
    expect(() => columnTest(column('weight', 'number', 'DOUBLE'), '1.1', true, usual)).toThrow(/approximate numbers/)
    expect(() => columnTest({ ...title, source: undefined }, 'x', false, usual)).toThrow(/not stored in the table/)
    expect(() => columnTest(price, 'cheap', false, usual)).toThrow(/is not a number/)
    expect(() =>
      columnTest(column('token', 'binary', 'BINARY'), { type: 'binary', bytes: 64, preview: 'ab' }, false, usual),
    ).toThrow(/longer than was loaded/)
  })
})

describe('adding a condition to a filter', () => {
  const and = (where: string, condition: string) => andCondition(where, condition, usual)

  it('stands alone when there is nothing yet', () => {
    expect(and('', '`a` = 1')).toBe('`a` = 1')
    expect(and('  ; ', '`a` = 1')).toBe('`a` = 1')
  })

  it('goes after what is there', () => {
    expect(and("title LIKE 'a%'", '`a` = 1')).toBe("title LIKE 'a%' AND `a` = 1")
    expect(and('a BETWEEN 1 AND 2', '`b` = 3')).toBe('a BETWEEN 1 AND 2 AND `b` = 3')
  })

  it('brackets what is there when it holds an OR, which would otherwise change meaning', () => {
    expect(and('a = 1 OR b = 2', '`c` = 3')).toBe('(a = 1 OR b = 2) AND `c` = 3')
    expect(and('a = 1 or b = 2', '`c` = 3')).toBe('(a = 1 or b = 2) AND `c` = 3')
    expect(and('a = 1 || b = 2', '`c` = 3')).toBe('(a = 1 || b = 2) AND `c` = 3')
    expect(and('a XOR b', '`c` = 3')).toBe('(a XOR b) AND `c` = 3')
    // Not an OR, only a name that contains one.
    expect(and('floor = 1', '`c` = 3')).toBe('floor = 1 AND `c` = 3')
  })

  it('goes in before a comment at the end, which would swallow it', () => {
    expect(and('a = 1 -- for now', '`c` = 3')).toBe('a = 1 AND `c` = 3 -- for now')
    expect(and('a = 1 # for now', '`c` = 3')).toBe('a = 1 AND `c` = 3 # for now')
    expect(and('a = 1; -- for now', '`c` = 3')).toBe('a = 1 AND `c` = 3 -- for now')
    expect(and('-- everything, for now', '`c` = 3')).toBe('`c` = 3 -- everything, for now')
  })

  it('closes its bracket before that comment too', () => {
    // After the comment, the bracket would be part of it, and the statement would not parse.
    expect(and('a = 1 OR b = 2 -- note', '`c` = 3')).toBe('(a = 1 OR b = 2) AND `c` = 3 -- note')
    expect(and('a = 1 OR b = 2 #note', '`c` = 3')).toBe('(a = 1 OR b = 2) AND `c` = 3 #note')
  })

  it('leaves a comment that ends by itself where it is', () => {
    expect(and('a = 1 /* hm */', '`c` = 3')).toBe('a = 1 /* hm */ AND `c` = 3')
    expect(and('a = 1 /* -- not the end */ OR b = 2', '`c` = 3')).toBe('(a = 1 /* -- not the end */ OR b = 2) AND `c` = 3')
  })

  it('does not say the same thing twice', () => {
    expect(and('`a` = 1 AND `b` = 2', '`b` = 2')).toBe('`a` = 1 AND `b` = 2')
    expect(and('`a` = 1', '`a` = 1')).toBe('`a` = 1')
    expect(and('`a` = 1 -- note', '`a` = 1')).toBe('`a` = 1 -- note')
  })
})

describe('finding a comment that runs to the end of the line', () => {
  it('finds one where MySQL would', () => {
    expect(lineCommentStart('a = 1 -- note', usual)).toBe(6)
    expect(lineCommentStart('a = 1 --', usual)).toBe(6)
    expect(lineCommentStart('a = 1 #note', usual)).toBe(6)
    expect(lineCommentStart('a = 1', usual)).toBe(-1)
  })

  it('is not fooled by the same characters inside text, a name or a closed comment', () => {
    expect(lineCommentStart("note = 'a -- b' AND c = '#fff'", usual)).toBe(-1)
    expect(lineCommentStart('note = "a -- b"', usual)).toBe(-1)
    expect(lineCommentStart('`a#b` = 1 AND `c -- d` = 2', usual)).toBe(-1)
    expect(lineCommentStart('a = 1 /* -- # */ AND b = 2', usual)).toBe(-1)
    expect(lineCommentStart("note = 'it''s -- fine'", usual)).toBe(-1)
    // And finds the real one after them.
    expect(lineCommentStart("note = 'a -- b' -- real", usual)).toBe(16)
  })

  it('reads two minus signs with no space after them as arithmetic', () => {
    expect(lineCommentStart('a = 1 --2', usual)).toBe(-1)
  })

  it('reads a backslash the way the session does', () => {
    // With escapes, the quote after the backslash is text and the string goes on. Without, it ends there.
    expect(lineCommentStart("note = 'it\\'s -- fine'", usual)).toBe(-1)
    expect(lineCommentStart("note = 'a\\' -- note", literalBackslash)).toBe(12)
  })
})

describe('a view changed from the grid', () => {
  const view = { where: "title LIKE 'a%' ", orderBy: 'price DESC' }

  it('narrows the rows and leaves the order alone', () => {
    expect(changedView(view, { kind: 'filter', column: price, value: '9.50', exclude: false }, usual)).toEqual({
      where: "title LIKE 'a%' AND `price` = 9.50",
      orderBy: 'price DESC',
    })
  })

  it('orders by one column, replacing the order there was, and leaves the filter alone', () => {
    const sorted = (direction: 'asc' | 'desc' | null) =>
      changedView(view, { kind: 'sort', column: column('label', 'text', 'VARCHAR', 'ti`tle'), direction }, usual)
    expect(sorted('asc')).toEqual({ where: "title LIKE 'a%'", orderBy: '`ti``tle`' })
    expect(sorted('desc')).toEqual({ where: "title LIKE 'a%'", orderBy: '`ti``tle` DESC' })
    expect(sorted(null)).toEqual({ where: "title LIKE 'a%'", orderBy: '' })
  })
})

describe('telling a planned change from other statements', () => {
  it('knows the statements it writes', () => {
    const request: EditRequest = {
      columns: [id, title],
      editing: {
        table: { database: 'shop', table: 'items' },
        key: [0],
        editable: [1],
        nullable: [],
        adding: { required: [], auto: [] },
      },
      changes: [
        { kind: 'update', key: [1], set: [{ column: 1, value: 'x' }] },
        { kind: 'delete', key: [2] },
        { kind: 'insert', set: [{ column: 1, value: 'x' }] },
        { kind: 'insert', set: [] },
      ],
    }
    const statements = editStatements(request, usual)
    expect(statements.every(isEditStatement)).toBe(true)
    expect(statements.map(isInsert)).toEqual([false, false, true, true])
  })

  it('rejects statements that could do more than change a row', () => {
    expect(isEditStatement('ALTER TABLE items ADD COLUMN x INT')).toBe(false)
    expect(isEditStatement('SELECT * FROM items')).toBe(false)
    expect(isEditStatement('DROP TABLE items')).toBe(false)
    expect(isEditStatement('INSERT IGNORE INTO `items` () VALUES ()')).toBe(false)
    expect(isEditStatement('REPLACE INTO `items` () VALUES ()')).toBe(false)
  })
})

describe('taking a statement apart', () => {
  const texts = (sql: string, mode = usual) => tokenize(sql, mode).map((token) => token.text)

  it('leaves out comments and white space', () => {
    expect(texts('SELECT a, -- one\n b # two\n FROM /* three */ t')).toEqual(['SELECT', 'a', ',', 'b', 'FROM', 't'])
  })

  it('reads two minus signs with nothing after them as arithmetic', () => {
    expect(texts('SELECT 5--3')).toEqual(['SELECT', '5', '-', '-', '3'])
  })

  it('keeps what a comment for the server holds', () => {
    expect(texts('SELECT 1 /*!50000 AS people */ FROM t')).toEqual(['SELECT', '1', 'AS', 'people', 'FROM', 't'])
  })

  it('tells the three kinds of quote apart and takes the quotes off', () => {
    expect(tokenize('`a``b` "c""d" \'e\'\'f\'', usual)).toEqual([
      { kind: 'name', text: 'a`b' },
      { kind: 'text', text: 'c"d' },
      { kind: 'string', text: "e'f" },
    ])
  })

  it('reads a backslash the way the session does', () => {
    const sql = "SELECT 'it\\'s', x"
    expect(texts(sql, usual)).toEqual(['SELECT', "it's", ',', 'x'])
    // Taken literally, the backslash ends nothing, so the string ends at the second quote.
    expect(texts(sql, literalBackslash)).toEqual(['SELECT', 'it\\', 's', ', x'])
  })
})

describe('a table name given to something else', () => {
  it('is a subquery in brackets that is called by it', () => {
    expect(givesNameAway('SELECT * FROM (SELECT ref AS id FROM people) AS people', 'people')).toBe(true)
    expect(givesNameAway('SELECT * FROM (SELECT ref AS id FROM people) people', 'people')).toBe(true)
    expect(givesNameAway('SELECT * FROM (SELECT ref AS id FROM people) AS `People`', 'people')).toBe(true)
    // Under ANSI_QUOTES double quotes hold a name.
    expect(givesNameAway('SELECT * FROM (SELECT ref AS id FROM people) AS "people"', 'people')).toBe(true)
  })

  it('is a WITH clause that is called by it', () => {
    expect(givesNameAway('WITH people AS (SELECT ref AS id FROM people) SELECT * FROM people', 'people')).toBe(true)
    expect(givesNameAway('WITH a AS (SELECT 1), people AS (SELECT 2) SELECT * FROM people', 'people')).toBe(true)
    expect(givesNameAway('WITH RECURSIVE people (id, name) AS (SELECT 1, 2) SELECT * FROM people', 'people')).toBe(true)
  })

  it('is not the table read directly, however often it is named', () => {
    expect(givesNameAway('SELECT * FROM people', 'people')).toBe(false)
    expect(givesNameAway('SELECT people.* FROM shop.people WHERE people.id > 1', 'people')).toBe(false)
    expect(givesNameAway('SELECT * FROM people WHERE id IN (SELECT boss FROM people)', 'people')).toBe(false)
    expect(givesNameAway('SELECT * FROM people AS people JOIN orders o ON (o.person = people.id)', 'people')).toBe(false)
    expect(givesNameAway('WITH others AS (SELECT 1) SELECT * FROM people', 'people')).toBe(false)
  })

  it('is not a name that is only mentioned in a string or a comment', () => {
    expect(givesNameAway("SELECT * FROM people WHERE note = ') AS people'", 'people')).toBe(false)
    expect(givesNameAway('SELECT * FROM people -- ) AS people', 'people')).toBe(false)
  })

  it('is found however the session reads a backslash', () => {
    // Read with backslash escapes, the string runs on and hides the alias. The session may not read it so.
    const sql = "SELECT * FROM (SELECT ref AS id, '\\' AS x FROM people) AS people -- '"
    expect(givesNameAway(sql, 'people')).toBe(true)
  })
})

describe('telling a query from other statements', () => {
  it('accepts statements that only read', () => {
    expect(isQuery('SELECT 1')).toBe(true)
    expect(isQuery('  select * from t')).toBe(true)
    expect(isQuery('(SELECT 1) UNION (SELECT 2)')).toBe(true)
    expect(isQuery('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(isQuery('TABLE t')).toBe(true)
    expect(isQuery('-- newest first\n/* all of them */ SELECT * FROM t')).toBe(true)
  })

  it('rejects the rest', () => {
    expect(isQuery('CALL report()')).toBe(false)
    expect(isQuery('SHOW TABLES')).toBe(false)
    expect(isQuery('selectively')).toBe(false)
    expect(isQuery('-- SELECT 1\nEXPLAIN SELECT 1')).toBe(false)
  })
})
