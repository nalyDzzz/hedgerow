import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, type Completion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { sql } from '@codemirror/lang-sql'
import { bracketMatching } from '@codemirror/language'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder as placeholderText } from '@codemirror/view'
import type { ColumnInfo } from '@shared/driver'
import { appearance } from '@/editor/setup'
import { MYSQL } from '@/lib/sql'

/** One line high, and sized like the bar it sits in instead of like the editor. */
const oneLine = Prec.highest(
  EditorView.theme({
    '&': { height: '22px', backgroundColor: 'transparent' },
    '.cm-scroller': { fontSize: '12px', lineHeight: '22px', overflowX: 'auto', scrollbarWidth: 'none' },
    '.cm-scroller::-webkit-scrollbar': { display: 'none' },
    '.cm-content': { padding: '0' },
    '.cm-line': { padding: '0 6px' },
  }),
)

function language(table: string, columns: ColumnInfo[]) {
  const completions: Completion[] = columns.map((column) => ({
    label: column.name,
    type: 'property',
    detail: column.dataType,
  }))
  // With the table as the default, its columns complete without being prefixed by its name.
  return sql({ dialect: MYSQL, schema: { [table]: completions }, defaultTable: table, upperCaseKeywords: true })
}

interface SqlFieldProps {
  /** The text that is in force. The field goes back to it when it changes, and on Escape. */
  applied: string
  /** Counted up to put the field back to `applied` although `applied` itself did not change. */
  resets: number
  label: string
  placeholder: string
  /** The table whose columns are offered as you type. */
  table: string
  columns: ColumnInfo[]
  /** Called with every change to the text, typed or not. */
  onDraft(text: string): void
  /** Enter was pressed, with this text in the box. */
  onApply(text: string): void
}

/**
 * A one-line box for a piece of SQL, with the table's columns offered as you
 * type. What is typed lives in the box and is reported outwards; the box is
 * only ever written to when the text in force changes, never to echo what was
 * just typed back at it.
 */
export function SqlField({ applied, resets, label, placeholder, table, columns, onDraft, onApply }: SqlFieldProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const completion = useRef(new Compartment())
  // The view is made once, so it reaches the latest handlers through this.
  const handlers = useRef({ onDraft, onApply, applied })
  handlers.current = { onDraft, onApply, applied }

  useEffect(() => {
    const setText = (target: EditorView, text: string) =>
      target.dispatch({ changes: { from: 0, to: target.state.doc.length, insert: text } })

    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: handlers.current.applied,
        extensions: [
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          appearance,
          oneLine,
          completion.current.of(language(table, columns)),
          placeholderText(placeholder),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          // A condition is one line. Pasted line breaks become spaces, and none can be typed.
          EditorView.clipboardInputFilter.of((text) => text.replace(/\s*[\r\n]+\s*/g, ' ')),
          EditorState.transactionFilter.of((transaction) => (transaction.newDoc.lines > 1 ? [] : transaction)),
          // After the completion keys, so Enter and Escape first answer an open list of suggestions.
          keymap.of([
            {
              key: 'Enter',
              run: (target) => {
                handlers.current.onApply(target.state.doc.toString())
                return true
              },
            },
            {
              key: 'Escape',
              run: (target) => {
                if (target.state.doc.toString() === handlers.current.applied) return false
                setText(target, handlers.current.applied)
                return true
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onDraft(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = created
    return () => created.destroy()
    // Made once. The table's columns arrive later and are swapped in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: completion.current.reconfigure(language(table, columns)) })
  }, [table, columns])

  // Only when the text in force changes, or a reset is asked for: typing changes neither.
  useEffect(() => {
    const current = view.current
    if (!current || current.state.doc.toString() === applied) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: applied } })
  }, [applied, resets])

  return <div ref={host} className="min-w-0 flex-1 overflow-hidden" />
}
