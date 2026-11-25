/**
 * How MySQL writes names and values in a statement. Every statement the app
 * generates for MySQL is put together here, so quoting lives in one place.
 */
import type {
  CellChange,
  CellValue,
  EditRequest,
  ResultColumn,
  TableRef,
  TableView,
  ViewChange,
} from '@shared/driver'
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

/** What a person typed after WHERE or ORDER BY, without the space and the semicolon that may trail it. */
function fragment(text: string): string {
  return text.trim().replace(/[;\s]+$/, '')
}

/**
 * Reads a table under its own name, never an alias, so the result can be
 * edited. Each part of a view starts a line of its own: a `--` comment typed at
 * the end of a condition then ends with that line, and cannot swallow the order.
 */
export function tableQuery(table: TableRef, view?: TableView): string {
  const where = fragment(view?.where ?? '')
  const orderBy = fragment(view?.orderBy ?? '')
  return (
    `SELECT * FROM ${quoteTable(table)}` +
    (where ? `\nWHERE ${where}` : '') +
    (orderBy ? `\nORDER BY ${orderBy}` : '')
  )
}

/** The stored column a result column shows, quoted. A view can only name what the table holds. */
function storedName(column: ResultColumn): string {
  if (!column.source) {
    throw new DriverError(
      `\`${column.name}\` is worked out by the query and not stored in the table, so it cannot be used here.`,
      'NOT_STORED',
    )
  }
  return quoteIdentifier(column.source.column)
}

/** The test that a column holds a value, or with `exclude` that it does not, as it would stand after WHERE. */
export function columnTest(column: ResultColumn, value: CellValue, exclude: boolean, mode: SqlMode): string {
  const name = storedName(column)
  if (value === null) return `${name} IS ${exclude ? 'NOT ' : ''}NULL`
  if (/^(FLOAT|DOUBLE)/.test(column.dbType)) {
    throw new DriverError(
      `\`${column.name}\` holds approximate numbers (${column.dbType}), and rows cannot be reliably found by one. ` +
        'Type a range into the filter instead.',
      'INEXACT',
    )
  }
  // Compared with plain text, a JSON document matches nothing: the text has to be read as JSON too.
  const written = column.kind === 'json' ? `CAST(${literal(value, column, mode)} AS JSON)` : literal(value, column, mode)
  if (!exclude) return `${name} = ${written}`
  // A row that holds NULL does not hold this value either, but `<>` alone would drop it.
  return column.nullable ? `(${name} <> ${written} OR ${name} IS NULL)` : `${name} <> ${written}`
}

/**
 * Where a comment that runs to the end of the line starts in a piece of SQL
 * typed on one line, or -1 when it has none. A `--` or `#` inside a string, a
 * quoted name or a closed comment is not one, and neither is `--` with no space
 * after it, which MySQL reads as two minus signs.
 */
export function lineCommentStart(text: string, mode: SqlMode): number {
  /** What has been opened and not closed yet: a quote character, or a block comment. */
  let inside: string | null = null
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (inside === '*/') {
      if (text.startsWith('*/', at)) {
        inside = null
        at += 1
      }
    } else if (inside) {
      // A backslash keeps the next character from ending a string, unless the session takes it literally.
      if (char === '\\' && inside !== '`' && mode.backslashEscapes) at += 1
      else if (char === inside) {
        // Written twice, the quote is part of what it quotes.
        if (text[at + 1] === inside) at += 1
        else inside = null
      }
    } else if (char === "'" || char === '"' || char === '`') {
      inside = char
    } else if (text.startsWith('/*', at)) {
      inside = '*/'
      at += 1
    } else if (char === '#') {
      return at
    } else if (text.startsWith('--', at) && (at + 2 === text.length || /\s/.test(text[at + 2]))) {
      return at
    }
  }
  return -1
}

/** Adds a condition to the ones a view already has, so that all of them must hold. */
export function andCondition(where: string, condition: string, mode: SqlMode): string {
  const existing = fragment(where)
  if (!existing) return condition
  // A comment at the end runs to the end of the line. Anything put after it, a closing
  // bracket included, would be swallowed, so the condition goes in before it.
  const comment = lineCommentStart(existing, mode)
  const said = fragment(comment < 0 ? existing : existing.slice(0, comment))
  const trailing = comment < 0 ? '' : ` ${existing.slice(comment)}`
  if (!said) return `${condition}${trailing}`
  // Asking for the same thing twice changes nothing.
  if (said.split(/\s+AND\s+/i).includes(condition)) return existing
  // AND binds tighter than OR, so what is there keeps its meaning only inside brackets.
  const kept = /\bx?or\b|\|\|/i.test(said) ? `(${said})` : said
  return `${kept} AND ${condition}${trailing}`
}

