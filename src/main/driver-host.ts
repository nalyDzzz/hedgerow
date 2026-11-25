/**
 * Entry point of the driver host: a utility process that owns every database
 * connection, so a slow query or a huge result never stalls the app window.
 */
import { randomUUID } from 'node:crypto'
import type { DriverSession } from '@shared/driver'
import { drivers } from '../drivers'
import type { HostMethods, HostRequest, HostResponse } from './host-protocol'

const sessions = new Map<string, DriverSession>()
/** Settles when every session that was asked to close has closed. */
let closing: Promise<unknown> = Promise.resolve()

/** Closes sessions, and keeps track of them until they have. */
function closeAndTrack(open: DriverSession[]): Promise<unknown> {
  closing = Promise.allSettled([closing, ...open.map((each) => each.close())])
  return closing
}

function session(id: string): DriverSession {
  const found = sessions.get(id)
  if (!found) {
    throw Object.assign(new Error('This connection is no longer open. Reconnect to continue.'), {
      code: 'NO_SESSION',
    })
  }
  return found
}

type Handlers = {
  [M in keyof HostMethods]: (
    ...args: Parameters<HostMethods[M]>
  ) => Promise<ReturnType<HostMethods[M]>> | ReturnType<HostMethods[M]>
}

const handlers: Handlers = {
  async test(driver, params) {
    const probe = await drivers[driver].connect(params)
    const { serverVersion } = probe
    await probe.close()
    return { serverVersion }
  },

  async open(driver, params) {
    const opened = await drivers[driver].connect(params)
    const sessionId = randomUUID()
    sessions.set(sessionId, opened)
    return { sessionId, serverVersion: opened.serverVersion, database: opened.database }
  },

  async close(sessionId) {
    const open = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (open) await closeAndTrack([open])
  },

  // Waits for sessions that were already closing too, so that the app does not quit under them.
  async closeAll() {
    const open = [...sessions.values()]
    sessions.clear()
    await closeAndTrack(open)
  },

  usable: (sessionId) => sessions.get(sessionId)?.usable ?? false,
  listDatabases: (sessionId) => session(sessionId).listDatabases(),
  describeDatabase: (sessionId, database) => session(sessionId).describeDatabase(database),
  setDatabase: (sessionId, database) => session(sessionId).setDatabase(database),
  execute: (sessionId, sql, options) => session(sessionId).execute(sql, options),
  cancel: (sessionId) => session(sessionId).cancel(),
  tableQuery: (sessionId, table, view) => session(sessionId).tableQuery(table, view),
  changeView: (sessionId, view, change) => session(sessionId).changeView(view, change),
  planEdits: (sessionId, request) => session(sessionId).planEdits(request),
  applyEdits: (sessionId, statements) => session(sessionId).applyEdits(statements),
}

process.parentPort.on('message', async (event) => {
  const request = event.data as HostRequest
  let response: HostResponse
  try {
    const handler = handlers[request.method] as (...args: unknown[]) => unknown
    response = { id: request.id, ok: true, value: await handler(...request.args) }
  } catch (error) {
    const failure = error as { message?: string; code?: string }
    response = {
      id: request.id,
      ok: false,
      error: { message: failure.message || 'Something went wrong.', code: failure.code },
    }
  }
  process.parentPort.postMessage(response)
})
