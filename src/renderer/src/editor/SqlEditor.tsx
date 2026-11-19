import { useEffect, useMemo, useRef } from 'react'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MySQL, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { splitStatements } from '@/lib/sql'
import { MOD } from '@/lib/utils'
import { useStore, type SchemaState, type Tab } from '@/store'
import { activeStatement, appearance, statementRangeAt } from './setup'

const sqlLanguage = new Compartment()

// One editor view is shared by every tab; each tab keeps its own state (text, undo history, cursor).
let view: EditorView | null = null
let viewTabId: string | null = null
const tabStates = new Map<string, EditorState>()

function run(statements: string[]): void {
  if (viewTabId && statements.length > 0) void useStore.getState().run(viewTabId, statements)
}

/** Runs the selection, or the statement under the cursor when nothing is selected. */
export function runCurrentStatement(): boolean {
  if (!view) return false
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty) {
    run(splitStatements(state.sliceDoc(selection.from, selection.to)))
    return true
  }
  const range = statementRangeAt(state, selection.head)
  if (range) run(splitStatements(state.sliceDoc(range.from, range.to)))
  return true
}

export function runAllStatements(): boolean {
  if (!view) return false
  run(splitStatements(view.state.doc.toString()))
  return true
}

export function focusEditor(): void {
  view?.focus()
}

function sqlSupport(schema: SQLNamespace, database: string | null) {
  return sql({
    dialect: MySQL,
    schema,
    defaultSchema: database ?? undefined,
    upperCaseKeywords: true,
  })
}

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      appearance,
      activeStatement,
      sqlLanguage.of(sqlSupport({}, null)),
      placeholder(`Write SQL here. ${MOD}+Enter runs the statement under the cursor.`),
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run: runCurrentStatement },
          { key: 'Shift-Mod-Enter', run: runAllStatements },
        ]),
      ),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && viewTabId) {
          useStore.getState().setTabSql(viewTabId, update.state.doc.toString())
        }
      }),
    ],
  })
}

/** Everything the connection's loaded databases contain, in the shape autocomplete wants. */
function completionSchema(schemas: Record<string, SchemaState> | undefined): SQLNamespace {
  const namespace: Record<string, Record<string, Completion[]>> = {}
  for (const [database, schema] of Object.entries(schemas ?? {})) {
    if (schema.tables.length === 0) continue
    const tables: Record<string, Completion[]> = {}
    for (const table of schema.tables) {
      tables[table.name] = table.columns.map((column) => ({
        label: column.name,
        type: 'property',
        detail: column.dataType,
      }))
    }
    namespace[database] = tables
  }
  return namespace
}

export function SqlEditor({ tab }: { tab: Tab }) {
  const host = useRef<HTMLDivElement>(null)
  const schemas = useStore((state) => state.live[tab.connectionId]?.schemas)
  const openTabIds = useStore((state) => state.tabs.map((t) => t.id).join(','))
  const schema = useMemo(() => completionSchema(schemas), [schemas])

  // Create the view once.
  useEffect(() => {
    const created = new EditorView({ parent: host.current!, state: createState('') })
    view = created
    return () => {
      created.destroy()
      view = null
      viewTabId = null
    }
  }, [])

  // Swap in the state of whichever tab is showing.
  useEffect(() => {
    if (!view || viewTabId === tab.id) return
    if (viewTabId) tabStates.set(viewTabId, view.state)
    viewTabId = tab.id
    view.setState(tabStates.get(tab.id) ?? createState(tab.sql))
    view.focus()
    // Only the tab identity matters here; its text is read once, when the state is first created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // Keep autocomplete in step with the schema and the selected database.
  useEffect(() => {
    view?.dispatch({ effects: sqlLanguage.reconfigure(sqlSupport(schema, tab.database)) })
  }, [schema, tab.database, tab.id])

  // Forget the editor state of tabs that were closed.
  useEffect(() => {
    const open = new Set(openTabIds.split(','))
    for (const id of tabStates.keys()) if (!open.has(id)) tabStates.delete(id)
  }, [openTabIds])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
