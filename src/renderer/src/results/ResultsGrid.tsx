import { memo, useMemo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { KeyRound } from 'lucide-react'
import type { CellValue, ResultColumn, RowsResult } from '@shared/driver'
import { cellText, formatBytes, isBinary } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CellRef } from '@/store'

type Row = CellValue[]

// TanStack Table tracks column widths and resizing; the rows are virtualized separately.
const features = tableFeatures({ columnSizingFeature, columnResizingFeature })

const ROW_HEIGHT = 28
const HEADER_HEIGHT = 44
const GUTTER_WIDTH = 56
/** Advance width of one character of the grid's 12px monospace font. */
const CHAR_WIDTH = 7.25
/** Longer text is cut for display only; the inspector and copy use the full value. */
const MAX_CELL_CHARS = 300

function estimateWidth(column: ResultColumn, rows: Row[], index: number): number {
  let chars = Math.max(column.name.length + (column.primaryKey ? 3 : 1), column.dbType.length * 0.85)
  const sample = Math.min(rows.length, 80)
  for (let r = 0; r < sample; r++) {
    const value = rows[r][index]
    const length = value === null ? 4 : isBinary(value) ? 26 : String(value).length
    if (length > chars) chars = length
  }
  return Math.round(Math.min(Math.max(chars * CHAR_WIDTH + 24, 64), 360))
}

function renderValue(value: CellValue, column: ResultColumn): ReactNode {
  if (value === null) return <span className="cell-null">NULL</span>
  if (isBinary(value)) {
    return (
      <span className="text-muted-foreground">
        0x{value.preview}
        {value.bytes > 32 ? '…' : ''}
        <span className="ml-2 text-faint">{formatBytes(value.bytes)}</span>
      </span>
    )
  }
  if (typeof value === 'number') return value
  const text = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value
  if (column.kind === 'json') return <span className="text-[var(--syn-type)]">{text}</span>
  return text
}

interface GridRowProps {
  index: number
  top: number
  row: Row
  columns: ResultColumn[]
  cellStyles: CSSProperties[]
  /** Selected column in this row, or -1. */
  selectedCol: number
}

const GridRow = memo(function GridRow({ index, top, row, columns, cellStyles, selectedCol }: GridRowProps) {
  return (
    <div
      role="row"
      className="grid-row"
      data-row={index}
      data-selected={selectedCol >= 0}
      style={{ top, width: 'var(--grid-width)' }}
    >
      <div className="grid-gutter">{index + 1}</div>
      {row.map((value, col) => (
        <div
          key={col}
          role="gridcell"
          data-col={col}
          data-selected={col === selectedCol}
          className={cn('grid-cell', columns[col].kind === 'number' && value !== null && 'cell-number')}
          style={cellStyles[col]}
        >
          {renderValue(value, columns[col])}
        </div>
      ))}
    </div>
  )
})

interface ResultsGridProps {
  result: RowsResult
  selected: CellRef | null
  onSelect(cell: CellRef): void
  /** Asks to show the selected value in full. */
  onOpen(): void
}

