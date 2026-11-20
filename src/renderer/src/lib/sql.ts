import { MySQL } from '@codemirror/lang-sql'

function clean(statement: string): string {
  return statement.trim().replace(/;\s*$/, '').trim()
}

/**
 * Splits a script into single statements using the editor's own SQL parser,
 * so semicolons inside strings and comments are never mistaken for separators.
 */
export function splitStatements(text: string): string[] {
  const statements: string[] = []
  const cursor = MySQL.language.parser.parse(text).cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'Statement') {
        const statement = clean(text.slice(cursor.from, cursor.to))
        if (statement) statements.push(statement)
      }
    } while (cursor.nextSibling())
  }
  if (statements.length === 0 && clean(text)) return [clean(text)]
  return statements
}

/** Statements that change the shape of a database, after which the schema tree is stale. */
export function changesSchema(sql: string): boolean {
  return /^\s*(create|alter|drop|rename|truncate)\b/i.test(sql)
}