/** The view after one change asked for in the grid. */
export function changedView(view: TableView, change: ViewChange, mode: SqlMode): TableView {
  if (change.kind === 'sort') {
    const name = storedName(change.column)
    const orderBy = change.direction === null ? '' : change.direction === 'desc' ? `${name} DESC` : name
    return { where: fragment(view.where), orderBy }
  }
  return {
    where: andCondition(view.where, columnTest(change.column, change.value, change.exclude, mode), mode),
    orderBy: fragment(view.orderBy),
  }
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

/** One piece of a statement, as far as finding a name in it needs. */
interface Token {
  /**
   * A bare word, a name in backticks, text in double quotes (which is a name
   * too under ANSI_QUOTES), a string in single quotes, or any other character.
   */
  kind: 'word' | 'name' | 'text' | 'string' | 'symbol'
  /** A word or symbol as written. A quoted name or string without its quotes. */
  text: string
}

const WORD = /[\w$\u0080-\uffff]+/y

/**
 * Takes a statement apart into words, quoted things and single characters.
 * Comments and white space are left out, except that what a `/*! ... *\/`
 * comment holds is kept: the server runs it.
 */
export function tokenize(sql: string, mode: SqlMode): Token[] {
  const found: Token[] = []
  let at = 0
  while (at < sql.length) {
    const char = sql[at]
    if (/\s/.test(char)) {
      at += 1
    } else if (char === '#' || (sql.startsWith('--', at) && (at + 2 === sql.length || /\s/.test(sql[at + 2])))) {
      const end = sql.indexOf('\n', at)
      at = end < 0 ? sql.length : end + 1
    } else if (sql.startsWith('/*!', at)) {
      // Only the marker and the version number go. The end of the comment goes below.
      at += 3
      while (/\d/.test(sql[at] ?? '')) at += 1
    } else if (sql.startsWith('/*', at)) {
      const end = sql.indexOf('*/', at + 2)
      at = end < 0 ? sql.length : end + 2
    } else if (sql.startsWith('*/', at)) {
      at += 2
    } else if (char === "'" || char === '"' || char === '`') {
      let text = ''
      let end = at + 1
      for (; end < sql.length; end++) {
        const next = sql[end]
        if (next === '\\' && char !== '`' && mode.backslashEscapes) {
          text += sql[end + 1] ?? ''
          end += 1
        } else if (next === char) {
          // Written twice, the quote is part of what it quotes.
          if (sql[end + 1] !== char) break
          text += char
          end += 1
        } else {
          text += next
        }
      }
      found.push({ kind: char === '`' ? 'name' : char === '"' ? 'text' : 'string', text })
      at = end + 1
    } else {
      WORD.lastIndex = at
      const word = WORD.exec(sql)
      if (word) {
        found.push({ kind: 'word', text: word[0] })
        at += word[0].length
      } else {
        found.push({ kind: 'symbol', text: char })
        at += 1
      }
    }
  }
  return found
}

/**
 * True when a statement gives the name of a table to something else: a
 * subquery in brackets, or a WITH clause. The server then reports what that
 * returns as columns of the table, under whatever names it gave them, so
 * `SELECT ref AS id ...` passes for the table's `id`. Nothing the server says
 * about such a result tells it from the table read directly; only the statement does.
 */
export function givesNameAway(sql: string, name: string): boolean {
  const wanted = name.toLowerCase()
  // Read both ways a session may read a string: a quote that only one of them closes could hide the name.
  return [true, false].some((backslashEscapes) => {
    const list = tokenize(sql, { backslashEscapes })
    const symbol = (at: number, text: string) => list[at]?.kind === 'symbol' && list[at].text === text
    const word = (at: number, text: string) => list[at]?.kind === 'word' && list[at].text.toUpperCase() === text
    /** Where the bracket opened at `at` closes, or past the end if it never does. */
    const closing = (at: number) => {
      let depth = 0
      for (let index = at; index < list.length; index++) {
        if (symbol(index, '(')) depth += 1
        else if (symbol(index, ')') && --depth === 0) return index
      }
      return list.length
    }

    return list.some((token, at) => {
      if (token.kind === 'symbol' || token.kind === 'string' || token.text.toLowerCase() !== wanted) return false
      // `shop.people` is the table, and `people.id` one of its columns.
      if (symbol(at - 1, '.') || symbol(at + 1, '.')) return false
      // (subquery) people, and (subquery) AS people
      if (symbol(at - 1, ')') || (word(at - 1, 'AS') && symbol(at - 2, ')'))) return true
      // WITH people AS (subquery)
      if (word(at + 1, 'AS') && symbol(at + 2, '(')) return true
      // WITH people (id, name) AS (subquery)
      if (symbol(at + 1, '(')) {
        const end = closing(at + 1)
        return word(end + 1, 'AS') && symbol(end + 2, '(')
      }
      return false
    })
  })
}

/**
 * True for a SELECT that writes its rows to a file on the server instead of
 * returning them. The limit on rows returned applies to such a statement too,
 * and would cut the file short without anything saying so.
 */
export function writesFile(sql: string): boolean {
  // Nearly no statement has the words at all, and a long one is not worth taking apart to find that out.
  if (!/\binto\s+(?:outfile|dumpfile)\b/i.test(sql)) return false
  // Read both ways a session may read a string. Wrongly taken for one, a statement only loses its row limit.
  return [true, false].some((backslashEscapes) => {
    const list = tokenize(sql, { backslashEscapes })
    return list.some(
      (token, at) =>
        token.kind === 'word' &&
        token.text.toUpperCase() === 'INTO' &&
        list[at + 1]?.kind === 'word' &&
        /^(OUTFILE|DUMPFILE)$/i.test(list[at + 1].text),
    )
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
