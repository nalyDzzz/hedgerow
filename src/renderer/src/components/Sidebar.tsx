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
  selected?: boolean
  onClick?(): void
  onDoubleClick?(): void
}

function TreeRow({ depth, expanded, icon, label, trailing, title, dimmed, selected, onClick, onDoubleClick }: TreeRowProps) {
  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={selected}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ paddingLeft: 6 + depth * 14 }}
      className={cn(
        'group/row flex h-[26px] items-center gap-1.5 pr-1.5 text-[12.5px] hover:bg-muted',
        selected && 'bg-muted',
        dimmed && 'text-muted-foreground',
      )}
    >
      <ChevronRight
        className={cn(
          'size-3 shrink-0 text-faint transition-transform',
          expanded && 'rotate-90',
          expanded === undefined && 'invisible',
        )}
      />
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
  const { toggleNode, newTab } = useStore.getState()
  const Icon = table.type === 'view' ? Eye : Table2

  return (
    <>
      <TreeRow
        depth={2}
        expanded={expanded}
        icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
        label={table.name}
        title={`${table.name} (${table.type}). Double-click to open its rows.`}
        onClick={() => toggleNode(key)}
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
  const { toggleNode, loadSchema, newTab } = useStore.getState()
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
        onClick={() => {
          toggleNode(key)
          if (!expanded) void loadSchema(connectionId, database)
        }}
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
  const { connect, disconnect, toggleNode, focusConnection, newTab, setDialog, loadSchema } = useStore.getState()

  const databases = [...(live?.databases ?? [])].sort(
    (a, b) => Number(SYSTEM_DATABASES.has(a)) - Number(SYSTEM_DATABASES.has(b)) || a.localeCompare(b),
  )

  const refresh = async () => {
    const open = Object.keys(live?.schemas ?? {})
    await disconnect(connection.id)
    await connect(connection.id)
    for (const database of open) void loadSchema(connection.id, database)
  }

  return (
    <div data-tint style={tintStyle(connection.hue)}>
      <ContextMenu onOpenChange={(open) => open && focusConnection(connection.id)}>
        <ContextMenuTrigger asChild>
          <div>
            <TreeRow
              depth={0}
              expanded={expanded && live?.status === 'connected'}
              selected={focused}
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
                >
                  <Plus />
                </Button>
              }
              onClick={() => {
                focusConnection(connection.id)
                if (!live || live.status === 'failed') void connect(connection.id)
                else toggleNode(key)
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
          <ContextMenuItem disabled={live?.status !== 'connected'} onSelect={() => void refresh()}>
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
