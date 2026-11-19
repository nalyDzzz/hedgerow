import { useEffect, useState } from 'react'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { EmptyState } from '@/components/EmptyState'
import { ResizeHandle } from '@/components/ResizeHandle'
import { Sidebar } from '@/components/Sidebar'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import { Workspace } from '@/components/Workspace'
import { useActiveConnection, useActiveTab, useStore } from '@/store'

const SIDEBAR_WIDTH_KEY = 'sidebarWidth'

export function App() {
  const tab = useActiveTab()
  const connection = useActiveConnection()
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 260)

  useEffect(() => {
    void useStore.getState().loadConnections()
  }, [])

  // Tint the whole window, dialogs and menus included, with the active connection's color.
  useEffect(() => {
    const root = document.documentElement
    if (connection) {
      root.style.setProperty('--conn-h', String(connection.hue))
      root.style.setProperty('--conn-c', 'var(--tint-chroma)')
    } else {
      root.style.setProperty('--conn-c', '0')
    }
  }, [connection])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const state = useStore.getState()
      const active = state.tabs.find((t) => t.id === state.activeTabId)
      const key = event.key.toLowerCase()

      if (key === 't') {
        const connectionId = active?.connectionId ?? state.focusedConnectionId ?? state.connections[0]?.id
        if (!connectionId) return
        event.preventDefault()
        state.newTab(connectionId, { database: active?.database })
      } else if (key === 'w' && active) {
        event.preventDefault()
        state.closeTab(active.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <div className="shrink-0" style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>
        <ResizeHandle
          axis="x"
          value={sidebarWidth}
          min={180}
          max={520}
          onChange={(width) => {
            setSidebarWidth(width)
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
          }}
        />
        <main className="min-w-0 flex-1">{tab ? <Workspace tab={tab} /> : <EmptyState />}</main>
      </div>
      <StatusBar />
      <ConnectionDialog />
    </div>
  )
}
