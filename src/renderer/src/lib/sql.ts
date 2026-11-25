import { MySQL, SQLDialect } from '@codemirror/lang-sql'

/**
 * MySQL as the editor reads it. Unlike the dialect it starts from, a backslash
 * keeps a quote from ending a string: `'it\'s'` is one string. That is how
 * MySQL reads it, unless a session sets NO_BACKSLASH_ESCAPES. Read the other
 * way, the end of every such string is misplaced, and with it the place where
 * one statement ends and the next begins.
 */
export const MYSQL = SQLDialect.define({ ...MySQL.spec, backslashEscapes: true })

/** MySQL as a session reads it that has NO_BACKSLASH_ESCAPES set: a backslash is a character like any other. */
const MYSQL_PLAIN_BACKSLASH = SQLDialect.define({ ...MySQL.spec, backslashEscapes: false })

/**
 * The dialect to read a script with, given how the session it will run on
 * reads a backslash in a string. The two readings put the end of `'a\'` in
 * different places, so the editor has to follow the session, not assume.
 */
export function dialectFor(backslashEscapes: boolean): SQLDialect {
  return backslashEscapes ? MYSQL : MYSQL_PLAIN_BACKSLASH
}

/** A parsed script, as the editor keeps one for the text it shows. */
export type SqlTree = ReturnType<typeof MYSQL.language.parser.parse>

/** Where one statement of a script is. */
export interface StatementRange {
  from: number
  /** The end of what is sent to the server. What ends the statement is not part of it. */
  to: number
  /**
   * Just past what ends the statement: the semicolon, or the delimiter a script
   * set. The same as `to` for a statement that nothing ends yet.
   */
  end: number
}

/** One piece of a script: a word, a character that stands alone, or something quoted. */
interface Token {
  from: number
  to: number
  /** A bare word in upper case. Empty for anything else. */
  word: string
  /** A character that stands alone, such as a semicolon or a bracket. Empty for anything else. */
  symbol: string
  /** A comment the server does not read. A statement never starts with one. */
  comment: boolean
  /** A string, a quoted name or a comment: a delimiter found in one does not end a statement. */
  quoted: boolean
}

const WORDS = new Set(['Keyword', 'Identifier', 'Type', 'Builtin', 'Bool', 'Null'])
const QUOTED = new Set(['String', 'QuotedIdentifier', 'LineComment', 'BlockComment'])

/** The tokens of a parsed script, in order. The parser has told strings and comments from the rest. */
function tokensOf(tree: SqlTree, text: string): Token[] {
  const tokens: Token[] = []
  const cursor = tree.cursor()
  for (;;) {
    // Only the leaves are tokens. What they are grouped into is worked out here.
    if (cursor.firstChild()) continue
    const { name, from, to } = cursor
    if (from < to && name !== 'Script' && name !== 'Statement') {
      const piece = text.slice(from, to)
      const comment = name === 'LineComment' || name === 'BlockComment'
      tokens.push({
        from,
        to,
        word: WORDS.has(name) ? piece.toUpperCase() : '',
        symbol: WORDS.has(name) || QUOTED.has(name) ? '' : piece,
        // A comment that starts with `/*!` is one the server runs, so it counts as part of a statement.
        comment: comment && !piece.startsWith('/*!'),
        quoted: QUOTED.has(name),
      })
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return tokens
    }
  }
}

/** The kinds of stored program whose definition can hold statements of its own. */
const PROGRAMS = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'])
/** What else CREATE and ALTER make. Seeing one of these first means it is not a program. */
const OTHER_OBJECTS = new Set([
  'TABLE',
  'VIEW',
  'INDEX',
  'DATABASE',
  'SCHEMA',
  'USER',
  'ROLE',
  'SERVER',
  'TABLESPACE',
  'SEQUENCE',
  'LOGFILE',
  'RESOURCE',
  'INSTANCE',
])
/** Statements that hold other statements, each with semicolons of its own. */
const COMPOUND = new Set(['BEGIN', 'IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'])
/** Words an ordinary statement can begin with. The first of these in a definition is where its body begins. */
const SIMPLE = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'SET',
  'CALL',
  'DO',
  'RETURN',
  'WITH',
  'TRUNCATE',
  'DROP',
  'CREATE',
  'ALTER',
  'SIGNAL',
  'RESIGNAL',
  'GET',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'START',
  'COMMIT',
  'ROLLBACK',
  'LOCK',
  'UNLOCK',
  'ANALYZE',
  'OPTIMIZE',
  'FLUSH',
  'GRANT',
  'REVOKE',
  'RENAME',
  'SHOW',
  'TABLE',
  'VALUES',
  'HANDLER',
  'LOAD',
  'KILL',
])

