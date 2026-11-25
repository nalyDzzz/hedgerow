import { create } from 'zustand'
import type { ConnectionInput, SavedConnection } from '@shared/api'
import type {
  CellValue,
  RowChange,
  RowsResult,
  SaveResult,
  StatementResult,
  TableInfo,
  TableRef,
  TableView,
  ViewChange,
} from '@shared/driver'
import { plainNumber } from './lib/format'
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
  /** How a session on this connection reads a backslash in a string when it opens. */
  backslashEscapes?: boolean
  databases: string[]
  schemas: Record<string, SchemaState>
}

/** A row added in the grid that is not in the database yet. */
export interface NewRow {
  /** Tells new rows apart while they wait to be saved. */
  id: number
  /**
   * The values given so far, by column. A column that is absent is not set,
   * which is not the same as NULL: the table decides what it holds.
   */
  cells: Record<number, string | null>
}

/**
 * Changes made in the grid that have not been saved. Rows and columns are
 * numbered as in the result they belong to.
 */
export interface StagedChanges {
  /** New values of edited cells, by row and then by column. NULL and '' are different values. */
  cells: Record<number, Record<number, string | null>>
  /** Rows marked to be deleted. */
  deleted: Record<number, true>
  /**
   * Rows to add, oldest first. They have no number in the result, so the grid
   * shows them after its rows and counts on from the last one.
   */
  added: NewRow[]
}

export interface ResultEntry {
  /** Stays the same when a save reloads the rows, so the grid keeps its place. */
  id: number
  sql: string
  result: StatementResult
  staged?: StagedChanges
  /** How many changes the last save wrote. Shown until something else happens to this result. */
  saved?: number
  /** How many rows that save added which the rows read back afterwards do not include. */
  outside?: number
  /** Text looked for in the rows that are loaded. It narrows what the grid shows and is never sent to the database. */
  find?: string
  /** How many times a filter or an order put new rows in this entry's place. The grid goes back to the top when it changes. */
  views?: number
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
  /**
   * The table this tab was opened to show. Null for a tab that began as a
   * query, and from the moment its SQL is edited, because it may then show anything.
   */
  table: TableRef | null
  /** The filter and the order the table is shown with. Only means something while `table` is set. */
  view: TableView
  /**
   * The column a click on a header ordered the rows by, with the order the
   * driver wrote for it. It stands for as long as `view.orderBy` is that text.
   */
  sorted: SortedBy | null
  /** Why the last change to the view could not be made, when the driver refused it. */
  viewProblem: string | null
  sessionId: string | null
  /**
   * True while the tab's session has a transaction open: changes that are not
   * committed yet, and that are thrown away if the session ends first.
   */
  transaction: boolean
  /**
   * How the tab's session reads a backslash in a string, as it last said. Null
   * until the tab has had a session. The editor reads the tab's SQL the same way.
   */
  backslashEscapes: boolean | null
  sql: string
  running: boolean
  cancelRequested: boolean
  results: ResultEntry[]
  activeResult: number
  selected: CellRef | null
  rowLimit: number
}

export interface SortedBy {
  /** The column's name in the table. */
  column: string
  direction: 'asc' | 'desc'
  orderBy: string
}

export const NO_VIEW: TableView = { where: '', orderBy: '' }

/** Said wherever a tab finds that its connection is gone, before the way to carry on. */
export const CONNECTION_LOST =
  'The connection to the server was lost, and with it anything this tab had open there, such as a transaction.'

export type DialogState =
  | { mode: 'closed' }
  | { mode: 'new' }
  | { mode: 'edit'; connection: SavedConnection }

interface NewTabOptions {
  database?: string | null
  sql?: string
  title?: string
  run?: boolean
  /** Opens the tab on this table's rows. */
  table?: TableRef
}

/** Asked before something in a tab would be thrown away: changes made in a grid, or an open transaction. */
export interface DiscardPrompt {
  tabId: string
  /** How many changes made in the grid are not saved. */
  changes: number
  /** True when closing the tab would end a session that has a transaction open, which rolls it back. */
  transaction: boolean
  /** What the person was doing: running a statement replaces the results, closing removes them. */
  reason: 'run' | 'close'
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
  /** Key of the sidebar row last clicked. */
  selectedNode: string | null
  dialog: DialogState
  inspectorOpen: boolean
  discardPrompt: DiscardPrompt | null

