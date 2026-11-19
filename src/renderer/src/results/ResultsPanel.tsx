import { useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, PanelRight } from 'lucide-react'
import type { ErrorResult, OkResult } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ResizeHandle'
import { formatCount, formatDuration, plural } from '@/lib/format'
import { MOD, cn } from '@/lib/utils'
import { ROW_LIMITS, useStore, type ResultEntry, type Tab } from '@/store'
import { ResultsGrid } from './ResultsGrid'
import { ValueInspector } from './ValueInspector'

function Statement({ sql }: { sql: string }) {
  return (
    <pre className="selectable mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
      {sql}
    </pre>
  )
}

function ErrorView({ sql, result }: { sql: string; result: ErrorResult }) {
  const stopped = result.code === 'ER_QUERY_INTERRUPTED'
  return (
    <div className="h-full overflow-auto p-4">
      <div className={cn('flex items-start gap-2', stopped ? 'text-muted-foreground' : 'text-destructive')}>
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="selectable text-[13px] font-medium">{stopped ? 'Stopped before it finished.' : result.message}</p>
          {result.code && !stopped && (
            <p className="selectable mt-0.5 font-mono text-[11px] opacity-80">{result.code}</p>
          )}
        </div>
      </div>
      <Statement sql={sql} />
    </div>
  )
}

function OkView({ sql, result }: { sql: string; result: OkResult }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-start gap-2">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-tint" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            {plural(result.affectedRows, 'row')} affected
            <span className="ml-2 font-normal text-muted-foreground">{formatDuration(result.durationMs)}</span>
          </p>
          {result.info && <p className="selectable mt-0.5 text-[12px] text-muted-foreground">{result.info}</p>}
          {result.insertId && (
            <p className="selectable mt-0.5 text-[12px] text-muted-foreground">New row id: {result.insertId}</p>
          )}
        </div>
      </div>
      <Statement sql={sql} />
    </div>
  )
}

function summary(entry: ResultEntry): string {
  const { result } = entry
  if (result.kind === 'error') return result.code === 'ER_QUERY_INTERRUPTED' ? 'Stopped' : 'Failed'
  if (result.kind === 'ok') return `${plural(result.affectedRows, 'row')} affected`
  const count = plural(result.rows.length, 'row')
  return result.truncated ? `First ${count}` : count
}

export function ResultsPanel({ tab }: { tab: Tab }) {
  const inspectorOpen = useStore((state) => state.inspectorOpen)
  const { selectCell, setActiveResult, setInspectorOpen, setRowLimit } = useStore.getState()
  const [inspectorWidth, setInspectorWidth] = useState(380)

  const entry = tab.results[tab.activeResult] as ResultEntry | undefined
  const rowsResult = entry?.result.kind === 'rows' ? entry.result : null
  const selected = rowsResult && tab.selected && tab.selected.row < rowsResult.rows.length ? tab.selected : null

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card pl-2 pr-1.5 text-[12px]">
        {tab.results.length > 1 && (
          <div className="flex items-center gap-0.5" role="tablist" aria-label="Results">
            {tab.results.map((item, index) => (
              <button
                key={index}
                role="tab"
                aria-selected={index === tab.activeResult}
                title={item.sql}
                onClick={() => setActiveResult(tab.id, index)}
                className={cn(
                  'h-5 min-w-5 rounded-sm px-1.5 font-mono text-[11px]',
                  index === tab.activeResult
                    ? 'bg-tint-soft text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                  item.result.kind === 'error' && 'text-destructive',
                )}
              >
                {index + 1}
              </button>
            ))}
            <div className="mx-1 h-3.5 w-px bg-border" />
          </div>
        )}

        {tab.running ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Running…
          </span>
        ) : entry ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('font-medium', entry.result.kind === 'error' && 'text-destructive')}>
              {summary(entry)}
            </span>
            {rowsResult?.truncated && (
              <span className="truncate text-muted-foreground">
                More rows exist. Raise the limit and run again to load them.
              </span>
            )}
            {entry.result.kind !== 'error' && (
              <span className="shrink-0 text-faint">{formatDuration(entry.result.durationMs)}</span>
            )}
          </span>
        ) : (
          <span className="text-faint">Results</span>
        )}

        <div className="flex-1" />

        <label className="flex shrink-0 items-center gap-1.5 text-muted-foreground" title="Applies from the next run">
          Limit
          <select
            value={tab.rowLimit}
            onChange={(event) => setRowLimit(tab.id, Number(event.target.value))}
            className="h-6 rounded-sm border border-border bg-background px-1 text-[12px] text-foreground"
          >
            {ROW_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {formatCount(limit)} rows
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="icon-sm"
          title={inspectorOpen ? 'Hide value panel' : 'Show value panel'}
          aria-pressed={inspectorOpen}
          className={cn(inspectorOpen && 'bg-muted text-foreground')}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          <PanelRight />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {!entry ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px] text-faint">
              {tab.running ? null : (
                <p>
                  Results appear here.
                  <br />
                  {MOD}+Enter runs the statement under the cursor.
                </p>
              )}
            </div>
          ) : entry.result.kind === 'error' ? (
            <ErrorView sql={entry.sql} result={entry.result} />
          ) : entry.result.kind === 'ok' ? (
            <OkView sql={entry.sql} result={entry.result} />
          ) : entry.result.rows.length === 0 ? (
            <div className="h-full overflow-auto p-4">
              <p className="text-[13px] font-medium">No rows matched.</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                The statement ran and returned {plural(entry.result.columns.length, 'column')} with nothing in them.
              </p>
              <Statement sql={entry.sql} />
            </div>
          ) : (
            <ResultsGrid
              // A new result is a new grid: column widths and scroll position start over.
              key={`${tab.id}:${tab.activeResult}:${entry.result.durationMs}`}
              result={entry.result}
              selected={selected}
              onSelect={(cell) => selectCell(tab.id, cell)}
              onOpen={() => setInspectorOpen(true)}
            />
          )}
        </div>

        {inspectorOpen && rowsResult && (
          <>
            <ResizeHandle axis="x" reverse value={inspectorWidth} min={240} max={900} onChange={setInspectorWidth} />
            <div className="shrink-0" style={{ width: inspectorWidth }}>
              {selected ? (
                <ValueInspector
                  key={`${selected.row}:${selected.col}`}
                  column={rowsResult.columns[selected.col]}
                  value={rowsResult.rows[selected.row][selected.col]}
                  onClose={() => setInspectorOpen(false)}
                />
              ) : (
                <div className="flex h-full items-center justify-center border-l border-border p-6 text-center text-[12.5px] text-faint">
                  Select a cell to see its full value.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
