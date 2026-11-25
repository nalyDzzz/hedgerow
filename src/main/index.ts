import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { APP_NAME } from '@shared/app'
import windowIcon from '../../build/icon.png?asset'
import { ConnectionStore } from './connection-store'
import { DriverHost } from './driver-host-client'
import { registerIpc, TITLE_BAR_HEIGHT } from './ipc'

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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    const store = new ConnectionStore(join(app.getPath('userData'), 'app.db'))
    registerIpc({ store, host, window: () => mainWindow })
    installMenu()
    createWindow()

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
    stopping = true
    event.preventDefault()
    void host.shutdown().finally(() => app.quit())
  })
}
