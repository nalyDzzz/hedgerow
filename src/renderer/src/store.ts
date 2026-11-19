import { create } from 'zustand'
import type { ConnectionInput, SavedConnection } from '@shared/api'
import type { StatementResult, TableInfo } from '@shared/driver'
import { changesSchema } from './lib/sql'

const api = window.api

export interface SchemaState {
  status: 'loading' | 'ready' | 'failed'
  tables: TableInfo[]
  error?: string
}

/** A saved connection that is open right now. */
export interface LiveConnection {
  status: 'connecting' | 'connected' | 'failed'
  error?: string
  /** Session used for the schema tree. Query tabs each get their own. */
  sessionId?: string
  serverVersion?: string
  databases: string[]
  schemas: Record<string, SchemaState>
}

export interface ResultEntry {
  sql: string
  result: StatementResult
}

export interface CellRef {
  row: number
  col: number
}

export interface Tab {
  id: string
  connectionId: string
  title: string
  database: string | null
  sessionId: string | null
  sql: string
  running: boolean
  cancelRequested: boolean
  results: ResultEntry[]
  activeResult: number
  selected: CellRef | null
  rowLimit: number
}

export type DialogState =
  | { mode: 'closed' }
  | { mode: 'new' }
  | { mode: 'edit'; connection: SavedConnection }

interface NewTabOptions {
  database?: string | null
  sql?: string
  title?: string
  run?: boolean
}

interface State {
  connections: SavedConnection[]
  loaded: boolean
  live: Record<string, LiveConnection>
  tabs: Tab[]
  activeTabId: string | null
  /** Connection last touched in the sidebar; decides the tint when no tab is open. */
  focusedConnectionId: string | null
  expanded: Record<string, boolean>
  dialog: DialogState
  inspectorOpen: boolean

  loadConnections(): Promise<void>
  saveConnection(input: ConnectionInput): Promise<SavedConnection>
  removeConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  loadSchema(connectionId: string, database: string, force?: boolean): Promise<void>
  toggleNode(key: string, open?: boolean): void
  focusConnection(id: string): void

  newTab(connectionId: string, options?: NewTabOptions): string
  closeTab(id: string): void
  setActiveTab(id: string): void
  setTabSql(id: string, sql: string): void
  setTabDatabase(id: string, database: string): Promise<void>
  setRowLimit(id: string, rowLimit: number): void
  run(id: string, statements: string[]): Promise<void>
  cancel(id: string): Promise<void>
  selectCell(id: string, cell: CellRef | null): void
  setActiveResult(id: string, index: number): void

  setDialog(dialog: DialogState): void
  setInspectorOpen(open: boolean): void
}

export const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export const ROW_LIMITS = [500, 1000, 5000, 25_000, 100_000]

