import { contextBridge, ipcRenderer } from 'electron'
import type {
  AuthResult,
  DesktopApi,
  DesktopAuthMode,
  DesktopSettings,
  LogFeedBatch,
  LogFeedSnapshot,
  LogFeedUpdate,
  ProviderAuthInput,
  ServerStatus,
  TokenUsagePeriod,
} from '../../shared-types'

const LOG_QUEUE_CAPACITY = 2000
let nextLogSubscriptionRequestId = 1

function mergeQueuedLogBatch(
  previous: LogFeedBatch | undefined,
  next: LogFeedBatch,
): LogFeedBatch {
  if (previous && next.cursor < previous.cursor) return previous

  const combined =
    next.reset ? next.entries : [...(previous?.entries ?? []), ...next.entries]
  const byCursor = new Map(combined.map((entry) => [entry.cursor, entry]))
  const ordered = [...byCursor.values()].sort(
    (left, right) => left.cursor - right.cursor,
  )
  const overflowed = ordered.length > LOG_QUEUE_CAPACITY
  return {
    cursor: next.cursor,
    entries: ordered.slice(-LOG_QUEUE_CAPACITY),
    reset: Boolean(previous?.reset || next.reset || overflowed),
  }
}

const electronApi = {
  getAuthStatus: () => ipcRenderer.invoke('auth:get-status'),
  getDeviceCode: () => ipcRenderer.invoke('auth:get-device-code'),
  saveToken: (token: string) => ipcRenderer.invoke('auth:save-token', token),
  checkSavedToken: () => ipcRenderer.invoke('auth:check-saved'),
  configureProvider: (input: ProviderAuthInput) =>
    ipcRenderer.invoke('auth:configure-provider', input),
  startCodexLogin: (callbackUrlOrCode?: string) =>
    ipcRenderer.invoke('auth:start-codex-login', callbackUrlOrCode),
  logout: () => ipcRenderer.invoke('auth:logout'),

  startServer: (port: number, authMode?: DesktopAuthMode) =>
    ipcRenderer.invoke('server:start', port, authMode),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getServerStatus: () => ipcRenderer.invoke('server:get-status'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: DesktopSettings) =>
    ipcRenderer.invoke('settings:save', settings),
  getModelMappingsConfig: () => ipcRenderer.invoke('config:get-model-mappings'),
  saveModelMappings: (modelMappings: Record<string, string>) =>
    ipcRenderer.invoke('config:save-model-mappings', modelMappings),

  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  fetchUsage: () => ipcRenderer.invoke('server:fetch-usage'),
  fetchModels: () => ipcRenderer.invoke('server:fetch-models'),
  fetchTokenUsage: (period: TokenUsagePeriod) =>
    ipcRenderer.invoke('server:fetch-token-usage', period),
  fetchTokenUsageDaily: (period: TokenUsagePeriod) =>
    ipcRenderer.invoke('server:fetch-token-usage-daily', period),
  fetchTokenUsageEvents: (
    period: TokenUsagePeriod,
    page: number,
    pageSize: number,
  ) =>
    ipcRenderer.invoke(
      'server:fetch-token-usage-events',
      period,
      page,
      pageSize,
    ),
  getServerAuthInfo: () => ipcRenderer.invoke('server:get-auth-info'),
  getServerLogSnapshot: () => ipcRenderer.invoke('server:logs-snapshot'),
  clearServerLogs: () => ipcRenderer.invoke('server:logs-clear'),

  onAuthSuccess: (callback: (result: AuthResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: AuthResult) =>
      callback(result)
    ipcRenderer.on('auth:success', handler)
    return () => ipcRenderer.off('auth:success', handler)
  },

  onServerStatus: (callback: (status: ServerStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ServerStatus) =>
      callback(status)
    ipcRenderer.on('server:status', handler)
    return () => ipcRenderer.off('server:status', handler)
  },

  subscribeServerLogs: (callback: (update: LogFeedUpdate) => void) => {
    type SubscriptionResult = {
      snapshot: LogFeedSnapshot
      subscriptionId: string
    }
    type BatchEnvelope = {
      batch: LogFeedBatch
      requestId: string
      subscriptionId: string
    }

    let disposed = false
    let mainUnsubscribeRequested = false
    let subscriptionId: string | null = null
    let queuedBatch: LogFeedBatch | undefined
    const requestId = `renderer-log-${nextLogSubscriptionRequestId}`
    nextLogSubscriptionRequestId += 1

    const requestMainUnsubscribe = () => {
      if (subscriptionId === null || mainUnsubscribeRequested) return
      mainUnsubscribeRequested = true
      void ipcRenderer
        .invoke('server:logs-unsubscribe', subscriptionId)
        .catch(() => undefined)
    }
    const dispose = (notifyMain: boolean) => {
      if (!disposed) {
        disposed = true
        queuedBatch = undefined
        ipcRenderer.off('server:log-batch', handler)
      }
      if (notifyMain) requestMainUnsubscribe()
    }
    const deliver = (update: LogFeedUpdate): boolean => {
      try {
        callback(update)
        return true
      } catch {
        dispose(true)
        return false
      }
    }
    function handler(
      _event: Electron.IpcRendererEvent,
      envelope: BatchEnvelope,
    ) {
      if (disposed || envelope.requestId !== requestId) return
      if (subscriptionId === null) {
        queuedBatch = mergeQueuedLogBatch(queuedBatch, envelope.batch)
        return
      }
      if (envelope.subscriptionId === subscriptionId) {
        deliver({ batch: envelope.batch, kind: 'batch' })
      }
    }
    ipcRenderer.on('server:log-batch', handler)

    void ipcRenderer
      .invoke('server:logs-subscribe', requestId)
      .then((result: SubscriptionResult) => {
        subscriptionId = result.subscriptionId
        if (disposed) {
          requestMainUnsubscribe()
          return
        }

        if (!deliver({ kind: 'snapshot', snapshot: result.snapshot })) return
        if (queuedBatch) {
          if (!deliver({ batch: queuedBatch, kind: 'batch' })) return
        }
        queuedBatch = undefined
      })
      .catch(() => {
        dispose(false)
      })

    return () => dispose(true)
  },

  platform: process.platform,
  windowReload: () => ipcRenderer.send('window:reload'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowQuit: () => ipcRenderer.send('window:quit'),
  windowZoomIn: () => ipcRenderer.send('window:zoom-in'),
  windowZoomOut: () => ipcRenderer.send('window:zoom-out'),
  windowZoomReset: () => ipcRenderer.send('window:zoom-reset'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized)
    ipcRenderer.on('window:maximize-changed', handler)
    return () => ipcRenderer.off('window:maximize-changed', handler)
  },
} satisfies DesktopApi

contextBridge.exposeInMainWorld('electronAPI', electronApi)
