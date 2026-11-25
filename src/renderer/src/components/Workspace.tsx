import { useState } from 'react'
import { ChevronDown, Database, LoaderCircle, Play, Plus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/menu'
import { SqlEditor, focusEditor, runAllStatements, runCurrentStatement } from '@/editor/SqlEditor'
import { tintStyle } from '@/lib/hues'
import { MOD, cn } from '@/lib/utils'
import { ResultsPanel } from '@/results/ResultsPanel'
import { SYSTEM_DATABASES, countChanges, useStore, type Tab } from '@/store'
import { ResizeHandle } from './ResizeHandle'

function TabStrip() {
  const tabs = useStore((state) => state.tabs)
  const activeTabId = useStore((state) => state.activeTabId)
  const connections = useStore((state) => state.connections)
  const { setActiveTab, closeTab, newTab } = useStore.getState()
  const active = tabs.find((tab) => tab.id === activeTabId)

  return (
    <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-card pl-1.5 pr-1" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === activeTabId
        const hue = connections.find((connection) => connection.id === tab.connectionId)?.hue
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-tint
            style={hue === undefined ? undefined : tintStyle(hue)}
            onMouseDown={(event) => {
              if (event.button === 0) setActiveTab(tab.id)
            }}
            onAuxClick={(event) => {
              if (event.button === 1) closeTab(tab.id)
            }}
            className={cn(
              'group relative -mb-px flex h-8 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 pl-2.5 pr-1 text-[12.5px]',
              selected
                ? 'border-border bg-background text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {selected && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t-md bg-tint" />}
            {tab.running ? (
              <LoaderCircle className="size-3 shrink-0 animate-spin text-tint" />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-tint" />
            )}
            <span className="truncate">{tab.title}</span>
            {tab.results.some((entry) => countChanges(entry.staged) > 0) && (
              <span className="-ml-0.5 shrink-0 font-semibold" title="Has unsaved changes" aria-label="Has unsaved changes">
                *
              </span>
            )}
            <button
              title={`Close (${MOD}+W)`}
              aria-label={`Close ${tab.title}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => closeTab(tab.id)}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                !selected && 'opacity-0 group-hover:opacity-100',
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        )
      })}
      {active && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="mb-1 ml-1"
          title={`New query (${MOD}+T)`}
          aria-label="New query"
          onClick={() => newTab(active.connectionId, { database: active.database })}
        >
          <Plus />
        </Button>
      )}
    </div>
  )
}

function DatabasePicker({ tab }: { tab: Tab }) {
  const databases = useStore((state) => state.live[tab.connectionId]?.databases)
  const { setTabDatabase } = useStore.getState()
  const own = (databases ?? []).filter((name) => !SYSTEM_DATABASES.has(name))
  const system = (databases ?? []).filter((name) => SYSTEM_DATABASES.has(name))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" title="Database this tab runs against" className="max-w-[220px] text-foreground">
          <Database className="text-muted-foreground" />
          <span className={cn('truncate', !tab.database && 'text-muted-foreground')}>
            {tab.database ?? 'No database'}
          </span>
          <ChevronDown className="text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => (event.preventDefault(), focusEditor())}>
        {!databases?.length && <DropdownMenuLabel>Connecting…</DropdownMenuLabel>}
        {own.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => void setTabDatabase(tab.id, name)}>
            <Database />
            {name}
          </DropdownMenuItem>
        ))}
        {own.length > 0 && system.length > 0 && <DropdownMenuSeparator />}
        {system.length > 0 && <DropdownMenuLabel>System</DropdownMenuLabel>}
        {system.map((name) => (
          <DropdownMenuItem key={name} onSelect={() => void setTabDatabase(tab.id, name)}>
            <Database />
            {name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Toolbar({ tab }: { tab: Tab }) {
  const { cancel } = useStore.getState()
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
      {tab.running ? (
        <Button variant="danger" onClick={() => void cancel(tab.id)} disabled={tab.cancelRequested}>
          <Square />
          {tab.cancelRequested ? 'Stopping…' : 'Stop'}
        </Button>
      ) : (
        <Button
          variant="tint"
          title={`Run the statement under the cursor, or the selection (${MOD}+Enter)`}
          onClick={() => (runCurrentStatement(), focusEditor())}
        >
          <Play />
          Run
        </Button>
      )}
      <Button
        variant="ghost"
        disabled={tab.running}
        title={`Run every statement in this tab (${MOD}+Shift+Enter)`}
        onClick={() => (runAllStatements(), focusEditor())}
      >
        Run all
      </Button>
      <div className="mx-1 h-4 w-px bg-border" />
      <DatabasePicker tab={tab} />
      {tab.transaction && (
        <span
          role="status"
          className="ml-1 shrink-0 rounded-sm border border-border-strong px-1.5 py-0.5 text-[11.5px] font-medium text-foreground"
          title="This tab has a transaction open. COMMIT keeps what it changed and ROLLBACK takes it back. Closing the tab, disconnecting or quitting rolls it back."
        >
          Transaction open
        </span>
      )}
    </div>
  )
}

const EDITOR_HEIGHT_KEY = 'editorHeight'

export function Workspace({ tab }: { tab: Tab }) {
  const [editorHeight, setEditorHeight] = useState(() => Number(localStorage.getItem(EDITOR_HEIGHT_KEY)) || 240)

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TabStrip />
      <Toolbar tab={tab} />
      <div className="shrink-0" style={{ height: editorHeight }}>
        <SqlEditor tab={tab} />
      </div>
      <ResizeHandle
        axis="y"
        value={editorHeight}
        min={80}
        max={Math.max(120, window.innerHeight - 260)}
        onChange={(height) => {
          setEditorHeight(height)
          localStorage.setItem(EDITOR_HEIGHT_KEY, String(height))
        }}
      />
      <div className="min-h-0 flex-1">
        <ResultsPanel tab={tab} />
      </div>
    </div>
  )
}
