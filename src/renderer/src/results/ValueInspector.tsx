import { useMemo, useRef, useState } from 'react'
import { Check, Copy, Pencil, Undo2, X } from 'lucide-react'
import type { CellValue, ResultColumn } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { CodeView } from '@/editor/CodeView'
import { cellText, formatBytes, formatCount, formatJson, isBinary, looksLikeJson } from '@/lib/format'
import { MOD, cn, shortcut } from '@/lib/utils'

interface ValueInspectorProps {
  column: ResultColumn
  /**
   * What the cell shows: the unsaved value if it has one, otherwise what is stored.
   * Undefined for a cell of a new row that has not been given a value.
   */
  value: CellValue | undefined
  /** The cell has a change that is not saved yet. In a new row, that is any value it was given. */
  changed: boolean
  /** The cell belongs to a row that is not in the database yet. */
  inNewRow?: boolean
  /** For a cell of a new row: the table has no default for this column, so it is expected to be given a value. */
  required?: boolean
  /** The value can be changed from here. */
  editable: boolean
  nullable: boolean
  /** Open ready to type, as when the grid hands over a value it has no room to edit. */
  startEditing: boolean
  /** Stages a new value. Nothing is saved. */
  onStage(value: string | null): void
  /** Editing ended, with or without a new value. */
  onEditEnd(): void
  onRevert(): void
  onClose(): void
}

/**
 * Shows one cell in full. JSON is formatted and foldable, whatever column type
 * holds it. This is also where long text is edited: unlike a cell, it has room
 * for line breaks.
 */