const END = new Set(['END'])
const IF_PARTS = new Set(['ELSEIF', 'ELSE', 'END'])
const CASE_PARTS = new Set(['WHEN', 'ELSE', 'END'])
const UNTIL = new Set(['UNTIL'])

/**
 * Finds where a statement ends that starts at token `start`, given the tokens
 * of a script with the comments taken out. Gives the place of its semicolon, or
 * the number of tokens if it has none.
 *
 * Usually that is the first semicolon. The definition of a stored procedure,
 * function, trigger or event is the exception: its body can be a block of
 * statements, each ended by a semicolon that is not the end of the definition.
 * So a body is read the way the server reads it, statement inside statement,
 * down to the END that closes it.
 */
function statementEnd(tokens: Token[], start: number): number {
  const count = tokens.length
  const word = (at: number) => tokens[at]?.word ?? ''
  const is = (at: number, symbol: string) => tokens[at]?.symbol === symbol
  const semicolonFrom = (at: number) => {
    while (at < count && !is(at, ';')) at += 1
    return at
  }

  /** Past the bracket that opens at `at` and everything in it. */
  const pastBrackets = (at: number) => {
    let depth = 0
    for (; at < count && !is(at, ';'); at++) {
      if (is(at, '(')) depth += 1
      else if (is(at, ')') && --depth === 0) return at + 1
    }
    return at
  }

  /** The END of the CASE expression that starts at `at`. */
  const caseExpressionEnd = (at: number) => {
    let depth = 0
    for (; at < count && !is(at, ';'); at++) {
      if (word(at) === 'CASE') depth += 1
      else if (word(at) === 'END' && --depth === 0) return at
    }
    return at
  }

  /**
   * The first of `words` from `at` on, outside brackets. This reads past a
   * condition, which may hold a CASE expression with a THEN and an END of its own.
   */
  const until = (at: number, ...words: string[]) => {
    let depth = 0
    for (; at < count && !is(at, ';'); at++) {
      if (is(at, '(')) depth += 1
      else if (is(at, ')')) depth = Math.max(0, depth - 1)
      else if (depth > 0) continue
      else if (words.includes(word(at))) return at
      else if (word(at) === 'CASE') at = caseExpressionEnd(at)
    }
    return at
  }

  /** Past the END at `at`, the word that says what it ends, and a label after it. */
  const pastEnd = (at: number, kind?: string) => {
    if (word(at) !== 'END') return at
    at += 1
    if (kind && word(at) === kind) at += 1
    if (word(at) && !is(at, ';')) at += 1
    return at
  }

  /** Past the statements from `at` on, up to one that starts with a word in `stops`. */
  const pastStatements = (at: number, stops: Set<string>): number => {
    while (at < count && !stops.has(word(at))) {
      const before = at
      at = pastStatement(at)
      if (is(at, ';')) at += 1
      // Whatever is there, it is passed, so that this always comes to an end.
      else if (at === before) at += 1
    }
    return at
  }

  /** Past one statement, not counting its semicolon. */
  const pastStatement = (at: number): number => {
    // A label, as in `retry: LOOP`.
    if (word(at) && is(at + 1, ':')) at += 2
    switch (word(at)) {
      case 'BEGIN':
        return pastEnd(pastStatements(at + 1, END))
      case 'IF': {
        at = until(at + 1, 'THEN') + 1
        for (;;) {
          at = pastStatements(at, IF_PARTS)
          if (word(at) !== 'ELSEIF') break
          at = until(at + 1, 'THEN') + 1
        }
        if (word(at) === 'ELSE') at = pastStatements(at + 1, END)
        return pastEnd(at, 'IF')
      }
      case 'CASE': {
        at = until(at + 1, 'WHEN')
        while (word(at) === 'WHEN') at = pastStatements(until(at + 1, 'THEN') + 1, CASE_PARTS)
        if (word(at) === 'ELSE') at = pastStatements(at + 1, END)
        return pastEnd(at, 'CASE')
      }
      case 'LOOP':
        return pastEnd(pastStatements(at + 1, END), 'LOOP')
      case 'WHILE':
        return pastEnd(pastStatements(until(at + 1, 'DO') + 1, END), 'WHILE')
      case 'REPEAT':
        return pastEnd(until(pastStatements(at + 1, UNTIL) + 1, 'END'), 'REPEAT')
      default: {
        // An ordinary statement runs to its semicolon. The one exception declares a handler,
        // which ends with a statement of its own: DECLARE EXIT HANDLER FOR ... BEGIN ... END.
        let handler = false
        for (; at < count && !is(at, ';'); at++) {
          if (word(at) === 'BEGIN' || (handler && COMPOUND.has(word(at)))) return pastStatement(at)
          if (word(at) === 'HANDLER') handler = true
        }
        return at
      }
    }
  }

  /** Where the body of a definition begins, or -1 if it has none that holds statements. */
  const bodyOf = (kind: string, after: number): number => {
    const stop = semicolonFrom(after)
    let at = after
    if (kind === 'TRIGGER') {
      // CREATE TRIGGER name BEFORE INSERT ON tbl FOR EACH ROW [FOLLOWS other] body
      while (at < stop && !(word(at) === 'EACH' && word(at + 1) === 'ROW')) at += 1
      at += 2
      if (word(at) === 'FOLLOWS' || word(at) === 'PRECEDES') at += 2
    } else if (kind === 'EVENT') {
      // CREATE EVENT name ON SCHEDULE ... DO body
      at = until(at, 'DO') + 1
    } else {
      // CREATE PROCEDURE name (parameters) [RETURNS type] [characteristics] body
      while (at < stop && !is(at, '(')) at += 1
      at = pastBrackets(at)
      while (at < stop && !COMPOUND.has(word(at)) && !SIMPLE.has(word(at))) {
        // A type can be spelled like a statement, as SET('a', 'b') is. It is not where the body begins.
        if (word(at) === 'RETURNS') at = is(at + 2, '(') ? pastBrackets(at + 2) : at + 2
        else at += 1
      }
    }
    if (at >= stop) return -1
    if (word(at) && is(at + 1, ':')) return COMPOUND.has(word(at + 2)) ? at : -1
    return COMPOUND.has(word(at)) ? at : -1
  }

  // MariaDB runs a block outside any stored program when it is written BEGIN NOT ATOMIC.
  if (word(start) === 'BEGIN' && word(start + 1) === 'NOT' && word(start + 2) === 'ATOMIC') {
    return semicolonFrom(pastStatement(start))
  }
  if (word(start) === 'CREATE' || word(start) === 'ALTER') {
    // The kind is named within the first few words: CREATE DEFINER = `a`@`b` PROCEDURE ...
    for (let at = start + 1; at < Math.min(count, start + 14) && !is(at, ';'); at++) {
      if (OTHER_OBJECTS.has(word(at))) break
      if (!PROGRAMS.has(word(at))) continue
      const body = bodyOf(word(at), at + 1)
      return semicolonFrom(body < 0 ? at : pastStatement(body))
    }
  }
  return semicolonFrom(start)
}

