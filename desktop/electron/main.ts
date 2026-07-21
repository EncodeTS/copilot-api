import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
} from 'electron'
import path from 'node:path'

import { bindElectronFetch } from '../../src/lib/electron-fetch'
import type {
  DesktopProxySettings,
  DesktopSettings,
  ThemePreference,
} from '../src/types/ipc'
import {
  applyElectronProxy,
  applyElectronProxyCommandLine,
} from './electron-proxy'
import {
  applyNoProxyServerOverride,
  hasNoProxyServerSwitch,
} from './electron-proxy-config'
import {
  createApplicationShutdownBarrier,
  type ApplicationShutdownBarrier,
} from './application-shutdown'
import {
  desktopServerIpcCoordinator,
  type DesktopServerIpcCoordinator,
} from './server-ipc-lifecycle'
import { tMain } from './i18n'
import { applyDesktopProxyRuntimeTransition } from './desktop-proxy-runtime'
import { readSettings, readSettingsSync } from './settings-store'

const CLI_ENV_FLAGS = {
  '--api-home': 'COPILOT_API_HOME',
  '--oauth-app': 'COPILOT_API_OAUTH_APP',
  '--enterprise-url': 'COPILOT_API_ENTERPRISE_URL',
} as const

function applyCliEnvOverrides(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue

    for (const [flag, envName] of Object.entries(CLI_ENV_FLAGS)) {
      if (arg === flag) {
        const nextArg = argv[index + 1]?.trim()
        const value = nextArg?.startsWith('--') ? undefined : nextArg
        if (value) process.env[envName] = value
        break
      }

      const prefix = `${flag}=`
      if (!arg.startsWith(prefix)) continue

      const value = arg.slice(prefix.length).trim()
      if (value) process.env[envName] = value
      break
    }
  }
}

applyCliEnvOverrides(process.argv)
const noProxyServerOverride = hasNoProxyServerSwitch(process.argv)
const initialSettings = readSettingsSync()
applySettingsEnvOverrides(initialSettings)
applyElectronProxyCommandLine(getEffectiveProxySettings(initialSettings))
bindElectronFetch()

function resolveNativeBackgroundColor(theme: ThemePreference): string {
  if (theme === 'dark') return '#0a0a0c'
  if (theme === 'light') return '#fafafa'
  return nativeTheme.shouldUseDarkColors ? '#0a0a0c' : '#fafafa'
}

function resolveTitleBarOptions(): Electron.BaseWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' as const }
  }
  return { frame: false }
}

interface RuntimeDependencies {
  registerIpcHandlers: typeof import('./ipc-handlers').registerIpcHandlers
  stopServer: typeof import('./server-manager-runtime').stopServer
  onStatusChange: typeof import('./server-manager-runtime').onStatusChange
  clearCallbacks: typeof import('./server-manager-runtime').clearCallbacks
  readSettings: typeof readSettings
}

interface RuntimeModuleLoaders {
  loadIpcHandlers: () => Promise<typeof import('./ipc-handlers')>
  loadServerManager: () => Promise<typeof import('./server-manager-runtime')>
}

const defaultRuntimeModuleLoaders: RuntimeModuleLoaders = {
  loadIpcHandlers: () => import('./ipc-handlers'),
  loadServerManager: () => import('./server-manager-runtime'),
}

export async function loadServerRuntimeDependencies(
  loaders: RuntimeModuleLoaders = defaultRuntimeModuleLoaders,
): Promise<Omit<RuntimeDependencies, 'readSettings'>> {
  const [
    { registerIpcHandlers },
    { stopServer, onStatusChange, clearCallbacks },
  ] = await Promise.all([
    loaders.loadIpcHandlers(),
    loaders.loadServerManager(),
  ])
  return { clearCallbacks, onStatusChange, registerIpcHandlers, stopServer }
}

