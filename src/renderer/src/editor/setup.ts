/** CodeMirror pieces shared by the SQL editor and the read-only value viewer. */
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { statementAt, statementRanges, type SqlTree, type StatementRange } from '@/lib/sql'

// Colors are CSS variables, so the editor follows the app theme with no reconfiguration.
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: t.string, color: 'var(--syn-string)' },
  // Backtick-quoted identifiers are names, not string values.
  { tag: t.special(t.string), color: 'var(--foreground)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.typeName, t.standard(t.name), t.propertyName], color: 'var(--syn-type)' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--muted-foreground)' },
])

/**
 * The editor's look. This has to be a CodeMirror theme rather than plain CSS:
 * CodeMirror injects its own defaults, and only a theme reliably outranks them.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  '.cm-content': {
    padding: '10px 0',
    caretColor: 'var(--foreground)',
    userSelect: 'text',
  },
  '.cm-line': { padding: '0 14px 0 10px' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'var(--faint)',
    borderRight: 'none',
    fontSize: '11.5px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '34px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '1.5px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--tint-soft)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--tint-soft) 60%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--border-strong)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--syn-number) 30%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklab, var(--syn-number) 55%, transparent)',
  },
  // The statement that Run will execute.
  '.cm-statement-line': { boxShadow: 'inset 2px 0 0 var(--tint)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--muted)',
    border: 'none',
    color: 'var(--muted-foreground)',
    padding: '0 4px',
  },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--faint)', cursor: 'default', padding: '0 2px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px 3px 6px', lineHeight: '1.5' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--tint-soft)',
    color: 'var(--foreground)',
  },
  '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '12px' },
  '.cm-completionIcon': { opacity: '0.5', width: '1.1em' },
  '.cm-panels': {
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button, .cm-panel label': {
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--background)',
    border: '1px solid var(--input)',
    borderRadius: '4px',
    color: 'var(--foreground)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--secondary)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--foreground)',
  },
})

/** Theme plus syntax colors: everything an editor needs to look right in either app theme. */
export const appearance: Extension = [theme, syntaxHighlighting(highlightStyle)]

/** The statements of a parsed text. Kept per parse, so moving the cursor does not read the text again. */
const statementsOf = new WeakMap<SqlTree, StatementRange[]>()

/**
 * The statement Run would execute for a cursor at `pos`, as `statementAt`
 * picks it, or null when the cursor is on none.
 *
 * A long text is parsed a piece at a time. Marking the statement makes do with
 * what has been parsed so far. Running one does not: with `whole` the text is
 * parsed to its end first, because a statement cut off where the parser happens
 * to have stopped is not the statement that was written.
 */
export function statementRangeAt(state: EditorState, pos: number, whole = false): StatementRange | null {
  const length = state.doc.length
  const tree = (ensureSyntaxTree(state, length, whole ? 30_000 : 200) ?? syntaxTree(state)) as SqlTree
  if (whole && tree.length < length) return null
  let ranges = statementsOf.get(tree)
  if (!ranges) {
    ranges = statementRanges(tree, state.doc.toString())
    statementsOf.set(tree, ranges)
  }
  return statementAt(ranges, (from, to) => state.sliceDoc(from, to), pos)
}

const statementLine = Decoration.line({ class: 'cm-statement-line' })

function markStatement(state: EditorState): DecorationSet {
  const selection = state.selection.main
  // With a selection, the selection itself shows what will run.
  if (!selection.empty) return Decoration.none
  const range = statementRangeAt(state, selection.head)
  if (!range) return Decoration.none

  const first = state.doc.lineAt(range.from).number
  const last = state.doc.lineAt(range.to).number
  const lines = []
  for (let number = first; number <= last; number++) {
    lines.push(statementLine.range(state.doc.line(number).from))
  }
  return Decoration.set(lines)
}

/** Marks the lines of the statement under the cursor. */
export const activeStatement: Extension = StateField.define<DecorationSet>({
  create: markStatement,
  update: (value, transaction) =>
    transaction.docChanged || transaction.selection ? markStatement(transaction.state) : value,
  provide: (field) => EditorView.decorations.from(field),
})
