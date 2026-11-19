import { useMemo, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import type { CellValue, ResultColumn } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { CodeView } from '@/editor/CodeView'
import { cellText, formatBytes, formatCount, formatJson, isBinary, looksLikeJson } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ValueInspectorProps {
  column: ResultColumn
  value: CellValue
  onClose(): void
}

/** Shows one cell in full. JSON is formatted and foldable, whatever column type holds it. */
export function ValueInspector({ column, value, onClose }: ValueInspectorProps) {
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)

  const text = value === null || isBinary(value) ? null : String(value)
  const isJson = useMemo(
    () => text !== null && (column.kind === 'json' || looksLikeJson(text)),
    [text, column.kind],
  )
  const formatted = useMemo(() => (isJson && text !== null ? formatJson(text) : null), [isJson, text])

  const copy = () => {
    void navigator.clipboard.writeText(isJson && !raw && formatted ? formatted : cellText(value))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
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
        <Button variant="ghost" size="icon-sm" title="Copy value" onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {value === null ? (
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
