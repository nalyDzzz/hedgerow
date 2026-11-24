/**
 * How MySQL writes names and values in a statement. Every statement the app
 * generates for MySQL is put together here, so quoting lives in one place.
 */
import type { CellChange, CellValue, EditRequest, ResultColumn, TableRef } from '@shared/driver'
import { DriverError } from '../error'

/** The parts of a session's sql_mode that change how a statement has to be written. */
export interface SqlMode {
  /** False under NO_BACKSLASH_ESCAPES, where a backslash is an ordinary character. */
  backslashEscapes: boolean
}

export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

export function quoteTable(table: TableRef): string {
  return `${quoteIdentifier(table.database)}.${quoteIdentifier(table.table)}`
}

/**
 * A string literal that reads back as exactly `text`. Only what has to be
 * escaped is: line breaks and tabs stay as they are, so the statement shows the
 * value the way it was typed.
 */
export function quoteString(text: string, mode: SqlMode): string {
  let body = text
  if (mode.backslashEscapes) body = body.replaceAll('\\', '\\\\').replaceAll('\0', '\\0')
  return `'${body.replaceAll("'", "''")}'`
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i
const HEX = /^0x[0-9a-f]+$/i

/**
 * Writes a value so that MySQL reads it as that value for that column. Numbers
 * are written bare: compared as text, MySQL would turn a large integer into a
 * double and lose its last digits.
 */
export function literal(value: CellValue, column: ResultColumn, mode: SqlMode): string {
  if (value === null) return 'NULL'

  if (typeof value === 'object') {
    // Only the first bytes of a binary value are loaded. If that is not all of it, the value is unknown.
    if (value.preview.length !== value.bytes * 2 || !/^[0-9a-f]*$/i.test(value.preview)) {
      throw new DriverError(
        `The value of \`${column.name}\` is binary and longer than was loaded, so it cannot be written in a statement.`,
        'VALUE_INCOMPLETE',
      )
    }
    return `X'${value.preview.toUpperCase()}'`
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DriverError(`${value} cannot be stored in \`${column.name}\`.`, 'NOT_A_NUMBER')
    }
    return String(value)
  }

  if (column.kind === 'number') {
    const text = value.trim()
    if (NUMBER.test(text) || (column.dbType === 'BIT' && HEX.test(text))) return text
    throw new DriverError(
      `“${value}” is not a number, and \`${column.name}\` (${column.dbType}) holds numbers.`,
      'NOT_A_NUMBER',
    )
  }

  return quoteString(value, mode)
}

export function tableQuery(table: TableRef): string {
  return `SELECT * FROM ${quoteTable(table)}`
}

/**
 * One statement per change, in the order given. A change to a row that exists
 * names it by the result's key, so it can only ever reach that row. A new row
 * names the columns that were given a value and leaves the rest to the table.
 */
export function editStatements({ columns, editing, changes }: EditRequest, mode: SqlMode): string[] {
  const table = quoteTable(editing.table)

  const stored = (index: number): string => {
    const source = columns[index]?.source
    if (!source) throw new DriverError('A change refers to a column that is not stored in the table.', 'BAD_CHANGE')
    return quoteIdentifier(source.column)
  }

  /** The columns a change gives a value, each with that value written out. */
  const assignments = (set: CellChange[]): { name: string; value: string }[] => {
    const seen = new Set<string>()
    return set.map(({ column, value }) => {
      const name = columns[column]?.name ?? `column ${column + 1}`
      if (!editing.editable.includes(column)) {
        throw new DriverError(`\`${name}\` cannot be changed.`, 'BAD_CHANGE')
      }
      if (value === null && !editing.nullable.includes(column)) {
        throw new DriverError(`\`${name}\` does not accept NULL.`, 'BAD_CHANGE')
      }
      const target = stored(column)
      if (seen.has(target)) {
        throw new DriverError(`${target} is given a value twice in the same row.`, 'BAD_CHANGE')
      }
      seen.add(target)
      return { name: target, value: literal(value, columns[column], mode) }
    })
  }

  const changed = new Set<string>()

  return changes.map((change) => {
    if (change.kind === 'insert') {
      if (!editing.adding) {
        throw new DriverError(editing.cannotAdd ?? 'Rows cannot be added to this result.', 'BAD_CHANGE')
      }
      // With no column named, every column takes its default.
      const given = assignments(change.set)
      const names = given.map(({ name }) => name).join(', ')
      return `INSERT INTO ${table} (${names}) VALUES (${given.map(({ value }) => value).join(', ')})`
    }

    if (change.key.length !== editing.key.length) {
      throw new DriverError('A change does not say which row it is for.', 'BAD_CHANGE')
    }
    // Two statements for one row would both succeed, and the second would undo part of the first.
    const row = JSON.stringify(change.key)
    if (changed.has(row)) {
      throw new DriverError(
        `Two of these changes are to the same row of \`${editing.table.table}\`, so one would overwrite the other.`,
        'BAD_CHANGE',
      )
    }
    changed.add(row)
    const where = editing.key
      .map((index, position) => {
        const value = change.key[position]
        if (value === null) {
          throw new DriverError(
            `A row whose \`${columns[index].name}\` is NULL cannot be told from other rows, so it cannot be changed.`,
            'NO_KEY',
          )
        }
        return `${stored(index)} = ${literal(value, columns[index], mode)}`
      })
      .join(' AND ')

    if (change.kind === 'delete') return `DELETE FROM ${table} WHERE ${where}`

    if (change.set.length === 0) throw new DriverError('A change sets nothing.', 'BAD_CHANGE')
    const set = assignments(change.set)
      .map(({ name, value }) => `${name} = ${value}`)
      .join(', ')

    return `UPDATE ${table} SET ${set} WHERE ${where}`
  })
}

/** True for a statement `editStatements` writes. A save runs nothing else. */
export function isEditStatement(sql: string): boolean {
  return /^(?:UPDATE|DELETE FROM|INSERT INTO) `/.test(sql)
}

/** True for one that adds a row. */
export function isInsert(sql: string): boolean {
  return sql.startsWith('INSERT INTO ')
}

const LEADING_SPACE_AND_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/

/** True for a statement that only reads: one it is safe to run again to show what a save stored. */
export function isQuery(sql: string): boolean {
  const start = LEADING_SPACE_AND_COMMENTS.exec(sql)?.[0].length ?? 0
  return /^(?:\(|(?:select|table|with)\b)/i.test(sql.slice(start))
}
