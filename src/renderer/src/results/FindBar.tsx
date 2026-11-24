import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { formatCount, plural } from '@/lib/format'
import { cn } from '@/lib/utils'

interface FindBarProps {
  /** The text being looked for. Empty when nothing is. */
  find: string
  /** How many of the loaded rows contain it. */
  matches: number
  /** How many rows are loaded. */
  loaded: number
  /** More rows exist in the database than were loaded. */
  truncated: boolean
  onFind(text: string): void
  children?: ReactNode
}

/**
 * Looks through the rows that are already loaded. It is not a query: nothing
 * is sent to the database, and a row beyond the row limit cannot be found
 * here. The bar says so for as long as a search is on.
 */
export function FindBar({ find, matches, loaded, truncated, onFind, children }: FindBarProps) {
  // Kept short enough to be read whole beside the box, and said in full on hover in case it is not.
  const scope = truncated
    ? `Rows beyond the first ${formatCount(loaded)} are in the database and are not searched.`
    : 'Searched here, in the rows that were loaded. The database is not asked again.'
  return (
    <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-border bg-card pl-2 pr-1.5 text-[12px]">
      <Search className={cn('size-3.5 shrink-0', find ? 'text-foreground' : 'text-faint')} />
      <div
        className={cn(
          'flex h-6 w-[240px] shrink-0 items-center rounded-sm border bg-background focus-within:border-ring',
          find ? 'border-border-strong' : 'border-border',
        )}
      >
        <input
          value={find}
          spellCheck={false}
          aria-label="Find in the rows that are loaded"
          placeholder={`Find in the ${plural(loaded, 'row')} loaded`}
          className="selectable h-full min-w-0 flex-1 bg-transparent px-1.5 text-[12px] text-foreground outline-none placeholder:text-faint"
          onChange={(event) => onFind(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && find) {
              event.preventDefault()
              onFind('')
            }
          }}
        />
        {find && (
          <button
            type="button"
            title="Show every loaded row again"
            aria-label="Show every loaded row again"
            className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onFind('')}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      {find ? (
        <span className="flex min-w-0 items-baseline gap-2" role="status">
          <span className="shrink-0 font-medium">
            {formatCount(matches)} of {plural(loaded, 'loaded row')}
          </span>
          <span
            className={cn('truncate', truncated ? 'font-medium text-foreground' : 'text-muted-foreground')}
            title={scope}
          >
            {scope}
          </span>
        </span>
      ) : (
        <span className="truncate text-faint">
          {truncated ? 'Looks through the rows loaded here, not the ones beyond the limit.' : 'Looks through the rows loaded here.'}
        </span>
      )}
      <div className="flex-1" />
      {children}
    </div>
  )
}
