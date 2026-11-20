/**
 * Launches the packaged app and checks that it really works: the window opens,
 * the database process answers, and saved connections can be written and read.
 *
 * Run it after `pnpm package` or `pnpm dist`, with `pnpm smoke`. CI runs it on
 * Windows, macOS and Linux, so a build that cannot start never gets released.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const dist = join(import.meta.dirname, '..', 'dist')

/** Every packaged build in dist/ for this operating system, as [label, executable]. */
function packagedApps() {
  if (process.platform === 'win32') {
    return [['win-x64', join(dist, 'win-unpacked', 'Hedgerow.exe')]]
  }
  if (process.platform === 'darwin') {
    // One folder per architecture: mac-arm64, mac (Intel), mac-universal.
    return readdirSync(dist)
      .filter((folder) => folder === 'mac' || folder.startsWith('mac-'))
      .map((folder) => [
        folder === 'mac' ? 'mac-x64' : folder,
        join(dist, folder, 'Hedgerow.app', 'Contents', 'MacOS', 'Hedgerow'),
      ])
  }
  const folder = join(dist, 'linux-unpacked')
  return [['linux-x64', ['hedgerow', 'Hedgerow'].map((name) => join(folder, name)).find(existsSync)]]
}

async function check(label, executable) {
  if (!executable || !existsSync(executable)) {
    throw new Error(`No packaged app found for ${label}. Run "pnpm package" first.`)
  }
  const profile = mkdtempSync(join(tmpdir(), 'hedgerow-smoke-'))
  const args = [`--user-data-dir=${profile}`]
  // CI runners do not allow Chromium's sandbox to start.
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox')

  const app = await electron.launch({ executablePath: executable, args, timeout: 60_000 })
  try {
    const page = await app.firstWindow()
    await page.getByRole('heading', { name: 'Connect to a database' }).waitFor({ timeout: 30_000 })

    const connection = {
      name: 'Smoke test',
      driver: 'mysql',
      host: '127.0.0.1',
      port: 1,
      user: 'root',
      password: '',
      database: '',
      tls: 'disabled',
      hue: 150,
    }

    // Nothing listens on port 1, so the driver must come back with its own explanation.
    // That only happens if the driver process started and loaded the MySQL library.
    const test = await page.evaluate((input) => window.api.connections.test(input), connection)
    if (test.ok || !/Nothing is listening/.test(test.message)) {
      throw new Error(`Unexpected answer from the driver process: ${JSON.stringify(test)}`)
    }

    // Saving and listing goes through the app's SQLite storage.
    await page.evaluate((input) => window.api.connections.save(input), connection)
    const saved = await page.evaluate(() => window.api.connections.list())
    if (saved.length !== 1 || saved[0].name !== connection.name) {
      throw new Error(`Saved connection did not come back: ${JSON.stringify(saved)}`)
    }

    await page.reload()
    await page.getByRole('treeitem', { name: connection.name }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(dist, `smoke-${label}.png`) })
    console.log(`ok  ${label}  ${executable}`)
  } finally {
    await app.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const apps = packagedApps()
if (apps.length === 0) throw new Error('No packaged app found in dist/. Run "pnpm package" first.')
for (const [label, executable] of apps) await check(label, executable)