export function bindServerLifecycleToWindow(
  win: BrowserWindow,
  onStatusChange: RuntimeDependencies['onStatusChange'],
): void {
  onStatusChange((status) => {
    if (!win.isDestroyed()) {
      win.webContents.send('server:status', status)
    }
  })
}

function getEffectiveProxySettings(
  settings: DesktopSettings,
): DesktopProxySettings {
  return applyNoProxyServerOverride(settings.proxy, noProxyServerOverride)
}

let runtimeDependenciesPromise: Promise<RuntimeDependencies> | null = null

function applySettingsEnvOverrides(settings: DesktopSettings): void {
  const apiHome = settings.apiHome.trim()
  if (!process.env.COPILOT_API_HOME && apiHome) {
    process.env.COPILOT_API_HOME = apiHome
  }

  if (!process.env.COPILOT_API_OAUTH_APP && settings.oauthApp === 'opencode') {
    process.env.COPILOT_API_OAUTH_APP = 'opencode'
  }

  const enterpriseUrl = settings.enterpriseUrl.trim()
  if (!process.env.COPILOT_API_ENTERPRISE_URL && enterpriseUrl) {
    process.env.COPILOT_API_ENTERPRISE_URL = enterpriseUrl
  }
}

function warmOpencodeVersion(): void {
  void import('../../src/lib/opencode')
    .then(({ initOpencodeVersion }) => initOpencodeVersion())
    .catch(() => {})
}

function getRuntimeDependencies(): Promise<RuntimeDependencies> {
  runtimeDependenciesPromise ??= (async () => {
    applySettingsEnvOverrides(await readSettings())
    warmOpencodeVersion()

    const runtime = await loadServerRuntimeDependencies()

    return {
      ...runtime,
      readSettings,
    }
  })()

  return runtimeDependenciesPromise
}

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
// Track exits triggered by menu or system actions instead of the close button
let isQuitting = false

interface MainApplicationShutdownDependencies {
  coordinator: DesktopServerIpcCoordinator
  loadRuntime: () => Promise<
    Pick<RuntimeDependencies, 'clearCallbacks' | 'stopServer'>
  >
  quit: () => void
}

export function createMainApplicationShutdown({
  coordinator,
  loadRuntime,
  quit,
}: MainApplicationShutdownDependencies): ApplicationShutdownBarrier {
  return createApplicationShutdownBarrier({
    clearCallbacks: async () => {
      const { clearCallbacks } = await loadRuntime()
      clearCallbacks()
    },
    quit,
    stopServer: async () => {
      const { stopServer } = await loadRuntime()
      return coordinator.stopForShutdown(stopServer)
    },
  })
}

export function handleApplicationBeforeQuit(
  event: { preventDefault: () => void },
  shutdown: ApplicationShutdownBarrier,
  setQuitting: (quitting: boolean) => void,
): void {
  setQuitting(true)
  shutdown.handleBeforeQuit(event)
  if (!shutdown.isComplete()) {
    void shutdown.requestQuit().then((stopped) => {
      if (!stopped) setQuitting(false)
    })
  }
}

const applicationShutdown = createMainApplicationShutdown({
  coordinator: desktopServerIpcCoordinator,
  loadRuntime: getRuntimeDependencies,
  quit: () => app.quit(),
})

function createTrayNativeImage(): Electron.NativeImage {
  // macOS uses a template image so the system adapts it for light and dark mode.
  // Windows and Linux use the colored icon variant.
  const isMac = process.platform === 'darwin'
  const baseName = isMac ? 'tray-iconTemplate.png' : 'tray-icon.png'
  const iconDir =
    app.isPackaged ?
      process.resourcesPath
    : path.join(app.getAppPath(), 'assets')
  const iconPath = path.join(iconDir, baseName)

  const image = nativeImage.createFromPath(iconPath)
  if (isMac) {
    image.setTemplateImage(true)
  }
  return image
}

function getWindowIconPath(): string {
  return app.isPackaged ?
      path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'assets', 'icon.png')
}

