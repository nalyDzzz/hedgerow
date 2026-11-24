import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Lock, PanelRight, Pencil, Plus } from 'lucide-react'
import type { ErrorResult, OkResult, RowsResult } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/ResizeHandle'
import { formatCount, formatDuration, plural } from '@/lib/format'
import { MOD, cn, shortcut } from '@/lib/utils'
import { ROW_LIMITS, countChanges, useStore, type ResultEntry, type Tab } from '@/store'
import { ResultsGrid } from './ResultsGrid'
import { SaveChangesDialog, type SavePlan } from './SaveChangesDialog'
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

/** Says whether the rows on screen can be changed, and if not, why. */
function EditingNote({ result, saved, outside }: { result: RowsResult; saved?: number; outside?: number }) {
  if (saved) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground" role="status">
        <CircleCheck className="size-3.5 shrink-0 text-tint" />
        <span className="shrink-0">
          Saved {plural(saved, 'change')}
          {outside ? '.' : ''}
        </span>
        {outside ? (
          // The grid shows what the statement returns, and a row it does not return would otherwise just vanish.
          <span
            className="truncate font-medium text-foreground"
            title={
              `${outside === 1 ? 'The new row was stored, but it is' : 'These new rows were stored, but they are'} ` +
              'not among the rows this statement returns: its conditions, its order or the row limit leave ' +
              `${outside === 1 ? 'it' : 'them'} out.`
            }
          >
            {plural(outside, 'new row')} {outside === 1 ? 'is' : 'are'} not shown here
          </span>
        ) : null}
      </span>
    )
  }
  if (result.editing) {
    const { database, table } = result.editing.table
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-muted-foreground"
        title={`These are rows of ${database}.${table}. Double-click a cell to change it, or right-click for more. Nothing reaches the database until you save.`}
      >
        <Pencil className="size-3" />
        Editable
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-faint" title={result.readOnly}>
      <Lock className="size-3" />
      Read-only
    </span>
  )
}

