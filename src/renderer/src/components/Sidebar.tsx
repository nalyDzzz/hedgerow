import { useState, type ReactNode } from 'react'
import {
  ChevronRight,
  Database,
  Eye,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Table2,
  Trash2,
  Unplug,
} from 'lucide-react'
import type { SavedConnection } from '@shared/api'
import type { TableInfo } from '@shared/driver'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { tintStyle } from '@/lib/hues'
import { cn } from '@/lib/utils'
import { SYSTEM_DATABASES, useStore, type LiveConnection } from '@/store'

interface TreeRowProps {
  depth: number
  /** Omit for a leaf. */
  expanded?: boolean
  icon?: ReactNode
  label: ReactNode
  trailing?: ReactNode
  title?: string
  dimmed?: boolean
  /** The connection the window is working in. */
  current?: boolean
  /** The row last clicked in the tree. */
  selected?: boolean
  /** Opens or closes the row's children. The chevron always does this. */
  onToggle?(): void
  onClick?(): void
  /**
   * The row's own action, such as opening a table. A row that has one is opened and
   * closed with its chevron only: if a click on the row did it too, both clicks of a
   * double-click would, and the children would flash open and shut.
   */
  onDoubleClick?(): void
}

function TreeRow({
  depth,
  expanded,
  icon,
  label,
  trailing,
  title,
  dimmed,
  current,
  selected,
  onToggle,
  onClick,
  onDoubleClick,
}: TreeRowProps) {
  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={selected || current}
      title={title}
      onClick={() => {
        onClick?.()
        if (!onDoubleClick) onToggle?.()
      }}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: 6 + depth * 14 }}
      className={cn(
        'group/row flex h-[26px] items-center gap-1.5 pr-1.5 text-[12.5px] hover:bg-muted',
        current && 'bg-muted',
        selected && 'bg-tint-soft hover:bg-tint-soft',
        dimmed && 'text-muted-foreground',
      )}
    >
      {expanded === undefined ? (
        <span className="size-3 shrink-0" />
      ) : (
        // Wider than the arrow it shows, so it is easy to hit; the margins keep the row's spacing.
        // Hidden from assistive technology because the row itself says whether it is expanded.
        <span
          aria-hidden="true"
          data-chevron
          className="-mx-1 flex h-full w-5 shrink-0 items-center justify-center text-faint hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            onToggle?.()
          }}
          // Two quick clicks on the arrow open and close the row. They are not the row's double-click.
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        </span>
      )}
      {icon}
      <span className="min-w-[40%] flex-1 truncate">{label}</span>
      {trailing}
    </div>
  )
}

function Note({ depth, children, tone }: { depth: number; children: ReactNode; tone?: 'error' }) {
  return (
    <div
      style={{ paddingLeft: 6 + depth * 14 + 18 }}
      className={cn(
        'selectable py-1 pr-2 text-[12px] leading-snug',
        tone === 'error' ? 'text-destructive' : 'text-faint',
      )}
    >
      {children}
    </div>
  )
}

function TableNode({ connectionId, database, table }: { connectionId: string; database: string; table: TableInfo }) {
  const key = `t:${connectionId}:${database}:${table.name}`
  const expanded = useStore((state) => Boolean(state.expanded[key]))
  const selected = useStore((state) => state.selectedNode === key)
  const { toggleNode, selectNode, newTab } = useStore.getState()
  const Icon = table.type === 'view' ? Eye : Table2

  return (
    <>
      <TreeRow
        depth={2}
        expanded={expanded}
        icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        label={table.name}
        title={`${table.name} (${table.type}). Double-click to open its rows.`}
        selected={selected}
        onToggle={() => toggleNode(key)}
        onClick={() => selectNode(key)}
        onDoubleClick={() =>
          newTab(connectionId, {
            database,
            title: table.name,
            table: { database, table: table.name },
            run: true,
          })
        }
      />
      {expanded &&
        table.columns.map((column) => (
          <TreeRow
            key={column.name}
            depth={3}
            icon={
              column.key === 'primary' ? (
                <KeyRound className="size-3 shrink-0 text-tint" aria-label="Primary key" />
              ) : (
                <span className="size-3 shrink-0" />
              )
            }
            label={column.name}
            title={`${column.name} ${column.dataType}${column.nullable ? '' : ' NOT NULL'}`}
            trailing={<span className="min-w-0 truncate font-mono text-[10.5px] text-faint">{column.dataType}</span>}
          />
        ))}
    </>
  )
}

function DatabaseNode({ connectionId, database, live }: { connectionId: string; database: string; live: LiveConnection }) {
  const key = `d:${connectionId}:${database}`
  const expanded = useStore((state) => Boolean(state.expanded[key]))
  const selected = useStore((state) => state.selectedNode === key)
  const { toggleNode, selectNode, loadSchema, newTab } = useStore.getState()
  const schema = live.schemas[database]

  return (
    <>
      <TreeRow
        depth={1}
        expanded={expanded}
        dimmed={SYSTEM_DATABASES.has(database)}
        icon={<Database className="size-3.5 shrink-0 text-muted-foreground" />}
        label={database}
        trailing={
          schema?.status === 'loading' ? <LoaderCircle className="size-3 animate-spin text-faint" /> : undefined
        }
        title={`${database}. Double-click for a new query on it.`}
        selected={selected}
        onToggle={() => {
          toggleNode(key)
          if (!expanded) void loadSchema(connectionId, database)
        }}
        onClick={() => selectNode(key)}
        onDoubleClick={() => newTab(connectionId, { database })}
      />
      {expanded && schema?.status === 'failed' && (
        <Note depth={2} tone="error">
          {schema.error}
        </Note>
      )}
      {expanded && schema?.status === 'ready' && schema.tables.length === 0 && (
        <Note depth={2}>No tables yet.</Note>
      )}
      {expanded &&
        schema?.tables.map((table) => (
          <TableNode key={table.name} connectionId={connectionId} database={database} table={table} />
        ))}
    </>
  )
}

