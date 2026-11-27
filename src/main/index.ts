import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, net, shell } from 'electron'
import { APP_NAME } from '@shared/app'
import windowIcon from '../../build/icon.png?asset'
import { ConnectionStore } from './connection-store'
import { DriverHost } from './driver-host-client'
import { registerIpc, TITLE_BAR_HEIGHT } from './ipc'
import { installerFor, UPDATED_ARGUMENT } from './update-install'
import { Updater } from './updater'

let mainWindow: BrowserWindow | null = null
const host = new DriverHost()

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // macOS takes the icon from the app bundle; elsewhere the window carries it.
    ...(process.platform === 'darwin' ? {} : { icon: windowIcon }),
    backgroundColor: dark ? '#14161b' : '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : {
            color: dark ? '#191c22' : '#f6f6f4',
            symbolColor: dark ? '#e6e8ee' : '#1c1d21',
            height: TITLE_BAR_HEIGHT,
          },
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  mainWindow = window

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    // The tabs that owned the sessions went with the window.
    void host.closeSessions()
  })

  // The window only ever shows the app itself; anything else opens in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (!app.isPackaged) {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') window.webContents.toggleDevTools()
    })
  }

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServer) void window.loadURL(devServer)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function installMenu(): void {
  if (process.platform === 'darwin') {
    // macOS needs an Edit menu for copy and paste to work at all.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
      ]),
    )
  } else {
    // The default menu would claim Ctrl+W and Ctrl+R, which belong to tabs and the editor.
    Menu.setApplicationMenu(null)
  }
}

/**
 * Where a new version waits to be installed: a cache folder, which a roaming
 * profile does not carry around. Not "hedgerow-updater", which the Windows
 * installer fills with a copy of itself for a kind of updater this app does not use.
 */
function updatesFolder(): string {
  const local = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && local && isAbsolute(local)) return join(local, APP_NAME, 'Updates')
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  if (process.platform === 'linux' && isAbsolute(cache)) return join(cache, 'hedgerow', 'updates')
  return join(app.getPath('temp'), 'hedgerow-updates')
}

function createUpdater(): Updater {
  // Electron's own fetch, so the system's proxy settings apply.
  const fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
    net.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' })
  return new Updater({
    check: {
      fetch,
      current: app.getVersion(),
      platform: process.platform,
      // An Intel build on an Apple silicon Mac should be offered the build made for that Mac.
      arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
    },
    fetchFile: fetch,
    installer: installerFor({
      name: app.getName(),
      platform: process.platform,
      packaged: app.isPackaged,
      executable: process.execPath,
      appImage: process.env.APPIMAGE,
      args: process.argv.slice(1),
    }),
    folder: updatesFolder(),
    quit: () => app.quit(),
  })
}

function start(): void {
  const updater = createUpdater()

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    const store = new ConnectionStore(join(app.getPath('userData'), 'app.db'))
    registerIpc({ store, host, updater, window: () => mainWindow })
    installMenu()
    createWindow()
    // Later, because the installer that started this version may still be finishing.
    setTimeout(() => void updater.clearDownloads(), 60_000).unref()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let stopping = false
  app.on('before-quit', (event) => {
    if (stopping) return
    // Quit a moment later, once running statements have been stopped. Cut off instead,
    // a statement would finish on the server, and commit, after the app is gone.
    // A downloaded update is installed only then, for the same reason.
    stopping = true
    event.preventDefault()
    void host
      .shutdown()
      .finally(() => updater.finish())
      .finally(() => app.quit())
  })
}

/**
 * A copy started by an update can find the version it replaces still closing.
 * It waits a few seconds for that one to go, rather than handing over to it.
 */
async function waitForTheOldVersion(): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (app.requestSingleInstanceLock()) return true
  }
  return false
}

if (app.requestSingleInstanceLock()) {
  start()
} else if (process.argv.includes(UPDATED_ARGUMENT)) {
  void waitForTheOldVersion().then((only) => (only ? start() : app.quit()))
} else {
  app.quit()
}