/**
 * The statements of a script, by where they are in it.
 *
 * A semicolon ends a statement, except inside the body of a stored program. A
 * script can also set its own delimiter with a DELIMITER line, as scripts
 * written for the mysql client do. That line is an instruction to the client
 * and is never sent.
 */
export function statementRanges(tree: SqlTree, text: string): StatementRange[] {
  const all = tokensOf(tree, text)
  const tokens = all.filter((token) => !token.comment)
  const ranges: StatementRange[] = []
  let delimiter = ';'
  /** True when the place `at` in the text is inside a string, a quoted name or a comment. */
  const inQuoted = (at: number) => all.some((token) => token.quoted && token.from <= at && at < token.to)
  /** The first token from `from` on that starts at or after `position`. */
  const tokenFrom = (position: number, from: number) => {
    let at = from
    while (at < tokens.length && tokens[at].from < position) at += 1
    return at
  }

  let at = 0
  while (at < tokens.length) {
    const first = tokens[at]
    if (delimiter === ';' && first.symbol === ';') {
      at += 1
      continue
    }
    if (first.word === 'DELIMITER') {
      const lineEnd = text.indexOf('\n', first.to)
      const rest = text.slice(first.to, lineEnd < 0 ? text.length : lineEnd).trim()
      if (rest) {
        delimiter = rest.split(/\s+/)[0]
        at = tokenFrom(lineEnd < 0 ? text.length : lineEnd, at)
        continue
      }
    }

    if (delimiter === ';') {
      const last = statementEnd(tokens, at)
      const semicolon = tokens[last] as Token | undefined
      // Up to its semicolon, a comment before that included. With no semicolon, to the last thing written.
      const to = semicolon
        ? first.from + text.slice(first.from, semicolon.from).trimEnd().length
        : tokens[tokens.length - 1].to
      ranges.push({ from: first.from, to, end: semicolon ? semicolon.to : to })
      at = last + 1
      continue
    }

    // Under a delimiter of the script's own, a statement is everything up to the next one.
    let found = text.indexOf(delimiter, first.from)
    while (found >= 0 && inQuoted(found)) found = text.indexOf(delimiter, found + 1)
    const stop = found < 0 ? text.length : found
    const to = first.from + text.slice(first.from, stop).trimEnd().length
    if (to > first.from) ranges.push({ from: first.from, to, end: found < 0 ? to : found + delimiter.length })
    at = tokenFrom(found < 0 ? text.length : found + delimiter.length, at)
  }
  return ranges
}