let queryCounter = 0

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useStore = create<State>()((set, get) => {
  const patchTab = (id: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab,
      ),
    }))

  const patchLive = (id: string, patch: Partial<LiveConnection>) =>
    set((state) => {
      const current = state.live[id]
      if (!current) return state
      return { live: { ...state.live, [id]: { ...current, ...patch } } }
    })

  const tabById = (id: string) => get().tabs.find((tab) => tab.id === id)

  return {
    connections: [],
    loaded: false,
    live: {},
    tabs: [],
    activeTabId: null,
    focusedConnectionId: null,
    expanded: {},
    dialog: { mode: 'closed' },
    inspectorOpen: false,

    async loadConnections() {
      const connections = await api.connections.list()
      set({ connections, loaded: true })
    },

    async saveConnection(input) {
      const before = get().connections.find((connection) => connection.id === input.id)
      const saved = await api.connections.save(input)
      await get().loadConnections()
      // If where or how we connect changed, sessions opened with the old settings are stale.
      const reconnect =
        before !== undefined &&
        (input.password !== undefined ||
          before.host !== saved.host ||
          before.port !== saved.port ||
          before.user !== saved.user ||
          before.database !== saved.database ||
          before.tls !== saved.tls)
      if (reconnect && get().live[saved.id]) await get().disconnect(saved.id)
      return saved
    },

    async removeConnection(id) {
      await get().disconnect(id)
      for (const tab of get().tabs.filter((tab) => tab.connectionId === id)) get().closeTab(tab.id)
      await api.connections.remove(id)
      await get().loadConnections()
      if (get().focusedConnectionId === id) set({ focusedConnectionId: null })
    },

    async connect(id) {
      const existing = get().live[id]
      if (existing && existing.status !== 'failed') return
      set((state) => ({
        live: { ...state.live, [id]: { status: 'connecting', databases: [], schemas: {} } },
      }))
      try {
        const info = await api.sessions.open(id)
        const databases = await api.sessions.listDatabases(info.sessionId)
        patchLive(id, {
          status: 'connected',
          sessionId: info.sessionId,
          serverVersion: info.serverVersion,
          databases,
        })
        get().toggleNode(`c:${id}`, true)
      } catch (error) {
        patchLive(id, { status: 'failed', error: message(error) })
      }
    },

    async disconnect(id) {
      const live = get().live[id]
      if (!live) return
      const sessions = [
        live.sessionId,
        ...get()
          .tabs.filter((tab) => tab.connectionId === id)
          .map((tab) => tab.sessionId),
      ].filter((sessionId): sessionId is string => Boolean(sessionId))
      set((state) => {
        const rest = { ...state.live }
        delete rest[id]
        return {
          live: rest,
          tabs: state.tabs.map((tab) => (tab.connectionId === id ? { ...tab, sessionId: null } : tab)),
        }
      })
      await Promise.allSettled(sessions.map((sessionId) => api.sessions.close(sessionId)))
    },

    async loadSchema(connectionId, database, force = false) {
      const live = get().live[connectionId]
      if (!live?.sessionId) return
      const current = live.schemas[database]
      if (current && (current.status === 'loading' || (current.status === 'ready' && !force))) return

      const setSchema = (schema: SchemaState) => {
        const latest = get().live[connectionId]
        if (latest) patchLive(connectionId, { schemas: { ...latest.schemas, [database]: schema } })
      }

      setSchema({ status: 'loading', tables: current?.tables ?? [] })
      try {
        const tables = await api.sessions.describeDatabase(live.sessionId, database)
        setSchema({ status: 'ready', tables })
      } catch (error) {
        setSchema({ status: 'failed', tables: [], error: message(error) })
      }
    },

    toggleNode(key, open) {
      set((state) => ({ expanded: { ...state.expanded, [key]: open ?? !state.expanded[key] } }))
    },

    focusConnection(id) {
      set({ focusedConnectionId: id })
    },

    newTab(connectionId, options = {}) {
      const connection = get().connections.find((c) => c.id === connectionId)
      const database = options.database ?? (connection?.database || null)
      const tab: Tab = {
        id: crypto.randomUUID(),
        connectionId,
        title: options.title ?? `Query ${++queryCounter}`,
        database,
        sessionId: null,
        sql: options.sql ?? '',
        running: false,
        cancelRequested: false,
        results: [],
        activeResult: 0,
        selected: null,
        rowLimit: 1000,
      }
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id, focusedConnectionId: connectionId }))

      void get()
        .connect(connectionId)
        .then(() => {
          if (database) void get().loadSchema(connectionId, database)
        })
      if (options.run && tab.sql) void get().run(tab.id, [tab.sql])
      return tab.id
    },

    closeTab(id) {
      const tab = tabById(id)
      if (!tab) return
      if (tab.sessionId) {
        const { sessionId } = tab
        const closing = tab.running ? api.sessions.cancel(sessionId).catch(() => {}) : Promise.resolve()
        void closing.then(() => api.sessions.close(sessionId)).catch(() => {})
      }
      set((state) => {
        const index = state.tabs.findIndex((t) => t.id === id)
        const tabs = state.tabs.filter((t) => t.id !== id)
        const activeTabId =
          state.activeTabId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTabId
        return { tabs, activeTabId }
      })
    },

    setActiveTab(id) {
      const tab = tabById(id)
      if (tab) set({ activeTabId: id, focusedConnectionId: tab.connectionId })
    },

    setTabSql(id, sql) {
      patchTab(id, { sql })
    },

    async setTabDatabase(id, database) {
      const tab = tabById(id)
      if (!tab) return
      patchTab(id, { database })
      void get().loadSchema(tab.connectionId, database)
      if (tab.sessionId) await api.sessions.setDatabase(tab.sessionId, database)
    },

    setRowLimit(id, rowLimit) {
      patchTab(id, { rowLimit })
    },

    async run(id, statements) {
      const tab = tabById(id)
      if (!tab || tab.running || statements.length === 0) return
      patchTab(id, { running: true, cancelRequested: false, results: [], activeResult: 0, selected: null })

      let current = statements[0]
      try {
        let sessionId = tab.sessionId
        if (!sessionId) {
          const info = await api.sessions.open(tab.connectionId, tab.database ?? undefined)
          if (!tabById(id)) {
            void api.sessions.close(info.sessionId)
            return
          }
          sessionId = info.sessionId
          patchTab(id, { sessionId, database: info.database })
        }

        for (const sql of statements) {
          // Stop may have been pressed while the session was still opening.
          if (tabById(id)?.cancelRequested) break
          current = sql
          const result = await api.sessions.execute(sessionId, sql, { rowLimit: tab.rowLimit })
          patchTab(id, (latest) => ({
            results: [...latest.results, { sql, result }],
            activeResult: latest.results.length,
            database: result.database,
          }))
          if (result.kind === 'error' || tabById(id)?.cancelRequested) break
        }
      } catch (error) {
        // The call itself failed, so the session is gone; the next run opens a new one.
        patchTab(id, (latest) => ({
          sessionId: null,
          results: [
            ...latest.results,
            {
              sql: current,
              result: { kind: 'error', message: message(error), durationMs: 0, database: latest.database },
            },
          ],
          activeResult: latest.results.length,
        }))
      } finally {
        patchTab(id, { running: false, cancelRequested: false })
      }

      const after = tabById(id)
      if (after?.database && statements.some(changesSchema)) {
        void get().loadSchema(after.connectionId, after.database, true)
      }
    },

    async cancel(id) {
      const tab = tabById(id)
      if (!tab?.running) return
      patchTab(id, { cancelRequested: true })
      if (tab.sessionId) await api.sessions.cancel(tab.sessionId).catch(() => {})
    },

    selectCell(id, cell) {
      patchTab(id, { selected: cell })
    },

    setActiveResult(id, index) {
      patchTab(id, { activeResult: index, selected: null })
    },

    setDialog(dialog) {
      set({ dialog })
    },

    setInspectorOpen(open) {
      set({ inspectorOpen: open })
    },
  }
})

/** The connection whose color tints the window. */
export function useActiveConnection(): SavedConnection | undefined {
  return useStore((state) => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    const id = tab?.connectionId ?? state.focusedConnectionId
    return state.connections.find((connection) => connection.id === id)
  })
}

export function useActiveTab(): Tab | undefined {
  return useStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId))
}
