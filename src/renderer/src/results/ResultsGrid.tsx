import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Ban, Copy, Eraser, KeyRound, Lock, PanelRight, Pencil, Trash2, Undo2 } from 'lucide-react'
import type { CellValue, ResultColumn, RowsResult } from '@shared/driver'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { cellText, formatBytes, isBinary } from '@/lib/format'
import { MOD, cn, shortcut } from '@/lib/utils'
import type { CellRef, StagedChanges } from '@/store'

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

/** A value that a one-line box would damage or cannot show whole. */
function needsRoom(value: CellValue): boolean {
  return typeof value === 'string' && (value.length > MAX_CELL_CHARS || /[\r\n]/.test(value))
}

interface GridRowProps {
  index: number
  top: number
  row: Row
  columns: ResultColumn[]
  cellStyles: CSSProperties[]
  /** Selected column in this row, or -1. */
  selectedCol: number
  /** Values staged for this row, by column, when it has any. */
  edits: Record<number, string | null> | undefined
  /** The row is marked to be deleted. */
  deleted: boolean
}

const GridRow = memo(function GridRow({
  index,
  top,
  row,
  columns,
  cellStyles,
  selectedCol,
  edits,
  deleted,
}: GridRowProps) {
  return (
    <div
      role="row"
      className="grid-row"
      data-row={index}
      data-selected={selectedCol >= 0}
      data-changed={edits !== undefined || undefined}
      data-deleted={deleted || undefined}
      style={{ top, width: 'var(--grid-width)' }}
    >
      <div className="grid-gutter">{index + 1}</div>
      {row.map((stored, col) => {
        const changed = edits !== undefined && col in edits
        const value = changed ? edits[col] : stored
        return (
          <div
            key={col}
            role="gridcell"
            data-col={col}
            data-selected={col === selectedCol}
            data-changed={changed || undefined}
            className={cn('grid-cell', columns[col].kind === 'number' && value !== null && 'cell-number')}
            style={cellStyles[col]}
          >
            {renderValue(value, columns[col])}
          </div>
        )
      })}
    </div>
  )
})

/** How an edit in place ended. `value` is absent when nothing was typed, which changes nothing. */
interface EditOutcome {
  value?: string | null
  /** Tab moves on to the next cell, Shift+Tab back to the one before. */
  move?: 1 | -1
  /** The edit was ended from the keyboard, so the keyboard goes back to the grid. */
  refocus?: boolean
}

interface CellEditorProps {
  style: CSSProperties
  initial: string
  /** The first key press already replaced the old value. */
  typed: boolean
  /** The cell holds NULL, which the box shows until something is typed. */
  holdsNull: boolean
  nullable: boolean
  alignRight: boolean
  onDone(outcome: EditOutcome): void
}

/**
 * A text box in place of one cell. An untouched box changes nothing, so opening
 * a NULL cell and leaving it does not turn the NULL into an empty string.
 * Emptying the box means an empty string; NULL has its own button.
 */
function CellEditor({ style, initial, typed, holdsNull, nullable, alignRight, onDone }: CellEditorProps) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(initial)
  const [touched, setTouched] = useState(typed)
  const closed = useRef(false)

  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.focus({ preventScroll: true })
    if (typed) element.setSelectionRange(element.value.length, element.value.length)
    else element.select()
  }, [typed])

  const done = (outcome: EditOutcome) => {
    if (closed.current) return
    closed.current = true
    onDone(outcome)
  }
  const typedValue = (): EditOutcome => (touched ? { value: text } : {})

  return (
    <div data-editor className="cell-editor" style={style}>
      <input
        ref={input}
        value={text}
        spellCheck={false}
        aria-label="New value"
        // Shown while the box is empty: what an empty box will store.
        placeholder={holdsNull && !touched ? 'NULL' : 'empty text'}
        className={cn('selectable', alignRight && 'text-right')}
        onChange={(event) => {
          setText(event.target.value)
          setTouched(true)
        }}
        onBlur={() => done(typedValue())}
        onKeyDown={(event) => {
          // Keys typed here are text, not grid navigation.
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            done({ ...typedValue(), refocus: true })
          } else if (event.key === 'Escape') {
            event.preventDefault()
            done({ refocus: true })
          } else if (event.key === 'Tab') {
            event.preventDefault()
            done({ ...typedValue(), move: event.shiftKey ? -1 : 1, refocus: true })
          }
        }}
      />
      {nullable && (
        <button
          type="button"
          tabIndex={-1}
          title="Store NULL instead of text"
          // Keep the focus in the box, so the click is not first taken as leaving it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => done({ value: null, refocus: true })}
        >
          NULL
        </button>
      )}
    </div>
  )
}