export function ValueInspector({
  column,
  value,
  changed,
  inNewRow,
  required,
  editable,
  nullable,
  startEditing,
  onStage,
  onEditEnd,
  onRevert,
  onClose,
}: ValueInspectorProps) {
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(startEditing && editable)

  const text = value == null || isBinary(value) ? null : String(value)
  const isJson = useMemo(
    () => text !== null && (column.kind === 'json' || looksLikeJson(text)),
    [text, column.kind],
  )
  const formatted = useMemo(() => (isJson && text !== null ? formatJson(text) : null), [isJson, text])

  const copy = () => {
    void navigator.clipboard.writeText(isJson && !raw && formatted ? formatted : cellText(value ?? ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  if (editing && editable) {
    return (
      <ValueEditor
        column={column}
        initial={text}
        holds={value === undefined ? 'not set' : 'NULL'}
        nullable={nullable}
        onCancel={() => {
          setEditing(false)
          onEditEnd()
        }}
        onDone={(next) => {
          if (next !== undefined) onStage(next)
          setEditing(false)
          onEditEnd()
        }}
      />
    )
  }

  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-background">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card pl-3 pr-1.5">
        <span className="truncate text-[12px] font-medium">{column.name}</span>
        <span className="shrink-0 font-mono text-[10px] tracking-wide text-faint">{column.dbType}</span>
        <div className="flex-1" />
        {isJson && (
          <div className="flex rounded-md bg-muted p-0.5 text-[11.5px]">
            {(['Formatted', 'Raw'] as const).map((label) => {
              const active = (label === 'Raw') === raw
              return (
                <button
                  key={label}
                  className={cn(
                    'h-5 rounded-[4px] px-1.5',
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                  )}
                  aria-pressed={active}
                  onClick={() => setRaw(label === 'Raw')}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
        {editable && (
          <Button variant="ghost" size="icon-sm" title="Edit value" aria-label="Edit value" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Copy value" onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <X />
        </Button>
      </header>

      {changed && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-muted pl-3 pr-1.5 text-[11.5px]">
          <span className="font-medium">{inNewRow ? 'In a new row, not saved yet' : 'Changed, not saved yet'}</span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5"
            title={inNewRow ? 'Take this value away again and leave the cell to the table' : undefined}
            onClick={onRevert}
          >
            <Undo2 />
            {inNewRow ? 'Do not set' : 'Undo'}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {value === undefined ? (
          <p className="p-3 text-[12.5px] text-muted-foreground">
            {required ? (
              <>This value is not set, and the table has no default for it. The row needs one to be saved.</>
            ) : (
              <>
                This value is not set. When the row is saved, the table decides what it holds: a default, a generated
                number, or <span className="cell-null font-mono">NULL</span>.
              </>
            )}
          </p>
        ) : value === null ? (
          <p className="p-3 text-[12.5px] text-muted-foreground">
            This value is <span className="cell-null font-mono">NULL</span>.
          </p>
        ) : isBinary(value) ? (
          <div className="p-3">
            <p className="selectable break-all font-mono text-[12px]">{value.preview.replace(/(..)/g, '$1 ')}</p>
            <p className="mt-2 text-[12px] text-muted-foreground">
              {value.bytes > 32
                ? `First 32 of ${formatCount(value.bytes)} bytes (${formatBytes(value.bytes)}).`
                : `${formatCount(value.bytes)} bytes.`}
            </p>
          </div>
        ) : text === '' ? (
          <p className="p-3 text-[12.5px] text-muted-foreground">This value is an empty string, not NULL.</p>
        ) : isJson && !raw && formatted !== null ? (
          <CodeView value={formatted} />
        ) : (
          <pre className="selectable m-0 whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-relaxed">
            {text}
          </pre>
        )}
      </div>

      {text !== null && (
        <footer className="flex h-6 shrink-0 items-center border-t border-border px-3 text-[11px] text-faint">
          {formatCount(text.length)} characters
        </footer>
      )}
    </aside>
  )
}

interface ValueEditorProps {
  column: ResultColumn
  /** The text to start from. Null when the cell holds no text. */
  initial: string | null
  /** What it holds then, shown until something is typed. */
  holds: string
  nullable: boolean
  onCancel(): void
  /** Called with the new value, or with nothing when the text was left as it was. */
  onDone(value?: string | null): void
}

/**
 * Edits the text exactly as it will be stored. Nothing is reformatted unless
 * Format is pressed, so JSON kept in a text column keeps its own spacing.
 */
function ValueEditor({ column, initial, holds, nullable, onCancel, onDone }: ValueEditorProps) {
  const [draft, setDraft] = useState(initial ?? '')
  // An untouched box changes nothing, so opening a NULL and leaving does not make it an empty string,
  // and a cell of a new row that was only looked at stays not set.
  const touched = useRef(false)
  const invalidJson = useMemo(() => {
    if (column.kind !== 'json' || draft.trim() === '') return false
    try {
      JSON.parse(draft)
      return false
    } catch {
      return true
    }
  }, [column.kind, draft])
  const canFormat = useMemo(() => looksLikeJson(draft), [draft])

  const done = () => onDone(touched.current ? draft : undefined)

  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-background">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card pl-3 pr-1.5">
        <span className="truncate text-[12px] font-medium">{column.name}</span>
        <span className="shrink-0 font-mono text-[10px] tracking-wide text-faint">{column.dbType}</span>
        <div className="flex-1" />
        {canFormat && (
          <Button
            variant="ghost"
            size="sm"
            title="Indent this JSON. Numbers and text inside it are left as they are."
            onClick={() => {
              touched.current = true
              setDraft(formatJson(draft))
            }}
          >
            Format
          </Button>
        )}
        {nullable && (
          <Button variant="ghost" size="sm" title="Store NULL instead of text" onClick={() => onDone(null)}>
            Set NULL
          </Button>
        )}
      </header>

      <textarea
        autoFocus
        value={draft}
        spellCheck={false}
        aria-label={`New value for ${column.name}`}
        placeholder={initial === null && !touched.current ? holds : 'empty text'}
        className="selectable min-h-0 flex-1 resize-none bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:italic placeholder:text-faint"
        onChange={(event) => {
          touched.current = true
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            done()
          }
        }}
      />

      {invalidJson && (
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11.5px] text-destructive">
          This is not valid JSON, so the server will refuse it.
        </p>
      )}
      <footer className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-card pl-3 pr-2">
        <span className="truncate text-[11px] text-faint">{formatCount(draft.length)} characters</span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          title={`Put this value in the grid (${shortcut(MOD, 'Enter')}). It is saved when you save your changes.`}
          onClick={done}
        >
          Done
        </Button>
      </footer>
    </aside>
  )
}