function showWindow(win: BrowserWindow): void {
  // Restore the Dock icon before showing the window on macOS.
  if (process.platform === 'darwin') {
    void app.dock?.show()
  }
  win.show()
  win.focus()
}

async function quitApplication(): Promise<void> {
  isQuitting = true
  if (!(await applicationShutdown.requestQuit())) isQuitting = false
}

async function refreshTrayContextMenu(win: BrowserWindow): Promise<void> {
  if (!tray) return

  const [showWindowLabel, quitLabel] = await Promise.all([
    tMain('tray.showWindow'),
    tMain('tray.quit'),
  ])

  const contextMenu = Menu.buildFromTemplate([
    {
      label: showWindowLabel,
      click: () => showWindow(win),
    },
    { type: 'separator' },
    {
      label: quitLabel,
      click: () => {
        void quitApplication()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
}

async function createTray(win: BrowserWindow): Promise<void> {
  if (tray) return

  const icon = createTrayNativeImage()
  tray = new Tray(icon)
  tray.setToolTip('Copilot API')
  await refreshTrayContextMenu(win)
  tray.on('double-click', () => showWindow(win))
  // On macOS, a single tray click should also show the window.
  if (process.platform === 'darwin') {
    tray.on('click', () => showWindow(win))
  }
}

function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  // Restore the Dock icon when destroying the tray on macOS.
  if (process.platform === 'darwin') {
    void app.dock?.show()
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 650,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...resolveTitleBarOptions(),
    icon: process.platform === 'darwin' ? undefined : getWindowIconPath(),
    backgroundColor: resolveNativeBackgroundColor(initialSettings.theme),
    show: false,
  })

  win.removeMenu()

  mainWindow = win
  win.maximize()

  win.once('ready-to-show', () => win.show())

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximize-changed', true)
    }
  })

  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximize-changed', false)
    }
  })

  win.on('close', async (e) => {
    // Allow the close event to proceed when quitting from the menu or system.
    if (isQuitting) return

    e.preventDefault()
    const { readSettings } = await getRuntimeDependencies()
    const settings = await readSettings()
    if (settings.minimizeToTray) {
      win.hide()
      // Hide the Dock icon on macOS so the app runs from the tray only.
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }
    } else {
      await quitApplication()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

void app.whenReady().then(async () => {
  const { registerIpcHandlers, readSettings, onStatusChange } =
    await getRuntimeDependencies()
  const settings = await readSettings()
  await applyElectronProxy(getEffectiveProxySettings(settings))

  const win = createWindow()

  registerIpcHandlers(win, {
    getEffectiveProxySettings,
    onQuit: quitApplication,
    onSettingsChange: async (settings, prevSettings) => {
      const runtimeResult = await applyDesktopProxyRuntimeTransition(
        getEffectiveProxySettings(prevSettings),
        getEffectiveProxySettings(settings),
      )

      if (
        settings.theme !== prevSettings.theme
        && mainWindow
        && !mainWindow.isDestroyed()
      ) {
        mainWindow.setBackgroundColor(
          resolveNativeBackgroundColor(settings.theme),
        )
      }

      if (settings.minimizeToTray) {
        await createTray(win)
        await refreshTrayContextMenu(win)
        return runtimeResult
      }

      if (prevSettings.minimizeToTray) {
        destroyTray()
        // Restore the window if it was hidden when this setting is turned off.
        if (!win.isVisible()) {
          showWindow(win)
        }
      }
      return runtimeResult
    },
  })

  // Only create the tray when minimize-to-tray is enabled.
  if (settings.minimizeToTray) {
    await createTray(win)
  }

  bindServerLifecycleToWindow(win, onStatusChange)

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      showWindow(mainWindow)
    }
  })
})

app.on('before-quit', (event) => {
  handleApplicationBeforeQuit(event, applicationShutdown, (quitting) => {
    isQuitting = quitting
  })
})

// This will not fire in the macOS tray flow because the close event is intercepted.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
