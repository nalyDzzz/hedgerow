import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import type { AppApi, ChosenCertificate, ConnectionInput, IpcEnvelope } from '@shared/api'
import type { ConnectionParams } from '@shared/driver'
import type { ConnectionStore } from './connection-store'
import type { DriverHost } from './driver-host-client'
import type { Updater } from './updater'

interface Context {
  store: ConnectionStore
  host: DriverHost
  updater: Updater
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
    ca: input.ca || undefined,
  }
}

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * Lets the person pick a file of certificate authorities and gives back the
 * certificates in it. Anything else the file holds, a private key say, is left behind.
 */
async function chooseCertificate(window: BrowserWindow | null): Promise<ChosenCertificate> {
  const options: Electron.OpenDialogOptions = {
    title: 'Certificate authority',
    properties: ['openFile'],
    filters: [
      { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'ca-bundle'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }
  const chosen = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
  const path = chosen.filePaths[0]
  if (chosen.canceled || !path) return null

  const name = basename(path)
  try {
    // A bundle of every public authority is a few hundred kilobytes. Nothing larger is one.
    if ((await stat(path)).size > 2_000_000) return { problem: `${name} is too large to be a certificate file.` }
    const found = (await readFile(path, 'utf8')).match(CERTIFICATE)
    if (!found) {
      return {
        problem:
          `${name} holds no certificate in PEM form, which starts with "-----BEGIN CERTIFICATE-----". ` +
          'A certificate in another form has to be converted first.',
      }
    }
    return { name, ca: found.join('\n') }
  } catch (error) {
    return { problem: `${name} could not be read: ${(error as Error).message}` }
  }
}

export function registerIpc({ store, host, updater, window }: Context): void {
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
      chooseCertificate: () => chooseCertificate(window()),
    },

    sessions: {
      open: async (connectionId, database) => {
        const { driver, params } = store.resolve(connectionId)
        return host.call('open', driver, { ...params, database: database ?? params.database })
      },
      close: (sessionId) => host.call('close', sessionId),
      usable: (sessionId) => host.call('usable', sessionId),
      listDatabases: (sessionId) => host.call('listDatabases', sessionId),
      describeDatabase: (sessionId, database) => host.call('describeDatabase', sessionId, database),
      setDatabase: (sessionId, database) => host.call('setDatabase', sessionId, database),
      execute: (sessionId, sql, options) => host.call('execute', sessionId, sql, options),
      cancel: (sessionId) => host.call('cancel', sessionId),
      tableQuery: (sessionId, table, view) => host.call('tableQuery', sessionId, table, view),
      changeView: (sessionId, view, change) => host.call('changeView', sessionId, view, change),
      planEdits: (sessionId, request) => host.call('planEdits', sessionId, request),
      applyEdits: (sessionId, statements) => host.call('applyEdits', sessionId, statements),
    },

    updates: {
      current: async () => app.getVersion(),
      check: () => updater.check(),
      download: () => updater.download(),
      cancelDownload: async () => updater.cancel(),
      downloadState: async () => updater.progress(),
      restart: async () => updater.restart(),
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