  loadConnections(): Promise<void>
  saveConnection(input: ConnectionInput): Promise<SavedConnection>
  removeConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  /**
   * Reads the list of databases and the open schemas again. Query tabs keep their
   * sessions, and whatever they have open on the server.
   */
  refreshConnection(id: string): Promise<void>
  loadSchema(connectionId: string, database: string, force?: boolean): Promise<void>
  toggleNode(key: string, open?: boolean): void
  selectNode(key: string): void
  focusConnection(id: string): void

  newTab(connectionId: string, options?: NewTabOptions): void
  closeTab(id: string): void
  setActiveTab(id: string): void
  setTabSql(id: string, sql: string): void
  setTabDatabase(id: string, database: string): Promise<void>
  setRowLimit(id: string, rowLimit: number): void
  run(id: string, statements: string[]): Promise<void>
  cancel(id: string): Promise<void>
  selectCell(id: string, cell: CellRef | null): void
  setActiveResult(id: string, index: number): void

  /**
   * Shows a table tab's rows with a filter and an order as they were typed. The
   * database runs the statement again, and the editor shows that statement.
   */
  applyView(id: string, view: TableView): Promise<void>
  /** The same for a change asked for in the grid, which the driver writes: a value picked from a cell, or a column to order by. */
  changeView(id: string, change: ViewChange): Promise<void>
  /** Narrows the active result to the loaded rows that contain `text`. Nothing is sent to the database. */
  setFind(id: string, text: string): void

  /** Stages a new value for a cell of the active result. Nothing is sent to the database. */
  stageCell(id: string, cell: CellRef, value: string | null): void
  revertCell(id: string, cell: CellRef): void
  /** Marks a row of the active result to be deleted, or takes the mark off. A new row is simply removed. */
  setRowDeleted(id: string, row: number, deleted: boolean): void
  /** Starts a new row after the rows of the active result and selects it. Nothing is sent to the database. */
  addRow(id: string): void
  /** Starts a new row holding what another row shows, except what the database numbers by itself. */
  duplicateRow(id: string, row: number): void
  discardChanges(id: string): void
  /** Asks the driver for the statements that would save the active result's changes. Runs nothing. */
  planSave(id: string): Promise<string[]>
  /**
   * Runs those statements in one transaction, then reloads the rows to show what
   * was stored. `entryId` names the result they were planned for, and they are
   * run for no other.
   */
  save(id: string, entryId: number, statements: string[]): Promise<SaveResult>
  /** Answers the question in `discardPrompt`. */
  answerDiscard(discard: boolean): void

  setDialog(dialog: DialogState): void
  setInspectorOpen(open: boolean): void
}

export const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export const ROW_LIMITS = [500, 1000, 5000, 25_000, 100_000]

let queryCounter = 0
let resultCounter = 0
let newRowCounter = 0
/** What to carry on with if the person agrees to discard their changes. */
let afterDiscard: (() => void) | null = null
/** Shows a statement the app wrote in a tab's editor. Set by the editor, which the store knows nothing else about. */
let showInEditor: (tabId: string, sql: string) => void = () => {}

/**
 * Registers the editor to be told, at that moment, when the app has written a
 * tab's statement itself. The editor is not driven by the store: what is typed
 * goes from the editor to the store, and this is the only thing that goes back.
 */