function ConnectionNode({ connection, onDelete }: { connection: SavedConnection; onDelete(): void }) {
  const key = `c:${connection.id}`
  const live = useStore((state) => state.live[connection.id]) as LiveConnection | undefined
  const expanded = useStore((state) => Boolean(state.expanded[key]))
  const focused = useStore((state) => state.focusedConnectionId === connection.id)
  const { connect, disconnect, refreshConnection, toggleNode, selectNode, focusConnection, newTab, setDialog } =
    useStore.getState()
  const disconnected = !live || live.status === 'failed'

  const databases = [...(live?.databases ?? [])].sort(
    (a, b) => Number(SYSTEM_DATABASES.has(a)) - Number(SYSTEM_DATABASES.has(b)) || a.localeCompare(b),
  )

  return (
    <div data-tint style={tintStyle(connection.hue)}>
      <ContextMenu onOpenChange={(open) => open && focusConnection(connection.id)}>
        <ContextMenuTrigger asChild>
          <div>
            <TreeRow
              depth={0}
              expanded={expanded && live?.status === 'connected'}
              current={focused}
              icon={
                live?.status === 'connecting' ? (
                  <LoaderCircle className="size-3 shrink-0 animate-spin text-tint" />
                ) : (
                  <span
                    className={cn(
                      'mx-[3px] size-2 shrink-0 rounded-full',
                      live?.status === 'connected' ? 'bg-tint' : 'border-[1.5px] border-tint',
                    )}
                    aria-label={live?.status === 'connected' ? 'Connected' : 'Not connected'}
                  />
                )
              }
              label={<span className="font-medium">{connection.name}</span>}
              title={`${connection.user}@${connection.host}:${connection.port}`}
              trailing={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5 opacity-0 group-hover/row:opacity-100"
                  title="New query"
                  aria-label={`New query on ${connection.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    newTab(connection.id)
                  }}
                  // Otherwise two quick clicks here would open a third tab as the row's double-click.
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Plus />
                </Button>
              }
              onToggle={() => {
                if (disconnected) void connect(connection.id)
                else toggleNode(key)
              }}
              onClick={() => {
                focusConnection(connection.id)
                selectNode(key)
                // Connecting shows the databases once, however many clicks follow.
                if (disconnected) void connect(connection.id)
              }}
              onDoubleClick={() => newTab(connection.id)}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => newTab(connection.id)}>
            <SquareTerminal />
            New query
          </ContextMenuItem>
          <ContextMenuItem disabled={live?.status !== 'connected'} onSelect={() => void refreshConnection(connection.id)}>
            <RefreshCw />
            Refresh
          </ContextMenuItem>
          <ContextMenuItem disabled={!live} onSelect={() => void disconnect(connection.id)}>
            <Unplug />
            Disconnect
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setDialog({ mode: 'edit', connection })}>
            <Pencil />
            Edit connection
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={onDelete}>
            <Trash2 />
            Delete connection
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {live?.status === 'failed' && (
        <Note depth={0} tone="error">
          {live.error}
          <button className="ml-1.5 underline underline-offset-2" onClick={() => void connect(connection.id)}>
            Try again
          </button>
        </Note>
      )}
      {expanded &&
        live?.status === 'connected' &&
        databases.map((database) => (
          <DatabaseNode key={database} connectionId={connection.id} database={database} live={live} />
        ))}
    </div>
  )
}

export function Sidebar() {
  const connections = useStore((state) => state.connections)
  const loaded = useStore((state) => state.loaded)
  const { setDialog, removeConnection } = useStore.getState()
  const [deleting, setDeleting] = useState<SavedConnection | null>(null)

  return (
    <nav className="flex h-full min-w-0 flex-col bg-card" aria-label="Connections">
      <div className="flex h-9 shrink-0 items-center justify-between pl-3 pr-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Connections</span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="New connection"
          aria-label="New connection"
          onClick={() => setDialog({ mode: 'new' })}
        >
          <Plus />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2" role="tree">
        {loaded && connections.length === 0 && (
          <p className="px-3 py-1 text-[12px] leading-snug text-faint">
            Nothing saved yet. Add a connection to browse its databases here.
          </p>
        )}
        {connections.map((connection) => (
          <ConnectionNode key={connection.id} connection={connection} onDelete={() => setDeleting(connection)} />
        ))}
      </div>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="w-[380px] p-4">
          <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
          <DialogDescription className="mt-1.5">
            This removes the saved connection and its password from this computer, and closes its query tabs. The
            database itself is not touched.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button size="lg">Cancel</Button>
            </DialogClose>
            <Button
              size="lg"
              variant="danger"
              onClick={() => {
                if (deleting) void removeConnection(deleting.id)
                setDeleting(null)
              }}
            >
              Delete connection
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </nav>
  )
}