/**
 * Splits a script into single statements using the editor's own SQL parser,
 * so semicolons inside strings and comments are never mistaken for separators.
 * `backslashEscapes` says how the session that will run them reads a backslash
 * in a string, which decides where a string ends.
 */
export function splitStatements(text: string, backslashEscapes = true): string[] {
  const statements = statementRanges(dialectFor(backslashEscapes).language.parser.parse(text), text)
    .map(({ from, to }) => text.slice(from, to).trim())
    .filter((statement) => statement !== '')
  if (statements.length > 0) return statements
  // Nothing that reads as a statement, such as a lone comment. The server gets it as it is, and says what it is.
  const whole = text.trim().replace(/;\s*$/, '').trim()
  return whole ? [whole] : []
}

/**
 * The statement Run would execute for a cursor at `position`: the one the cursor
 * is in, else the one that ends before it on the same line, else the next one,
 * else the one before.
 *
 * The last two only when no empty line lies between it and the cursor. A cursor
 * left well below a statement, or in the gap between two, picks nothing: what
 * runs should be what is being looked at.
 */
export function statementAt(
  ranges: StatementRange[],
  /** The text between two places in the script. Asked for a little at a time, since a script can be long. */
  between: (from: number, to: number) => string,
  position: number,
): StatementRange | null {
  let before: StatementRange | null = null
  let after: StatementRange | null = null
  for (const range of ranges) {
    if (range.from <= position && position <= range.end) return range
    if (range.end < position) before = range
    else if (after === null) after = range
  }
  const apart = (from: number, to: number) => /\n[ \t\r]*\n/.test(between(from, to))
  if (before && !between(before.end, position).includes('\n')) return before
  if (after && !apart(position, after.from)) return after
  if (before && !apart(before.end, position)) return before
  return null
}

/** Statements that change the shape of a database, after which the schema tree is stale. */
export function changesSchema(sql: string): boolean {
  return /^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)
}
