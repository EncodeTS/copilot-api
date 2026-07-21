import fs from 'node:fs/promises'

import { ipcMain, shell, BrowserWindow } from 'electron'

import { normalizeApiKeys } from '../../src/lib/request-auth'
import { PATHS } from '../../src/lib/paths'
import {
  cancelGitHubDeviceLogin,
  startGitHubDeviceLogin,
  type GitHubDeviceLoginSession,
  getGitHubUser,
  loginWithGitHubToken,
  clearToken,
  getCopilotAccountType,
} from './auth'
import { tMain } from './i18n'
import {
  configureProviderWithAuthStatus,
  getDesktopAuthStatus,
  loginCodexForDesktop,
  shouldStartInProviderMode,
} from './provider-auth'
import {
  startServer,
  stopServer,
  clearServerRestartContext,
  getPort,
  getLogs,
  isRunning,
} from './server-manager'
import { readSettings, writeSettings } from './settings-store'
import { saveAndApplyDesktopSettings } from './settings-apply'
import {
  markDesktopServerCredentialsChanged,
  resolveDesktopServerCredentials,
} from './server-credentials'
import { logoutDesktopServerSession } from './server-logout'
import type {
  DesktopAuthMode,
  DesktopProxySettings,
  DesktopSettings,
  ProviderAuthInput,
  ServerAuthInfo,
  SettingsSaveResult,
} from '../src/types/ipc'
import type {
  ModelMappingsConfigOutcome,
  ModelMappingsRequestError,
  ModelMappingsSaveOutcome,
} from '../../shared-types'
import {
  readModelMappingsRequest,
  saveModelMappingsRequest,
} from './model-mappings-api'

type ServerAuthScope = 'default' | 'admin'

interface IpcHandlersOptions {
  getEffectiveProxySettings?: (
    settings: DesktopSettings,
  ) => DesktopProxySettings
  onSettingsChange?: (
    settings: DesktopSettings,
    prevSettings: DesktopSettings,
  ) => SettingsSaveResult | void | Promise<SettingsSaveResult | void>
  onQuit?: () => void | Promise<void>
}

function normalizeApiKey(apiKey: unknown): string | null {
  if (typeof apiKey !== 'string') {
    return null
  }

  const normalizedApiKey = apiKey.trim()
  return normalizedApiKey || null
}

async function getServerAuthInfo(
  scope: ServerAuthScope = 'default',
): Promise<ServerAuthInfo> {
  try {
    const raw = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const parsed =
      raw.trim() ?
        (JSON.parse(raw) as {
          auth?: { apiKeys?: unknown; adminApiKey?: unknown }
        })
      : {}
    const apiKey =
      scope === 'admin' ?
        normalizeApiKey(parsed.auth?.adminApiKey)
      : (normalizeApiKeys(parsed.auth?.apiKeys)[0] ?? null)

    if (!apiKey) {
      return { enabled: false }
    }

    return {
      enabled: true,
      headerName: 'x-api-key',
      headerValue: apiKey,
    }
  } catch {
    return { enabled: false }
  }
}

async function getServerRequestHeaders(
  scope: ServerAuthScope = 'default',
): Promise<Record<string, string> | undefined> {
  const authInfo = await getServerAuthInfo(scope)
  if (!authInfo.enabled || !authInfo.headerName || !authInfo.headerValue) {
    return undefined
  }

  return {
    [authInfo.headerName]: authInfo.headerValue,
  }
}

function getConfigApiBaseUrl(): string | null {
  if (!isRunning()) {
    return null
  }

  return `http://localhost:${getPort()}/admin/config/model-mappings`
}

function serverUnavailableError(): ModelMappingsRequestError {
  return {
    diagnostics: [],
    kind: 'request_failed',
    message:
      'Server is not running. Start the service before editing advanced config.',
  }
}

async function fetchModelMappingsConfig(): Promise<ModelMappingsConfigOutcome> {
  const url = getConfigApiBaseUrl()
  if (!url) {
    return { error: serverUnavailableError(), ok: false }
  }
  const headers = await getServerRequestHeaders('admin')
  return await readModelMappingsRequest({
    headers,
    url,
  })
}

