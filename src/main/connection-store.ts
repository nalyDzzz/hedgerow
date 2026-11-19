import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { safeStorage } from 'electron'
import type { ConnectionInput, SavedConnection } from '@shared/api'
import type { ConnectionParams, DriverId, TlsMode } from '@shared/driver'

interface Row {
  id: string
  name: string
  driver: string
  host: string
  port: number
  user: string
  password: Uint8Array | null
  database: string
  tls: string
  hue: number
}

/**
 * Saved connections, kept in a SQLite file in the app's data folder.
 * Passwords are encrypted with the operating system's credential storage
 * and never leave the main process.
 */
export class ConnectionStore {
  private readonly db: DatabaseSync
  /** Passwords held only until quit, for systems with no credential storage. */
  private readonly unsavedPasswords = new Map<string, string>()

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        driver     TEXT NOT NULL,
        host       TEXT NOT NULL,
        port       INTEGER NOT NULL,
        user       TEXT NOT NULL,
        password   BLOB,
        database   TEXT NOT NULL DEFAULT '',
        tls        TEXT NOT NULL DEFAULT 'disabled',
        hue        INTEGER NOT NULL DEFAULT 250,
        created_at INTEGER NOT NULL
      )
    `)
  }

  list(): SavedConnection[] {
    const rows = this.db.prepare('SELECT * FROM connections ORDER BY created_at').all()
    return rows.map((row) => this.toSaved(row as unknown as Row))
  }

  save(input: ConnectionInput): SavedConnection {
    const id = input.id ?? randomUUID()
    const existing = this.row(id)

    let password = existing?.password ?? null
    if (input.password !== undefined) {
      this.unsavedPasswords.delete(id)
      if (input.password === '') {
        password = null
      } else if (safeStorage.isEncryptionAvailable()) {
        password = safeStorage.encryptString(input.password)
      } else {
        password = null
        this.unsavedPasswords.set(id, input.password)
      }
    }

    this.db
      .prepare(
        `INSERT INTO connections (id, name, driver, host, port, user, password, database, tls, hue, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, driver = excluded.driver, host = excluded.host,
           port = excluded.port, user = excluded.user, password = excluded.password,
           database = excluded.database, tls = excluded.tls, hue = excluded.hue`,
      )
      .run(
        id,
        input.name.trim() || input.host.trim(),
        input.driver,
        input.host.trim(),
        input.port,
        input.user.trim(),
        password,
        input.database.trim(),
        input.tls,
        input.hue,
        Date.now(),
      )

    return this.toSaved(this.row(id)!)
  }

  remove(id: string): void {
    this.unsavedPasswords.delete(id)
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  /** Everything a driver needs to connect, password included. Main process only. */
  resolve(id: string): { driver: DriverId; params: ConnectionParams } {
    const row = this.row(id)
    if (!row) throw new Error('That connection no longer exists.')
    return {
      driver: row.driver as DriverId,
      params: {
        host: row.host,
        port: row.port,
        user: row.user,
        password: this.password(row),
        database: row.database || undefined,
        tls: row.tls as TlsMode,
      },
    }
  }

  /** The stored password, for testing an edited connection whose password field was left alone. */
  passwordFor(id: string): string {
    const row = this.row(id)
    return row ? this.password(row) : ''
  }

  private password(row: Row): string {
    const unsaved = this.unsavedPasswords.get(row.id)
    if (unsaved !== undefined) return unsaved
    if (!row.password) return ''
    return safeStorage.decryptString(Buffer.from(row.password))
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as Row | undefined
  }

  private toSaved(row: Row): SavedConnection {
    return {
      id: row.id,
      name: row.name,
      driver: row.driver as DriverId,
      host: row.host,
      port: row.port,
      user: row.user,
      database: row.database,
      tls: row.tls as TlsMode,
      hue: row.hue,
      hasPassword: row.password !== null || this.unsavedPasswords.has(row.id),
    }
  }
}