export function ResultsGrid({ result, selected, onSelect, onOpen }: ResultsGridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const { rows } = result

  const columns = useMemo<ColumnDef<typeof features, Row>[]>(
    () =>
      result.columns.map((column, index) => ({
        id: String(index),
        accessorFn: (row: Row) => row[index],
        size: estimateWidth(column, result.rows, index),
        minSize: 44,
        maxSize: 2400,
      })),
    [result],
  )

  const table = useTable({ features, columns, data: rows, columnResizeMode: 'onChange' })
  const headers = table.getHeaderGroups()[0]?.headers ?? []
  const widths = headers.map((header) => header.getSize())
  const gridWidth = GUTTER_WIDTH + widths.reduce((sum, width) => sum + width, 0)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  })

  // Widths live in CSS variables so resizing a column re-renders no rows.
  const sizeVars: Record<string, string> = { '--grid-width': `${gridWidth}px` }
  widths.forEach((width, index) => {
    sizeVars[`--w-${index}`] = `${width}px`
  })
  const cellStyles = useMemo<CSSProperties[]>(
    () => result.columns.map((_, index) => ({ width: `var(--w-${index})` })),
    [result.columns],
  )

  const reveal = (cell: CellRef) => {
    virtualizer.scrollToIndex(cell.row, { align: 'auto' })
    const element = scroller.current
    if (!element) return
    const left = widths.slice(0, cell.col).reduce((sum, width) => sum + width, 0)
    const right = left + widths[cell.col]
    const visible = element.clientWidth - GUTTER_WIDTH
    if (left < element.scrollLeft) element.scrollLeft = left
    else if (right > element.scrollLeft + visible) element.scrollLeft = right - visible
  }

  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const cell = target.closest<HTMLElement>('[data-col]')
    const row = target.closest<HTMLElement>('[data-row]')
    if (!cell || !row) return
    onSelect({ row: Number(row.dataset.row), col: Number(cell.dataset.col) })
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!selected || rows.length === 0) return
    const mod = event.ctrlKey || event.metaKey
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT) - 2)
    let { row, col } = selected

    switch (event.key) {
      case 'ArrowDown':
        row += 1
        break
      case 'ArrowUp':
        row -= 1
        break
      case 'ArrowRight':
        col += 1
        break
      case 'ArrowLeft':
        col -= 1
        break
      case 'PageDown':
        row += page
        break
      case 'PageUp':
        row -= page
        break
      case 'Home':
        col = 0
        if (mod) row = 0
        break
      case 'End':
        col = result.columns.length - 1
        if (mod) row = rows.length - 1
        break
      case 'Enter':
        event.preventDefault()
        onOpen()
        return
      case 'c':
      case 'C':
        if (!mod) return
        event.preventDefault()
        void navigator.clipboard.writeText(cellText(rows[row][col]))
        return
      default:
        return
    }

    event.preventDefault()
    const next = {
      row: Math.min(Math.max(row, 0), rows.length - 1),
      col: Math.min(Math.max(col, 0), result.columns.length - 1),
    }
    onSelect(next)
    reveal(next)
  }

  return (
    <div
      ref={scroller}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length}
      aria-colcount={result.columns.length}
      className="h-full overflow-auto bg-background outline-none"
      style={sizeVars as CSSProperties}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative"
        style={{ height: virtualizer.getTotalSize(), width: 'var(--grid-width)', minWidth: '100%' }}
        onMouseDown={handleMouseDown}
        onDoubleClick={onOpen}
      >
        <div
          role="row"
          className="sticky top-0 z-20 flex border-b border-border bg-card"
          style={{ height: HEADER_HEIGHT, width: 'var(--grid-width)', minWidth: '100%' }}
        >
          <div
            className="sticky left-0 z-10 shrink-0 border-r border-border bg-card"
            style={{ width: GUTTER_WIDTH }}
          />
          {headers.map((header, index) => {
            const column = result.columns[index]
            return (
              <div
                key={header.id}
                role="columnheader"
                className="relative flex shrink-0 flex-col justify-center border-r border-border px-2.5"
                style={cellStyles[index]}
                title={column.table ? `${column.table}.${column.name}` : column.name}
              >
                <div className="flex items-center gap-1 text-[12px] font-medium leading-tight">
                  {column.primaryKey && <KeyRound className="size-3 shrink-0 text-tint" aria-label="Primary key" />}
                  <span className="truncate">{column.name}</span>
                </div>
                <div className="truncate font-mono text-[10px] leading-tight tracking-wide text-faint">
                  {column.dbType}
                </div>
                <div
                  className={cn(
                    'absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-tint/50',
                    header.column.getIsResizing() && 'bg-tint',
                  )}
                  onMouseDown={(event) => {
                    event.stopPropagation()
                    header.getResizeHandler()(event)
                  }}
                  onTouchStart={header.getResizeHandler()}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    header.column.resetSize()
                  }}
                />
              </div>
            )
          })}
        </div>

        {virtualizer.getVirtualItems().map((item) => (
          <GridRow
            key={item.index}
            index={item.index}
            top={item.start}
            row={rows[item.index]}
            columns={result.columns}
            cellStyles={cellStyles}
            selectedCol={selected?.row === item.index ? selected.col : -1}
          />
        ))}
      </div>
    </div>
  )
}