async function saveModelMappingsViaApi(
  modelMappings: Record<string, string>,
): Promise<ModelMappingsSaveOutcome> {
  const url = getConfigApiBaseUrl()
  if (!url) {
    return { error: serverUnavailableError(), ok: false }
  }
  const headers = await getServerRequestHeaders('admin')
  return await saveModelMappingsRequest({
    headers,
    modelMappings,
    url,
  })
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  options: IpcHandlersOptions = {},
): void {
  let activeGitHubLogin: GitHubDeviceLoginSession | null = null
  ipcMain.handle('auth:get-status', async () => getDesktopAuthStatus())

  // Auth: Start the OAuth device flow
  ipcMain.handle('auth:get-device-code', async () => {
    const loginSession = await startGitHubDeviceLogin()
    activeGitHubLogin = loginSession
    // Poll in the background and notify the renderer when the token arrives
    loginSession.completion
      .then(async (token) => {
        if (activeGitHubLogin !== loginSession) return
        const login = await getGitHubUser(token, {
          signal: loginSession.signal,
        })
        if (activeGitHubLogin !== loginSession) return
        const accountType = await getCopilotAccountType(token, {
          expectedLogin: login,
          signal: loginSession.signal,
        })
        if (activeGitHubLogin !== loginSession) return
        markDesktopServerCredentialsChanged()
        // Detect and persist the account type automatically after sign-in
        const settings = await readSettings()
        await writeSettings({ ...settings, accountType })
        if (activeGitHubLogin === loginSession && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:success', {
            success: true,
            mode: 'copilot',
          })
        }
      })
      .catch((err: Error) => {
        if (activeGitHubLogin === loginSession && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:success', {
            success: false,
            error: err.message,
          })
        }
      })
      .finally(() => {
        if (activeGitHubLogin === loginSession) activeGitHubLogin = null
      })
    return loginSession.deviceCode
  })

  // Auth: Save token directly
  ipcMain.handle('auth:save-token', async (_event, token: string) => {
    try {
      if (activeGitHubLogin) {
        cancelGitHubDeviceLogin(activeGitHubLogin)
        activeGitHubLogin = null
      }
      const { accountType } = await loginWithGitHubToken(token)
      markDesktopServerCredentialsChanged()
      // Detect and persist the account type automatically
      const settings = await readSettings()
      await writeSettings({ ...settings, accountType })
      return { success: true, mode: 'copilot' }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Auth: Check the saved token
  ipcMain.handle('auth:check-saved', async () => getDesktopAuthStatus())

  ipcMain.handle(
    'auth:configure-provider',
    async (_event, input: ProviderAuthInput) => {
      try {
        const result = await configureProviderWithAuthStatus(input)
        if (result.success) markDesktopServerCredentialsChanged()
        return result
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'auth:start-codex-login',
    async (_event, callbackUrlOrCode?: string) => {
      try {
        const result = await loginCodexForDesktop({
          callbackUrlOrCode,
          openUrl: (url) => shell.openExternal(url),
        })
        if (result.success) markDesktopServerCredentialsChanged()
        return result
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  // Auth: Log out
  ipcMain.handle('auth:logout', async () => {
    if (activeGitHubLogin) {
      cancelGitHubDeviceLogin(activeGitHubLogin)
      activeGitHubLogin = null
    }
    await logoutDesktopServerSession({
      clearRestartContext: clearServerRestartContext,
      clearToken,
      markCredentialsChanged: markDesktopServerCredentialsChanged,
      stopServer,
    })
  })

  // Server: Start
  ipcMain.handle(
    'server:start',
    async (_event, port: number, authMode?: DesktopAuthMode) => {
      const providerMode = shouldStartInProviderMode(authMode)
      const credentials = await resolveDesktopServerCredentials(
        providerMode ? 'provider' : 'copilot',
        !providerMode,
      )

      if (!credentials) {
        return {
          running: false,
          error: await tMain('server.authRequired'),
        }
      }

      const settings = await readSettings()
      const serverOptions = {
        verbose: settings.verbose,
        showToken: settings.showToken,
        proxy: options.getEffectiveProxySettings?.(settings) ?? settings.proxy,
      }

      // Persist the last used port
      await writeSettings({ ...settings, lastPort: port })

      return startServer(port, credentials.token, serverOptions, {
        generation: credentials.generation,
        mode: credentials.mode,
      })
    },
  )

  // Server: Stop
  ipcMain.handle('server:stop', async () => {
    await stopServer()
  })

  ipcMain.handle('server:get-status', () => ({
    running: isRunning(),
    port: getPort(),
  }))

  // Settings
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:save', async (_event, settings: DesktopSettings) =>
    saveAndApplyDesktopSettings(settings, {
      getPort,
      isRunning,
      onSettingsChange: options.onSettingsChange,
      readSettings,
      writeSettings,
    }),
  )
  ipcMain.handle('config:get-model-mappings', async () =>
    fetchModelMappingsConfig(),
  )
  ipcMain.handle(
    'config:save-model-mappings',
    async (_event, modelMappings: Record<string, string>) =>
      await saveModelMappingsViaApi(modelMappings),
  )

  // Shell: Open the system browser
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Server: Proxy HTTP requests through the main process to bypass file:// origin CORS in the renderer
  ipcMain.handle('server:fetch-usage', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/usage`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle('server:fetch-models', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle('server:fetch-token-usage', async (_event, period: string) => {
    const port = getPort()
    const normalizedPeriod =
      period === 'week' || period === 'month' ? period : 'day'
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(
        `http://localhost:${port}/token-usage?period=${normalizedPeriod}`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'server:fetch-token-usage-daily',
    async (_event, period: string) => {
      const port = getPort()
      const normalizedPeriod =
        period === 'week' || period === 'month' ? period : 'day'
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `http://localhost:${port}/token-usage/daily?period=${normalizedPeriod}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-events',
    async (_event, period: string, page: number, pageSize: number) => {
      const port = getPort()
      const normalizedPeriod =
        period === 'week' || period === 'month' ? period : 'day'
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizedPeriod,
      })
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `http://localhost:${port}/token-usage/events?${params.toString()}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  ipcMain.handle('server:get-auth-info', async () => getServerAuthInfo())

  // Server: Return the in-memory log buffer
  ipcMain.handle('server:get-logs', () => getLogs())

  // Window controls (used by the custom title bar menu)
  ipcMain.on('window:reload', () => mainWindow.reload())
  ipcMain.on('window:minimize', () => mainWindow.minimize())
  ipcMain.on('window:maximize-toggle', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow.close())
  ipcMain.on('window:quit', () => {
    void options.onQuit?.()
  })
  ipcMain.on('window:zoom-in', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level + 0.5)
  })
  ipcMain.on('window:zoom-out', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level - 0.5)
  })
  ipcMain.on('window:zoom-reset', () => mainWindow.webContents.setZoomLevel(0))

  ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized())
}
