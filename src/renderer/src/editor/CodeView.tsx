import { useEffect, useRef } from 'react'
import { json } from '@codemirror/lang-json'
import { sql } from '@codemirror/lang-sql'
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { MYSQL } from '@/lib/sql'
import { appearance } from './setup'

/** Read-only, selectable text with syntax colors: foldable JSON, or SQL. */
export function CodeView({ value, language = 'json' }: { value: string; language?: 'json' | 'sql' }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)

  useEffect(() => {
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          // A statement can span lines, so numbered lines would not number statements.
          ...(language === 'json' ? [lineNumbers(), foldGutter(), json(), keymap.of(foldKeymap)] : [sql({ dialect: MYSQL })]),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          appearance,
        ],
      }),
    })
    view.current = created
    return () => created.destroy()
    // The language is fixed for the life of a view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const current = view.current
    if (!current) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
