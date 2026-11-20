import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import type { AppApi, ConnectionInput, IpcEnvelope } from '@shared/api'
import type { ConnectionParams } from '@shared/driver'
import type { ConnectionStore } from './connection-store'
import type { DriverHost } from './driver-host-client'

interface Context {
  store: ConnectionStore
  host: DriverHost
  window(): BrowserWindow | null
}

export const TITLE_BAR_HEIGHT = 40

function paramsFromInput(input: ConnectionInput, store: ConnectionStore): ConnectionParams {
  return {
    host: input.host.trim(),
    port: input.port,
    user: input.user.trim(),
    // An untouched password field on an existing connection means "use the stored one".
    password: input.password ?? (input.id ? store.passwordFor(input.id) : ''),
    database: input.database.trim() || undefined,
    tls: input.tls,
  }
}

export function registerIpc({ store, host, window }: Context): void {
  const api: Omit<AppApi, 'platform'> = {
    connections: {
      list: async () => store.list(),
      save: async (input) => store.save(input),
      remove: async (id) => store.remove(id),
      test: async (input) => {
        try {
          const { serverVersion } = await host.call('test', input.driver, paramsFromInput(input, store))
          return { ok: true, serverVersion }
        } catch (error) {
          return { ok: false, message: (error as Error).message }
        }
      },
    },

    sessions: {
      open: async (connectionId, database) => {
        const { driver, params } = store.resolve(connectionId)
        return host.call('open', driver, { ...params, database: database ?? params.database })
      },
      close: (sessionId) => host.call('close', sessionId),
      listDatabases: (sessionId) => host.call('listDatabases', sessionId),
      describeDatabase: (sessionId, database) => host.call('describeDatabase', sessionId, database),
      setDatabase: (sessionId, database) => host.call('setDatabase', sessionId, database),
      execute: (sessionId, sql, options) => host.call('execute', sessionId, sql, options),
      cancel: (sessionId) => host.call('cancel', sessionId),
      tableQuery: (sessionId, table) => host.call('tableQuery', sessionId, table),
      planEdits: (sessionId, request) => host.call('planEdits', sessionId, request),
      applyEdits: (sessionId, statements) => host.call('applyEdits', sessionId, statements),
    },

    window: {
      setTheme: async (mode, titleBar) => {
        nativeTheme.themeSource = mode
        if (process.platform !== 'darwin') {
          window()?.setTitleBarOverlay({
            color: titleBar.background,
            symbolColor: titleBar.symbols,
            height: TITLE_BAR_HEIGHT,
          })
        }
      },
    },
  }

  for (const [group, methods] of Object.entries(api)) {
    for (const [name, method] of Object.entries(methods)) {
      const call = method as (...args: unknown[]) => Promise<unknown>
      ipcMain.handle(`${group}:${name}`, async (_event, ...args): Promise<IpcEnvelope<unknown>> => {
        try {
          return { ok: true, value: await call(...args) }
        } catch (error) {
          const failure = error as { message?: string; code?: string }
          return {
            ok: false,
            error: { message: failure.message || 'Something went wrong.', code: failure.code },
          }
        }
      })
    }
  }
}
