import { useEffect, useRef } from 'react'
import { json } from '@codemirror/lang-json'
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { appearance } from './setup'

/** Read-only, selectable, foldable JSON. */
export function CodeView({ value }: { value: string }) {
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
          lineNumbers(),
          foldGutter(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          appearance,
          json(),
          keymap.of(foldKeymap),
        ],
      }),
    })
    view.current = created
    return () => created.destroy()
  }, [])

  useEffect(() => {
    const current = view.current
    if (!current) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