export function onStatementWritten(show: (tabId: string, sql: string) => void): void {
  showInEditor = show
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a result says about how its session reads a backslash, as the tab keeps it. Nothing when it does not say. */
function stringReading(result: StatementResult): Pick<Tab, 'backslashEscapes'> | Record<string, never> {
  return result.backslashEscapes === undefined ? {} : { backslashEscapes: result.backslashEscapes }
}

/** How many changes are staged: every edited cell, every row marked to be deleted, and every new row. */
export function countChanges(staged: StagedChanges | undefined): number {
  if (!staged) return 0
  let count = Object.keys(staged.deleted).length + staged.added.length
  for (const [row, cells] of Object.entries(staged.cells)) {
    // A row that will be deleted counts once, whatever was typed into it first.
    if (!staged.deleted[Number(row)]) count += Object.keys(cells).length
  }
  return count
}

function unsavedChanges(tab: Tab): number {
  return tab.results.reduce((sum, entry) => sum + countChanges(entry.staged), 0)
}

/** True when a typed value is what the cell already holds. */
function sameAsStored(stored: CellValue, value: string | null): boolean {
  if (stored === null || value === null) return stored === value
  return typeof stored !== 'object' && String(stored) === value
}

function cellChanges(cells: Record<number, string | null>): { column: number; value: string | null }[] {
  return Object.entries(cells)
    .map(([column, value]) => ({ column: Number(column), value }))
    .sort((a, b) => a.column - b.column)
}

/**
 * The staged changes as the driver wants them: one per changed row, top to
 * bottom, then the new rows. New rows go last so that one can take a value a
 * deleted or edited row gives up, such as a unique email address.
 */
function rowChanges(rows: CellValue[][], key: number[], staged: StagedChanges): RowChange[] {
  const changed = new Set([...Object.keys(staged.cells), ...Object.keys(staged.deleted)].map(Number))
  const existing = [...changed]
    .sort((a, b) => a - b)
    .map((row): RowChange => {
      const rowKey = key.map((column) => rows[row][column])
      if (staged.deleted[row]) return { kind: 'delete', key: rowKey }
      return { kind: 'update', key: rowKey, set: cellChanges(staged.cells[row]) }
    })
  return [...existing, ...staged.added.map((row): RowChange => ({ kind: 'insert', set: cellChanges(row.cells) }))]
}

/**
 * How many of the rows a save added are not among the rows read back after it.
 * A statement's conditions, its order or the row limit can leave a new row out,
 * and then it would vanish from the grid without a word.
 *
 * A row is looked for by its key: what was typed for it, or the number the
 * database generated. Where the key is not known, or is of a kind whose stored
 * form may differ from what was typed, nothing is claimed.
 */
function rowsOutside(before: RowsResult, added: NewRow[], ids: (string | null)[], after: StatementResult): number {
  const editing = before.editing
  if (!editing || added.length === 0 || after.kind !== 'rows') return 0
  if (after.columns.length !== before.columns.length) return 0
  const { key } = editing
  const kinds = key.map((column) => before.columns[column].kind)
  if (!kinds.every((kind) => kind === 'number' || kind === 'text')) return 0
  // 007 and 7 are the same number, and a CHAR column drops the spaces typed after a value.
  // Null when a number is written in a way that cannot be compared digit by digit, such as 1e3.
  const comparable = (values: CellValue[]) => {
    const parts = values.map((value, at) => (kinds[at] === 'number' ? plainNumber(value) : String(value).trimEnd()))
    return parts.includes(null) ? null : JSON.stringify(parts)
  }

  const present = new Set(after.rows.map((row) => comparable(key.map((column) => row[column]))))
  const auto = editing.adding?.auto ?? []
  let outside = 0
  added.forEach((row, index) => {
    const values = key.map((column) => row.cells[column] ?? (auto.includes(column) ? ids[index] : null))
    if (values.includes(null)) return
    const wanted = comparable(values)
    if (wanted !== null && !present.has(wanted)) outside += 1
  })
  return outside
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

  /** Changes the staged changes of a tab's active result, if that result can be edited. */
  const restage = (id: string, change: (staged: StagedChanges, entry: ResultEntry) => StagedChanges | undefined) =>
    patchTab(id, (tab) => {
      const entry = tab.results[tab.activeResult] as ResultEntry | undefined
      if (entry?.result.kind !== 'rows' || !entry.result.editing) return {}
      const staged = change(entry.staged ?? { cells: {}, deleted: {}, added: [] }, entry)
      const next: ResultEntry = {
        ...entry,
        staged: countChanges(staged) > 0 ? staged : undefined,
        saved: undefined,
        outside: undefined,
      }
      const total = entry.result.rows.length + (next.staged?.added.length ?? 0)
      return {
        results: tab.results.map((item) => (item === entry ? next : item)),
        // A new row that was removed may have been the selected one. Stay near where it was.
        selected:
          tab.selected && tab.selected.row >= total
            ? total > 0
              ? { ...tab.selected, row: total - 1 }
              : null
            : tab.selected,
      }
    })

  /** Appends a new row to the active result, holding `cells`, and selects it in `column`. */
  const appendRow = (id: string, cells: Record<number, string | null>, column?: number) => {
    const tab = tabById(id)
    const entry = tab?.results[tab.activeResult]
    if (!tab || tab.running || entry?.result.kind !== 'rows' || !entry.result.editing?.adding) return
    const { editing, rows } = entry.result
    const before = entry.staged?.added.length ?? 0
    restage(id, (staged) => ({ ...staged, added: [...staged.added, { id: ++newRowCounter, cells }] }))
    // Start where typing is likely to: the first column the database does not fill in by itself.
    const first = editing.editable.find((index) => !editing.adding!.auto.includes(index)) ?? editing.editable[0] ?? 0
    patchTab(id, { selected: { row: rows.length + before, col: column ?? first } })
  }

  /**
   * Holds back something that would throw away unsaved changes until the person
   * has agreed. Returns true when it did, and `proceed` then runs on their yes.
   */
  const askBeforeDiscarding = (tab: Tab, reason: DiscardPrompt['reason'], proceed: () => void): boolean => {
    const changes = unsavedChanges(tab)
    // Running a statement leaves a transaction as it is. Closing the tab ends its session, and the transaction with it.
    const transaction = reason === 'close' && tab.transaction
    if (changes === 0 && !transaction) return false
    afterDiscard = proceed
    set({ discardPrompt: { tabId: tab.id, changes, transaction, reason } })
    return true
  }

  const dropChanges = (id: string) =>
    patchTab(id, (tab) => ({ results: tab.results.map((entry) => ({ ...entry, staged: undefined })) }))

  /** The tab's own session, opened on first use. Null when the tab was closed while it opened. */
  const sessionFor = async (id: string): Promise<string | null> => {
    const tab = tabById(id)
    if (!tab) return null
    if (tab.sessionId) return tab.sessionId
    const info = await api.sessions.open(tab.connectionId, tab.database ?? undefined)
    if (!tabById(id)) {
      void api.sessions.close(info.sessionId)
      return null
    }
    patchTab(id, { sessionId: info.sessionId, database: info.database, backslashEscapes: info.backslashEscapes })
    return info.sessionId
  }

  /** Lets go of a tab's session once its connection has failed, so that what the tab does next opens another. */
  const forgetSession = (id: string, sessionId: string) => {
    patchTab(id, (tab) => (tab.sessionId === sessionId ? { sessionId: null, transaction: false } : {}))
    void api.sessions.close(sessionId).catch(() => {})
  }

  /**
   * Says why something asked of a tab's session failed. If its connection is gone, the
   * session is let go and the answer says so, with `again` as the way to carry on.
   * Any other failure is passed on as it came.
   */
  const explainFailure = async (id: string, sessionId: string, error: unknown, again: string): Promise<string> => {
    if (await api.sessions.usable(sessionId).catch(() => false)) return message(error)
    forgetSession(id, sessionId)
    return `${CONNECTION_LOST} ${again}`
  }

  const createTab = (connectionId: string, options: NewTabOptions): Tab => {
    const connection = get().connections.find((c) => c.id === connectionId)
    const database = options.database ?? (connection?.database || null)
    const tab: Tab = {
      id: crypto.randomUUID(),
      connectionId,
      title: options.title ?? `Query ${++queryCounter}`,
      database,
      table: options.table ?? null,
      view: NO_VIEW,
      sorted: null,
      viewProblem: null,
      sessionId: null,
      transaction: false,
      backslashEscapes: null,
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
    return tab
  }

  /**
   * Runs the statement a view made and puts its rows where the table's rows
   * were. The result keeps its place in the tab, so the grid keeps its column
   * widths and stays scrolled to the column that was just sorted or filtered.
   */
  const reload = async (id: string, sql: string) => {
    const tab = tabById(id)
    const entry = tab?.results.length === 1 ? tab.results[0] : undefined
    if (!tab || !entry) return get().run(id, [sql])

    const replace = (result: StatementResult) =>
      patchTab(id, (latest) => ({
        results: latest.results.map((item) =>
          item.id === entry.id ? { id: entry.id, sql, result, views: (entry.views ?? 0) + 1 } : item,
        ),
        database: result.database,
        transaction: result.transaction,
        ...stringReading(result),
      }))

    patchTab(id, { running: true, cancelRequested: false, selected: null })
    try {
      const sessionId = await sessionFor(id)
      if (sessionId) {
        const result = await api.sessions.execute(sessionId, sql, { rowLimit: tab.rowLimit })
        replace(result)
        if (result.kind === 'error' && result.connectionLost) forgetSession(id, sessionId)
      }
    } catch (error) {
      // The call itself failed, so the session is gone; the next run opens a new one.
      replace({ kind: 'error', message: message(error), durationMs: 0, database: tab.database, transaction: false })
      patchTab(id, { sessionId: null, transaction: false })
    } finally {
      patchTab(id, { running: false, cancelRequested: false })
    }
  }

  /**
   * Gives a table tab another view. The driver writes the statement, the editor
   * is handed it so that what ran can always be read there, and then it runs.
   */
  const openView = async (
    id: string,
    make: (sessionId: string, tab: Tab & { table: TableRef }) => Promise<Pick<Tab, 'view' | 'sorted'>>,
  ) => {
    const tab = tabById(id)
    if (!tab?.table || tab.running) return
    let sessionId: string | null = null
    try {
      sessionId = await sessionFor(id)
      if (!sessionId) return
      const next = await make(sessionId, tab as Tab & { table: TableRef })
      const sql = await api.sessions.tableQuery(sessionId, tab.table, next.view)
      const latest = tabById(id)
      // The SQL was edited while the driver answered. The tab is no longer just this table.
      if (!latest?.table || latest.running) return
      const proceed = () => {
        patchTab(id, { ...next, sql, viewProblem: null })
        showInEditor(id, sql)
        void reload(id, sql)
      }
      // New rows replace the ones on screen, and unsaved changes to them would go too.
      if (!askBeforeDiscarding(latest, 'run', proceed)) proceed()
    } catch (error) {
      const problem = sessionId
        ? await explainFailure(id, sessionId, error, 'Apply the view again to reconnect.')
        : message(error)
      patchTab(id, { viewProblem: problem })
    }
  }

  /** Opens a tab on a table's rows. The driver writes the statement: it knows how its database quotes a name. */
  const openTable = async (connectionId: string, table: TableRef) => {
    await get().connect(connectionId)
    // If connecting failed, the sidebar already says why.
    const sessionId = get().live[connectionId]?.sessionId
    if (!sessionId) return
    try {
      const sql = await api.sessions.tableQuery(sessionId, table)
      createTab(connectionId, { database: table.database, title: table.table, table, sql, run: true })
    } catch (error) {
      // The session behind the tree is gone, so the connection is too.
      patchLive(connectionId, { status: 'failed', error: message(error) })
    }
  }

  return {
    connections: [],
    loaded: false,
    live: {},
    tabs: [],
    activeTabId: null,
    focusedConnectionId: null,
    expanded: {},
    selectedNode: null,
    dialog: { mode: 'closed' },
    inspectorOpen: false,
    discardPrompt: null,

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
          before.tls !== saved.tls ||
          before.ca !== saved.ca)
      if (reconnect && get().live[saved.id]) await get().disconnect(saved.id)
      return saved
    },

    async removeConnection(id) {
      await get().disconnect(id)
      for (const tab of get().tabs.filter((tab) => tab.connectionId === id)) {
        // Deleting the connection was confirmed, and its dialog says the tabs go with it.
        dropChanges(tab.id)
        get().closeTab(tab.id)
      }
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
          backslashEscapes: info.backslashEscapes,
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
          tabs: state.tabs.map((tab) =>
            tab.connectionId === id ? { ...tab, sessionId: null, transaction: false } : tab,
          ),
        }
      })
      await Promise.allSettled(sessions.map((sessionId) => api.sessions.close(sessionId)))
    },

    async refreshConnection(id) {
      const live = get().live[id]
      if (!live?.sessionId || live.status !== 'connected') return get().connect(id)
      const open = Object.keys(live.schemas)
      try {
        patchLive(id, { databases: await api.sessions.listDatabases(live.sessionId) })
      } catch {
        // The session behind the tree is gone. It gets another. The tabs have sessions of
        // their own, and closing those would roll back whatever a tab has open.
        void api.sessions.close(live.sessionId).catch(() => {})
        try {
          const info = await api.sessions.open(id)
          const databases = await api.sessions.listDatabases(info.sessionId)
          patchLive(id, {
            sessionId: info.sessionId,
            serverVersion: info.serverVersion,
            backslashEscapes: info.backslashEscapes,
            databases,
          })
        } catch (error) {
          patchLive(id, { status: 'failed', error: message(error), sessionId: undefined })
          return
        }
      }
      for (const database of open) void get().loadSchema(id, database, true)
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

    selectNode(key) {
      set({ selectedNode: key })
    },

    focusConnection(id) {
      set({ focusedConnectionId: id })
    },

    newTab(connectionId, options = {}) {
      if (options.table && options.sql === undefined) void openTable(connectionId, options.table)
      else createTab(connectionId, options)
    },

    closeTab(id) {
      const tab = tabById(id)
      if (!tab) return
      if (askBeforeDiscarding(tab, 'close', () => get().closeTab(id))) return
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
      // Typed SQL may show anything, so the tab stops being a view of one table.
      patchTab(id, { sql, table: null, view: NO_VIEW, sorted: null, viewProblem: null })
    },

    async setTabDatabase(id, database) {
      const tab = tabById(id)
      if (!tab) return
      patchTab(id, { database })
      void get().loadSchema(tab.connectionId, database)
      if (!tab.sessionId) return
      try {
        await api.sessions.setDatabase(tab.sessionId, database)
      } catch {
        // The session is still on the database it was on, and the tab must not name another.
        // A session whose connection is gone says so at the next statement, and the one that
        // replaces it opens on the database chosen here.
        if (await api.sessions.usable(tab.sessionId).catch(() => false)) patchTab(id, { database: tab.database })
      }
    },

    setRowLimit(id, rowLimit) {
      patchTab(id, { rowLimit })
    },

    async run(id, statements) {
      const tab = tabById(id)
      if (!tab || tab.running || statements.length === 0) return
      // Running replaces the results, and unsaved changes to them would go too.
      if (askBeforeDiscarding(tab, 'run', () => void get().run(id, statements))) return
      patchTab(id, { running: true, cancelRequested: false, results: [], activeResult: 0, selected: null })

      let current = statements[0]
      try {
        const sessionId = await sessionFor(id)
        if (!sessionId) return

        for (const sql of statements) {
          // Stop may have been pressed while the session was still opening.
          if (tabById(id)?.cancelRequested) break
          current = sql
          const result = await api.sessions.execute(sessionId, sql, { rowLimit: tab.rowLimit })
          // The result says that the connection was lost. The next run opens another.
          if (result.kind === 'error' && result.connectionLost) forgetSession(id, sessionId)
          patchTab(id, (latest) => ({
            results: [...latest.results, { id: ++resultCounter, sql, result }],
            activeResult: latest.results.length,
            database: result.database,
            // A session that was let go has nothing open any more, whatever its last answer said.
            ...(latest.sessionId === sessionId ? { transaction: result.transaction } : {}),
            ...stringReading(result),
          }))
          if (result.kind === 'error' || tabById(id)?.cancelRequested) break
        }
      } catch (error) {
        // The call itself failed, so the session is gone; the next run opens a new one.
        patchTab(id, (latest) => ({
          sessionId: null,
          transaction: false,
          results: [
            ...latest.results,
            {
              id: ++resultCounter,
              sql: current,
              result: {
                kind: 'error',
                message: message(error),
                durationMs: 0,
                database: latest.database,
                transaction: false,
              },
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

    async applyView(id, view) {
      const typed = { where: view.where.trim(), orderBy: view.orderBy.trim() }
      await openView(id, async (_sessionId, tab) => ({
        view: typed,
        sorted: tab.sorted?.orderBy === typed.orderBy ? tab.sorted : null,
      }))
    },

    async changeView(id, change) {
      await openView(id, async (sessionId, tab) => {
        const view = await api.sessions.changeView(sessionId, tab.view, change)
        if (change.kind !== 'sort') return { view, sorted: tab.sorted?.orderBy === view.orderBy ? tab.sorted : null }
        const column = change.column.source?.column
        const sorted = change.direction && column ? { column, direction: change.direction, orderBy: view.orderBy } : null
        return { view, sorted }
      })
    },

    setFind(id, text) {
      patchTab(id, (tab) => ({
        results: tab.results.map((entry, index) =>
          index === tab.activeResult ? { ...entry, find: text || undefined } : entry,
        ),
      }))
    },

    stageCell(id, { row, col }, value) {
      restage(id, (staged, entry) => {
        if (entry.result.kind !== 'rows') return staged
        const { editing, rows } = entry.result
        if (!editing?.editable.includes(col)) return staged
        if (value === null && !editing.nullable.includes(col)) return staged
        if (row >= rows.length) {
          // A new row has nothing stored to compare with: whatever is typed is its value.
          const at = row - rows.length
          if (!staged.added[at]) return staged
          const added = staged.added.map((item, index) =>
            index === at ? { ...item, cells: { ...item.cells, [col]: value } } : item,
          )
          return { ...staged, added }
        }
        const stored = rows[row]?.[col]
        if (stored === undefined) return staged

        const cells = { ...staged.cells, [row]: { ...staged.cells[row] } }
        // Typing a cell back to what it holds takes the change away.
        if (sameAsStored(stored, value)) delete cells[row][col]
        else cells[row][col] = value
        if (Object.keys(cells[row]).length === 0) delete cells[row]
        return { ...staged, cells }
      })
    },

    revertCell(id, { row, col }) {
      restage(id, (staged, entry) => {
        const stored = entry.result.kind === 'rows' ? entry.result.rows.length : 0
        if (row >= stored) {
          // In a new row, taking a value back leaves the cell not set.
          const at = row - stored
          if (staged.added[at]?.cells[col] === undefined) return staged
          const added = staged.added.map((item, index) => {
            if (index !== at) return item
            const cells = { ...item.cells }
            delete cells[col]
            return { ...item, cells }
          })
          return { ...staged, added }
        }
        if (staged.cells[row]?.[col] === undefined) return staged
        const cells = { ...staged.cells, [row]: { ...staged.cells[row] } }
        delete cells[row][col]
        if (Object.keys(cells[row]).length === 0) delete cells[row]
        return { ...staged, cells }
      })
    },

    setRowDeleted(id, row, deleted) {
      restage(id, (staged, entry) => {
        if (entry.result.kind !== 'rows' || row < 0) return staged
        if (row >= entry.result.rows.length) {
          // A new row is not in the database, so there is nothing to mark: it just goes.
          const at = row - entry.result.rows.length
          return deleted ? { ...staged, added: staged.added.filter((_, index) => index !== at) } : staged
        }
        const marked = { ...staged.deleted }
        if (deleted) marked[row] = true
        else delete marked[row]
        return { ...staged, deleted: marked }
      })
    },

    addRow(id) {
      appendRow(id, {})
    },

    duplicateRow(id, row) {
      const tab = tabById(id)
      const entry = tab?.results[tab.activeResult]
      if (!tab || entry?.result.kind !== 'rows' || !entry.result.editing?.adding) return
      const { editing, rows } = entry.result
      const staged = entry.staged
      const cells: Record<number, string | null> = {}
      for (const column of editing.editable) {
        // A copy of a generated number would collide with the row it was copied from.
        if (editing.adding!.auto.includes(column)) continue
        if (row >= rows.length) {
          const given = staged?.added[row - rows.length]?.cells[column]
          if (given !== undefined) cells[column] = given
          continue
        }
        // The copy holds what the row shows, so an edit that is not saved yet goes with it.
        const change = staged?.deleted[row] ? undefined : staged?.cells[row]?.[column]
        const value = change !== undefined ? change : rows[row]?.[column]
        if (value === undefined || (typeof value === 'object' && value !== null)) continue
        cells[column] = value === null ? null : String(value)
      }
      appendRow(id, cells, tab.selected?.col)
    },

    discardChanges(id) {
      restage(id, () => undefined)
    },

    async planSave(id) {
      const tab = tabById(id)
      const entry = tab?.results[tab.activeResult]
      if (!tab || entry?.result.kind !== 'rows' || !entry.result.editing || !entry.staged) {
        throw new Error('There are no changes to save.')
      }
      const { columns, editing, rows } = entry.result
      const changes = rowChanges(rows, editing.key, entry.staged)
      const sessionId = await sessionFor(id)
      if (!sessionId) throw new Error('This tab was closed.')
      try {
        return await api.sessions.planEdits(sessionId, { columns, editing, changes })
      } catch (error) {
        throw new Error(await explainFailure(id, sessionId, error, 'Save again to reconnect.'))
      }
    },

    async save(id, entryId, statements) {
      const tab = tabById(id)
      const entry = tab?.results[tab.activeResult]
      if (!tab || !entry || tab.running) {
        return { ok: false, message: 'Wait for the running statement to finish, then save again.', durationMs: 0 }
      }
      if (entry.id !== entryId || countChanges(entry.staged) === 0) {
        return {
          ok: false,
          message: 'These statements were not planned for the changes that are on screen now. Close this and save again.',
          durationMs: 0,
        }
      }
      const replaceEntry = (patch: Partial<ResultEntry>) =>
        patchTab(id, (latest) => ({
          results: latest.results.map((item) => (item.id === entry.id ? { ...item, ...patch } : item)),
        }))

      patchTab(id, { running: true, cancelRequested: false })
      try {
        const sessionId = await sessionFor(id)
        if (!sessionId) return { ok: false, message: 'This tab was closed.', durationMs: 0 }
        const outcome = await api.sessions.applyEdits(sessionId, statements)
        if (!outcome.ok) {
          if (outcome.connectionLost) forgetSession(id, sessionId)
          return outcome
        }

        // The changes are in the database now, whatever happens to the reload below.
        replaceEntry({ staged: undefined, saved: countChanges(entry.staged), outside: undefined })
        // Read the rows again instead of trusting what was typed: the stored value is what
        // the server made of it, and a trigger or a default may have changed more.
        const result = await api.sessions.execute(sessionId, entry.sql, { rowLimit: tab.rowLimit })
        if (result.kind === 'error' && result.connectionLost) forgetSession(id, sessionId)
        // The new rows were the last statements, in the order they were added.
        const added = entry.staged?.added ?? []
        const ids = added.map((_, index) => outcome.insertIds?.[statements.length - added.length + index] ?? null)
        const outside = entry.result.kind === 'rows' ? rowsOutside(entry.result, added, ids, result) : 0
        replaceEntry({ result, outside: outside || undefined })
        patchTab(id, (latest) => ({
          database: result.database,
          ...(latest.sessionId === sessionId ? { transaction: result.transaction } : {}),
          ...stringReading(result),
        }))
        return outcome
      } catch (error) {
        // The call itself failed, so the session is gone; the next run opens a new one.
        patchTab(id, { sessionId: null, transaction: false })
        if (tabById(id)?.results.find((item) => item.id === entry.id)?.staged) {
          return { ok: false, message: message(error), durationMs: 0 }
        }
        // Saved, but the rows could not be read back. Say so where the rows were.
        replaceEntry({
          result: { kind: 'error', message: message(error), durationMs: 0, database: tab.database, transaction: false },
        })
        return { ok: true, durationMs: 0 }
      } finally {
        patchTab(id, { running: false, cancelRequested: false })
      }
    },

    answerDiscard(discard) {
      const prompt = get().discardPrompt
      const proceed = afterDiscard
      afterDiscard = null
      set({ discardPrompt: null })
      if (!prompt || !discard) return
      dropChanges(prompt.tabId)
      proceed?.()
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

/**
 * How the session a tab runs on reads a backslash in a string: as the tab's own
 * session last said, else as the connection's first session did, else the way
 * MySQL reads one unless it is told otherwise.
 */
export function readsBackslashAsEscape(tabId: string): boolean {
  const state = useStore.getState()
  const tab = state.tabs.find((each) => each.id === tabId)
  if (!tab) return true
  return tab.backslashEscapes ?? state.live[tab.connectionId]?.backslashEscapes ?? true
}

export function useActiveTab(): Tab | undefined {
  return useStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId))
}
