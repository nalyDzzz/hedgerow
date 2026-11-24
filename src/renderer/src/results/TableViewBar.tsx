import { useState, type ReactNode } from 'react'
import { CircleAlert, Funnel, X } from 'lucide-react'
import type { ColumnInfo } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useStore, type Tab } from '@/store'
import { SqlField } from './SqlField'

const NO_COLUMNS: ColumnInfo[] = []

interface PartProps {
  keyword: string
  applied: string
  draft: string
  resets: number
  label: string
  placeholder: string
  table: string
  columns: ColumnInfo[]
  className: string
  /** What the clear button says it does. */
  clearTitle: string
  onDraft(text: string): void
  /** Enter was pressed in the box, which holds `text`. */
  onApply(text: string): void
  onClear(): void
}

/** One part of a view: the keyword it follows, the box to type it in, and a button that takes it away. */
function Part({ keyword, applied, draft, clearTitle, className, onClear, ...field }: PartProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {/* The keyword stands out while its part is in force, by weight and not by a color of its own. */}
      <span
        className={cn(
          'shrink-0 font-mono text-[10.5px] tracking-wide',
          applied ? 'font-semibold text-foreground' : 'text-faint',
        )}
      >
        {keyword}
      </span>
      <div
        className={cn(
          'flex h-6 min-w-0 flex-1 items-center rounded-sm border bg-background focus-within:border-ring',
          applied ? 'border-border-strong' : 'border-border',
        )}
      >
        <SqlField applied={applied} {...field} />
        {(applied || draft) && (
          <button
            type="button"
            title={clearTitle}
            aria-label={clearTitle}
            className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClear}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The filter and the order of a tab that shows one table. Both are typed as
 * SQL, the way they would follow WHERE and ORDER BY, and applying them asks
 * the database again: this is not a search through the rows already loaded.
 */
export function TableViewBar({ tab, children }: { tab: Tab & { table: NonNullable<Tab['table']> }; children?: ReactNode }) {
  const { applyView } = useStore.getState()
  const columns = useStore(
    (state) =>
      state.live[tab.connectionId]?.schemas[tab.table.database]?.tables.find((table) => table.name === tab.table.table)
        ?.columns ?? NO_COLUMNS,
  )
  const { view } = tab
  // What is in the boxes, which is not in force until it is applied.
  const [where, setWhere] = useState(view.where)
  const [orderBy, setOrderBy] = useState(view.orderBy)
  const [resets, setResets] = useState({ where: 0, orderBy: 0 })

  const dirty = where.trim() !== view.where || orderBy.trim() !== view.orderBy
  const apply = (next = { where, orderBy }) => void applyView(tab.id, next)

  /**
   * Takes one part away and leaves the other as it is. If the part was in force
   * the rows are read again; if it was only typed, its box goes back to empty.
   */
  const clear = (part: 'where' | 'orderBy') => {
    if (view[part]) apply({ ...view, [part]: '' })
    else setResets((counts) => ({ ...counts, [part]: counts[part] + 1 }))
  }

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-border bg-card pl-2 pr-1.5 text-[12px]">
        <Funnel
          className={cn('size-3.5 shrink-0', view.where ? 'text-foreground' : 'text-faint')}
          aria-label={view.where ? 'These rows are filtered' : undefined}
        />
        <Part
          keyword="WHERE"
          className="flex-[3]"
          applied={view.where}
          draft={where}
          resets={resets.where}
          label={`Filter for ${tab.table.table}, as it would follow WHERE`}
          placeholder="a condition, then Enter. Empty for every row"
          table={tab.table.table}
          columns={columns}
          clearTitle="Remove the filter"
          onDraft={setWhere}
          onApply={(text) => apply({ where: text, orderBy })}
          onClear={() => clear('where')}
        />
        <Part
          keyword="ORDER BY"
          className="flex-[2]"
          applied={view.orderBy}
          draft={orderBy}
          resets={resets.orderBy}
          label={`Order for ${tab.table.table}, as it would follow ORDER BY`}
          placeholder="columns to order by"
          table={tab.table.table}
          columns={columns}
          clearTitle="Remove the order"
          onDraft={setOrderBy}
          onApply={(text) => apply({ where, orderBy: text })}
          onClear={() => clear('orderBy')}
        />
        {dirty && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={tab.running}
            title="Ask the database for the rows again (Enter)"
            onClick={() => apply()}
          >
            Apply
          </Button>
        )}
        {children}
      </div>
      {tab.viewProblem && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-border bg-card px-2 py-1.5 text-[12px] text-destructive" role="alert">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="selectable">{tab.viewProblem}</span>
        </div>
      )}
    </>
  )
}
