/** How statements are written. These need no server; `mysql.test.ts` runs the same statements against one. */
import { describe, expect, it } from 'vitest'
import type { EditRequest, ResultColumn } from '@shared/driver'
import { editStatements, isEditStatement, isQuery, literal, quoteIdentifier, quoteString, tableQuery } from './sql'

const usual = { backslashEscapes: true }
const literalBackslash = { backslashEscapes: false }

function column(name: string, kind: ResultColumn['kind'], dbType: string, stored = name): ResultColumn {
  return { name, kind, dbType, primaryKey: false, source: { database: 'shop', table: 'items', column: stored } }
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
    editing: { table: { database: 'shop', table: 'items' }, key: [0], editable: [0, 1, 2], nullable: [1], ...over },
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

  it('refuses a change the result does not allow', () => {
    const change = (column: number, value: string | null): EditRequest['changes'] => [
      { kind: 'update', key: [1], set: [{ column, value }] },
    ]
    expect(() => editStatements(request(change(2, '1'), { editable: [1] }), usual)).toThrow(/`price` cannot be changed/)
    expect(() => editStatements(request(change(2, null)), usual)).toThrow(/`price` does not accept NULL/)
    expect(() => editStatements(request(change(2, 'cheap')), usual)).toThrow(/is not a number/)
  })
})

describe('telling a planned change from other statements', () => {
  it('knows the statements it writes', () => {
    const request: EditRequest = {
      columns: [id, title],
      editing: { table: { database: 'shop', table: 'items' }, key: [0], editable: [1], nullable: [] },
      changes: [
        { kind: 'update', key: [1], set: [{ column: 1, value: 'x' }] },
        { kind: 'delete', key: [2] },
      ],
    }
    expect(editStatements(request, usual).every(isEditStatement)).toBe(true)
  })

  it('rejects statements that could do more than change a row', () => {
    expect(isEditStatement('ALTER TABLE items ADD COLUMN x INT')).toBe(false)
    expect(isEditStatement('SELECT * FROM items')).toBe(false)
    expect(isEditStatement('DROP TABLE items')).toBe(false)
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