function Shortcut({ children }: { children: string }) {
  return <span className="ml-auto pl-6 text-[11px] text-faint">{children}</span>
}

interface ResultsGridProps {
  result: RowsResult
  selected: CellRef | null
  /** Unsaved changes to show in place of the stored values. */
  staged: StagedChanges | undefined
  /** False while the result must not be changed, such as during a save. */
  editable: boolean
  onSelect(cell: CellRef): void
  /** Asks to show the selected value in full. */
  onOpen(): void
  /** Asks to edit a value in the value panel, where there is room for it. */
  onEditInPanel(cell: CellRef): void
  onStage(cell: CellRef, value: string | null): void
  onRevert(cell: CellRef): void
  onDeleteRow(row: number, deleted: boolean): void
}

export function ResultsGrid({
  result,
  selected,
  staged,
  editable,
  onSelect,
  onOpen,
  onEditInPanel,
  onStage,
  onRevert,
  onDeleteRow,
}: ResultsGridProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<(CellRef & { initial: string; typed: boolean }) | null>(null)
  const { rows } = result
  const editing = editable ? result.editing : undefined

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

  /** The value a cell shows: the staged one if it has one, otherwise what is stored. */
  const shown = (cell: CellRef): CellValue => {
    const change = staged?.cells[cell.row]?.[cell.col]
    return change !== undefined && !staged?.deleted[cell.row] ? change : rows[cell.row][cell.col]
  }
  const isChanged = (cell: CellRef) => staged?.cells[cell.row]?.[cell.col] !== undefined
  const isDeleted = (row: number) => Boolean(staged?.deleted[row])
  /** A row can only be changed if the values that identify it are all there. */
  const hasKey = (row: number) => Boolean(editing?.key.every((col) => rows[row][col] !== null))
  const canChange = (cell: CellRef) =>
    Boolean(editing?.editable.includes(cell.col)) && hasKey(cell.row) && !isDeleted(cell.row)
  const acceptsNull = (col: number) => Boolean(editing?.nullable.includes(col))

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

  const select = (cell: CellRef) => {
    const next = {
      row: Math.min(Math.max(cell.row, 0), rows.length - 1),
      col: Math.min(Math.max(cell.col, 0), result.columns.length - 1),
    }
    onSelect(next)
    reveal(next)
  }

  /**
   * Starts editing a cell. `typed` is the key that started it, which replaces
   * the old value. A value with line breaks, or too long to see whole, is
   * edited in the value panel instead: a one-line box would flatten it.
   */
  const startEdit = (cell: CellRef, typed?: string) => {
    if (!canChange(cell)) return false
    const value = shown(cell)
    if (typed === undefined && needsRoom(value)) {
      onEditInPanel(cell)
      return true
    }
    reveal(cell)
    setEditor({ ...cell, initial: typed ?? (value === null ? '' : String(value)), typed: typed !== undefined })
    return true
  }

  const finishEdit = ({ value, move, refocus }: EditOutcome) => {
    if (!editor) return
    const cell = { row: editor.row, col: editor.col }
    setEditor(null)
    if (value !== undefined) onStage(cell, value)
    if (move) select({ row: cell.row, col: cell.col + move })
    // Not after a click elsewhere: the focus belongs to whatever was clicked.
    if (refocus) scroller.current?.focus({ preventScroll: true })
  }

  const cellAt = (target: EventTarget): CellRef | null => {
    const element = target as HTMLElement
    const cell = element.closest<HTMLElement>('[data-col]')
    const row = element.closest<HTMLElement>('[data-row]')
    return cell && row ? { row: Number(row.dataset.row), col: Number(cell.dataset.col) } : null
  }

  const handleMouseDown = (event: MouseEvent) => {
    const cell = cellAt(event.target)
    if (cell) onSelect(cell)
  }

  const handleDoubleClick = (event: MouseEvent) => {
    const cell = cellAt(event.target)
    if (cell && !startEdit(cell)) onOpen()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!selected || rows.length === 0) return
    const mod = event.ctrlKey || event.metaKey
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT) - 2)
    let { row, col } = selected

    if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      void navigator.clipboard.writeText(cellText(shown(selected)))
      return
    }

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
      case 'F2':
        event.preventDefault()
        if (!startEdit(selected) && event.key === 'Enter') onOpen()
        return
      case 'Delete':
      case 'Backspace':
        // Clearing a cell means NULL, where the column allows it.
        if (mod || !canChange(selected) || !acceptsNull(selected.col)) return
        event.preventDefault()
        onStage(selected, null)
        return
      default:
        // Typing on a cell starts editing it, and replaces what it held.
        if (event.key.length === 1 && !mod && !event.altKey && startEdit(selected, event.key)) {
          event.preventDefault()
        }
        return
    }

    event.preventDefault()
    select({ row, col })
  }

  const editorStyle = (cell: CellRef): CSSProperties => ({
    top: HEADER_HEIGHT + cell.row * ROW_HEIGHT,
    left: GUTTER_WIDTH + widths.slice(0, cell.col).reduce((sum, width) => sum + width, 0),
    width: widths[cell.col],
    height: ROW_HEIGHT,
  })

  const menuCell = selected && selected.row < rows.length ? selected : null
  const menuColumn = menuCell ? result.columns[menuCell.col] : undefined

  return (
    <div
      ref={scroller}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length}
      aria-colcount={result.columns.length}
      aria-readonly={!editing}
      className="h-full overflow-auto bg-background outline-none"
      style={sizeVars as CSSProperties}
      onKeyDown={handleKeyDown}
    >
      <ContextMenu>
        <ContextMenuTrigger
          asChild
          // The menu is about a cell, so it has nothing to offer on the header or past the last row.
          onContextMenu={(event) => {
            if (!cellAt(event.target)) event.preventDefault()
          }}
        >
          <div
            className="relative"
            style={{ height: virtualizer.getTotalSize(), width: 'var(--grid-width)', minWidth: '100%' }}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
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
                const fixed = editing !== undefined && !editing.editable.includes(index)
                const name = column.table ? `${column.table}.${column.name}` : column.name
                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    className="relative flex shrink-0 flex-col justify-center border-r border-border px-2.5"
                    style={cellStyles[index]}
                    title={fixed ? `${name}. This column cannot be edited here.` : name}
                  >
                    <div className="flex items-center gap-1 text-[12px] font-medium leading-tight">
                      {column.primaryKey && <KeyRound className="size-3 shrink-0 text-tint" aria-label="Primary key" />}
                      <span className="truncate">{column.name}</span>
                      {fixed && <Lock className="size-2.5 shrink-0 text-faint" aria-label="Cannot be edited" />}
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

            {virtualizer.getVirtualItems().map((item) => {
              const deleted = isDeleted(item.index)
              return (
                <GridRow
                  key={item.index}
                  index={item.index}
                  top={item.start}
                  row={rows[item.index]}
                  columns={result.columns}
                  cellStyles={cellStyles}
                  selectedCol={selected?.row === item.index ? selected.col : -1}
                  // A row that will be deleted shows what is stored, struck through.
                  edits={deleted ? undefined : staged?.cells[item.index]}
                  deleted={deleted}
                />
              )
            })}

            {editor && (
              <CellEditor
                key={`${editor.row}:${editor.col}`}
                style={editorStyle(editor)}
                initial={editor.initial}
                typed={editor.typed}
                holdsNull={shown(editor) === null}
                nullable={acceptsNull(editor.col)}
                alignRight={result.columns[editor.col].kind === 'number'}
                onDone={finishEdit}
              />
            )}
          </div>
        </ContextMenuTrigger>

        {menuCell && menuColumn && (
          <ContextMenuContent
            // Without this the grid would lose the keyboard when the menu closes.
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!document.activeElement?.closest('[data-editor]')) scroller.current?.focus({ preventScroll: true })
            }}
          >
            {editing && (
              <>
                <ContextMenuItem disabled={!canChange(menuCell)} onSelect={() => startEdit(menuCell)}>
                  <Pencil />
                  Edit
                  <Shortcut>Enter</Shortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!canChange(menuCell) || !acceptsNull(menuCell.col) || shown(menuCell) === null}
                  onSelect={() => onStage(menuCell, null)}
                >
                  <Ban />
                  Set to NULL
                  <Shortcut>Del</Shortcut>
                </ContextMenuItem>
                {menuColumn.kind === 'text' && (
                  <ContextMenuItem
                    disabled={!canChange(menuCell) || shown(menuCell) === ''}
                    onSelect={() => onStage(menuCell, '')}
                  >
                    <Eraser />
                    Set to empty text
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  disabled={!isChanged(menuCell) || isDeleted(menuCell.row)}
                  onSelect={() => onRevert(menuCell)}
                >
                  <Undo2 />
                  Undo this change
                </ContextMenuItem>
                <ContextMenuSeparator />
                {isDeleted(menuCell.row) ? (
                  <ContextMenuItem onSelect={() => onDeleteRow(menuCell.row, false)}>
                    <Undo2 />
                    Keep row
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem
                    destructive
                    disabled={!hasKey(menuCell.row)}
                    onSelect={() => onDeleteRow(menuCell.row, true)}
                  >
                    <Trash2 />
                    Delete row
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(cellText(shown(menuCell)))}>
              <Copy />
              Copy
              <Shortcut>{shortcut(MOD, 'C')}</Shortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={onOpen}>
              <PanelRight />
              Show in value panel
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
    </div>
  )
}