export function ResultsPanel({ tab }: { tab: Tab }) {
  const inspectorOpen = useStore((state) => state.inspectorOpen)
  const connectionName = useStore(
    (state) => state.connections.find((connection) => connection.id === tab.connectionId)?.name ?? 'this connection',
  )
  const {
    selectCell,
    setActiveResult,
    setInspectorOpen,
    setRowLimit,
    stageCell,
    revertCell,
    setRowDeleted,
    addRow,
    duplicateRow,
    discardChanges,
    planSave,
    save,
    cancel,
  } = useStore.getState()
  const [inspectorWidth, setInspectorWidth] = useState(380)
  /** The cell the grid asked the value panel to edit, as "row:column", and which request that was. */
  const [panelEdit, setPanelEdit] = useState<{ cell: string; request: number } | null>(null)
  const [plan, setPlan] = useState<SavePlan | null>(null)
  /** Set by a button out here that moves the selection in the grid, for the grid to pick up. */
  const gridWanted = useRef(false)

  const entry = tab.results[tab.activeResult] as ResultEntry | undefined
  const rowsResult = entry?.result.kind === 'rows' ? entry.result : null
  const staged = entry?.staged
  // New rows are shown after the rows of the result.
  const added = staged?.added ?? []
  const stored = rowsResult?.rows.length ?? 0
  const selected = rowsResult && tab.selected && tab.selected.row < stored + added.length ? tab.selected : null
  const selectedNew = selected && selected.row >= stored ? added[selected.row - stored] : undefined
  const changes = countChanges(staged)
  const editing = tab.running ? undefined : rowsResult?.editing

  const addRowHere = () => {
    gridWanted.current = true
    addRow(tab.id)
  }

  const review = async () => {
    try {
      setPlan({ statements: await planSave(tab.id) })
    } catch (error) {
      setPlan({ problem: error instanceof Error ? error.message : String(error) })
    }
  }

  // Save is where people expect it, whenever there is something to save.
  const canSave = changes > 0 && !tab.running && plan === null
  useEffect(() => {
    if (!canSave) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void review()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `review` only reads the tab id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave, tab.id])

  const selectedKey = selected ? `${selected.row}:${selected.col}` : null
  const editInPanel = panelEdit !== null && panelEdit.cell === selectedKey
  // A save that emptied the result, or added a row it does not return, still has to say it happened.
  const showNote =
    rowsResult !== null && (stored > 0 || Boolean(entry?.saved)) && !tab.running && changes === 0
  const selectedChange = selected ? staged?.cells[selected.row]?.[selected.col] : undefined
  const selectedDeleted = selected ? Boolean(staged?.deleted[selected.row]) : false
  const selectedChanged = selectedChange !== undefined && !selectedDeleted

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
                {countChanges(item.staged) > 0 && <span aria-label="Has unsaved changes">*</span>}
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
            <span className={cn('shrink-0 font-medium', entry.result.kind === 'error' && 'text-destructive')}>
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

        {showNote && <EditingNote result={rowsResult} saved={entry?.saved} outside={entry?.outside} />}
        {changes > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-medium">{plural(changes, 'unsaved change')}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={tab.running}
              title="Put the grid back to what the database holds"
              onClick={() => discardChanges(tab.id)}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="tint"
              disabled={tab.running}
              title={`See the statements, then save (${shortcut(MOD, 'S')})`}
              onClick={() => void review()}
            >
              Save…
            </Button>
          </div>
        )}
        {editing && (
          // Last in its group, so that it stays put when the unsaved count appears beside it: a second
          // click must not land on Discard. On a wrapper, because a disabled button shows no tooltip.
          <span
            className="shrink-0"
            title={
              editing.adding
                ? `Add a row to ${editing.table.database}.${editing.table.table}. Nothing reaches the database until you save.`
                : editing.cannotAdd
            }
          >
            <Button size="sm" variant="ghost" disabled={!editing.adding} onClick={addRowHere}>
              <Plus />
              Add row
            </Button>
          </span>
        )}
        {(showNote || changes > 0 || editing) && <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />}

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
          ) : entry.result.rows.length === 0 && added.length === 0 ? (
            <div className="h-full overflow-auto p-4">
              <p className="text-[13px] font-medium">No rows matched.</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                The statement ran and returned {plural(entry.result.columns.length, 'column')} with nothing in them.
              </p>
              {editing?.adding && (
                // With no rows there is no grid, and so nowhere else to start the first one.
                <Button className="mt-3" onClick={addRowHere}>
                  <Plus />
                  Add a row to {editing.table.table}
                </Button>
              )}
              <Statement sql={entry.sql} />
            </div>
          ) : (
            <ResultsGrid
              // A new result is a new grid: column widths and scroll position start over.
              // Rows reloaded after a save keep their entry, and so their place.
              key={`${tab.id}:${entry.id}`}
              result={entry.result}
              selected={selected}
              staged={staged}
              editable={!tab.running}
              claimFocus={() => {
                const wanted = gridWanted.current
                gridWanted.current = false
                return wanted
              }}
              onSelect={(cell) => {
                setPanelEdit(null)
                selectCell(tab.id, cell)
              }}
              onOpen={() => setInspectorOpen(true)}
              onEditInPanel={(cell) => {
                setPanelEdit((last) => ({ cell: `${cell.row}:${cell.col}`, request: (last?.request ?? 0) + 1 }))
                setInspectorOpen(true)
              }}
              onStage={(cell, value) => stageCell(tab.id, cell, value)}
              onRevert={(cell) => revertCell(tab.id, cell)}
              onDeleteRow={(row, deleted) => setRowDeleted(tab.id, row, deleted)}
              onAddRow={() => addRow(tab.id)}
              onDuplicateRow={(row) => duplicateRow(tab.id, row)}
            />
          )}
        </div>

        {inspectorOpen && rowsResult && (
          <>
            <ResizeHandle axis="x" reverse value={inspectorWidth} min={240} max={900} onChange={setInspectorWidth} />
            <div className="shrink-0" style={{ width: inspectorWidth }}>
              {selected ? (
                <ValueInspector
                  // Remounts for another cell, and each time the grid asks to edit this one.
                  key={`${entry?.id}:${selectedKey}:${editInPanel ? panelEdit.request : 0}`}
                  column={rowsResult.columns[selected.col]}
                  value={
                    selectedNew
                      ? selectedNew.cells[selected.col]
                      : selectedChanged
                        ? selectedChange
                        : rowsResult.rows[selected.row][selected.col]
                  }
                  changed={selectedChanged}
                  required={selectedNew !== undefined && Boolean(editing?.adding?.required.includes(selected.col))}
                  editable={
                    Boolean(editing?.editable.includes(selected.col)) &&
                    !selectedDeleted &&
                    // A new row has no key yet, and needs none to be typed into.
                    (selectedNew !== undefined || editing!.key.every((col) => rowsResult.rows[selected.row][col] !== null))
                  }
                  nullable={Boolean(editing?.nullable.includes(selected.col))}
                  startEditing={editInPanel}
                  onStage={(value) => stageCell(tab.id, selected, value)}
                  onEditEnd={() => setPanelEdit(null)}
                  onRevert={() => revertCell(tab.id, selected)}
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

      {plan && rowsResult?.editing && (
        <SaveChangesDialog
          plan={plan}
          table={rowsResult.editing.table}
          connection={connectionName}
          changes={changes}
          onSave={(statements) => save(tab.id, statements)}
          onStop={() => void cancel(tab.id)}
          onClose={() => setPlan(null)}
        />
      )}
    </section>
  )
}
