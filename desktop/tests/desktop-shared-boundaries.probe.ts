// This suite runs in an isolated Bun subprocess because it owns module mocks.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopApi, LogFeedUpdate } from '../../shared-types'
import { buildServerLoopbackUrl } from '../electron/server-loopback'

type IpcHandler = (...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()
const appListeners = new Map<string, IpcHandler>()
const rendererListeners = new Map<string, Set<IpcHandler>>()
function emitRenderer(channel: string, ...args: unknown[]): void {
  for (const listener of rendererListeners.get(channel) ?? []) listener(...args)
}
const defaultInvoke = (channel: string, ...args: unknown[]) =>
  Promise.resolve({ args, channel })
const invoke = mock(defaultInvoke)
let exposedApi: unknown
let serverRunning = true
let serverStatusRevision = 0
let logBatchReceiver: ((batch: unknown) => void) | undefined
let logSubscriptionStopCalls = 0
let nextLogSubscriptionId = 1
let clearLogsCalls = 0
const forkedProcesses: EventEmitter[] = []
const checkedListenerPorts: Array<{ host: string; port: number }> = []

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = {
    getZoomLevel: () => 0,
    id: 1,
    send: () => undefined,
    setZoomLevel: () => undefined,
  }

  close(): void {}
  focus(): void {}
  hide(): void {}
  isDestroyed(): boolean {
    return false
  }
  isMaximized(): boolean {
    return false
  }
  isVisible(): boolean {
    return true
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  maximize(): void {}
  minimize(): void {}
  reload(): void {}
  removeMenu(): void {}
  setBackgroundColor(): void {}
  show(): void {}
}

void mock.module('electron', () => ({
  app: {
    commandLine: { appendSwitch: () => undefined },
    getAppPath: () => '/tmp/copilot-frp-desktop',
    getLocale: () => 'en',
    isPackaged: false,
    isReady: () => false,
    on: (event: string, listener: IpcHandler) => {
      appListeners.set(event, listener)
    },
    quit: () => undefined,
    setProxy: () => Promise.resolve(),
    whenReady: () => new Promise(() => undefined),
  },
  BrowserWindow: FakeBrowserWindow,
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      exposedApi = api
    },
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
  },
  ipcRenderer: {
    invoke,
    off: (channel: string, handler: IpcHandler) => {
      const listeners = rendererListeners.get(channel)
      listeners?.delete(handler)
      if (listeners?.size === 0) rendererListeners.delete(channel)
    },
    on: (channel: string, handler: IpcHandler) => {
      const listeners = rendererListeners.get(channel) ?? new Set<IpcHandler>()
      listeners.add(handler)
      rendererListeners.set(channel, listeners)
    },
    send: () => undefined,
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: {
    createFromPath: () => ({ setTemplateImage: () => undefined }),
  },
  nativeTheme: { shouldUseDarkColors: false },
  session: {
    defaultSession: {
      closeAllConnections: () => Promise.resolve(),
      forceReloadProxyConfig: () => Promise.resolve(),
      setProxy: () => Promise.resolve(),
    },
  },
  shell: { openExternal: () => Promise.resolve() },
  Tray: class {},
  utilityProcess: {
    fork: () => {
      const proc = new EventEmitter() as EventEmitter & {
        kill: () => boolean
        stderr: PassThrough
        stdout: PassThrough
      }
      proc.stderr = new PassThrough()
      proc.stdout = new PassThrough()
      proc.kill = () => {
        queueMicrotask(() => proc.emit('exit', 0))
        return true
      }
      forkedProcesses.push(proc)
      return proc
    },
  },
}))

void mock.module('node:net', () => ({
  default: {
    createServer: () => {
      const server = new EventEmitter() as EventEmitter & {
        close: () => void
        listen: (port: number, host: string) => void
      }
      server.close = () => undefined
      server.listen = (port, host) => {
        checkedListenerPorts.push({ host, port })
        queueMicrotask(() => server.emit('listening'))
      }
      return server
    },
  },
}))

const fakeServerRuntime = {
  clearLogs: () => {
    clearLogsCalls += 1
    return { cursor: 0, entries: [] }
  },
  getLogSnapshot: () => ({ cursor: 0, entries: [] }),
  getPort: () => 4510,
  getStatus: () => ({
    owned: serverRunning,
    port: 4510,
    running: serverRunning,
    statusRevision: serverStatusRevision,
  }),
  isRunning: () => serverRunning,
  reportServerError: (error: string) => {
    serverStatusRevision += 1
    return {
      error,
      owned: serverRunning,
      port: 4510,
      running: serverRunning,
      statusRevision: serverStatusRevision,
    }
  },
  startServer: () => {
    serverRunning = true
    serverStatusRevision += 1
    return Promise.resolve({
      owned: true,
      port: 4510,
      running: true,
      statusRevision: serverStatusRevision,
    })
  },
  stopServer: () => {
    serverRunning = false
    serverStatusRevision += 1
    return Promise.resolve({
      status: {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: serverStatusRevision,
      },
      stopped: true as const,
    })
  },
  subscribeLogs: (receive: (batch: unknown) => void) => {
    logBatchReceiver = receive
    const id = `sub-main-${nextLogSubscriptionId}`
    nextLogSubscriptionId += 1
    return {
      id,
      snapshot: { cursor: 0, entries: [] },
      unsubscribe: () => {
        logSubscriptionStopCalls += 1
      },
    }
  },
}

const originalFetch = globalThis.fetch

beforeAll(async () => {
  await import('../electron/preload')
  const { registerIpcHandlers } = await import('../electron/ipc-handlers')
  registerIpcHandlers(
    {
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    } as never,
    { serverRuntime: fakeServerRuntime as never },
  )
})

beforeEach(() => {
  clearLogsCalls = 0
  checkedListenerPorts.length = 0
  forkedProcesses.length = 0
  globalThis.fetch = originalFetch
  invoke.mockClear()
  invoke.mockImplementation(defaultInvoke)
  logBatchReceiver = undefined
  logSubscriptionStopCalls = 0
  nextLogSubscriptionId = 1
  rendererListeners.clear()
  serverRunning = true
  serverStatusRevision = 0
})

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('Desktop shared boundaries', () => {
  test('server URLs use the explicit IPv4 listener', () => {
    expect(buildServerLoopbackUrl(4510)).toBe('http://127.0.0.1:4510/')
  })

  test('preload exposes the typed model mappings outcome bridge', async () => {
    const api = exposedApi as DesktopApi

    await api.getModelMappingsConfig()
    await api.saveModelMappings({ alias: 'provider/model' })
    await api.configureProvider({ apiKey: 'key', provider: 'deepseek' })
    await api.startServer(4510, 'provider')
    await api.saveSettings({} as never)
    await api.fetchTokenUsage('day')
    await api.fetchTokenUsageDaily('week')
    await api.fetchTokenUsageEvents('month', 2, 10)
    await api.getServerLogSnapshot()
    await api.clearServerLogs()

    let authSuccess = false
    let observedPort = 0
    const stopAuth = api.onAuthSuccess((result) => {
      authSuccess = result.success
    })
    const stopStatus = api.onServerStatus((status) => {
      observedPort = status.port ?? 0
    })
    emitRenderer('auth:success', {}, { success: true })
    emitRenderer(
      'server:status',
      {},
      { owned: true, port: 4510, running: true, statusRevision: 1 },
    )
    stopAuth()
    stopStatus()

    expect(authSuccess).toBeTrue()
    expect(observedPort).toBe(4510)
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain(
      'server:fetch-token-usage-events',
    )
  })

  test('preload orders a raced log batch after its subscription snapshot', async () => {
    const api = exposedApi as DesktopApi
    let requestId = ''
    let resolveSubscribe:
      | ((value: {
          snapshot: { cursor: number; entries: never[] }
          subscriptionId: string
        }) => void)
      | undefined
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'server:logs-subscribe') {
        requestId = String(args[0])
        return new Promise((resolve) => {
          resolveSubscribe = resolve as unknown as typeof resolveSubscribe
        })
      }
      return Promise.resolve({ args, channel })
    })
    const updates: LogFeedUpdate[] = []
    const unsubscribe = api.subscribeServerLogs((update) =>
      updates.push(update),
    )

    emitRenderer(
      'server:log-batch',
      {},
      {
        batch: {
          cursor: 2,
          entries: [{ cursor: 2, message: 'after-snapshot' }],
          reset: false,
        },
        requestId,
        subscriptionId: 'sub-renderer',
      },
    )
    resolveSubscribe?.({
      snapshot: { cursor: 1, entries: [] },
      subscriptionId: 'sub-renderer',
    })
    await Promise.resolve()

    expect(updates).toEqual([
      { kind: 'snapshot', snapshot: { cursor: 1, entries: [] } },
      {
        batch: {
          cursor: 2,
          entries: [{ cursor: 2, message: 'after-snapshot' }],
          reset: false,
        },
        kind: 'batch',
      },
    ])

    unsubscribe()
    await Promise.resolve()
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain(
      'server:logs-unsubscribe',
    )
  })

  test('preload preserves raced batches for nine concurrent subscriptions', async () => {
    const api = exposedApi as DesktopApi
    const pending: Array<{
      requestId: string
      resolve: (value: {
        snapshot: { cursor: number; entries: never[] }
        subscriptionId: string
      }) => void
    }> = []
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'server:logs-subscribe') {
        return new Promise((resolve) => {
          pending.push({
            requestId: String(args[0]),
            resolve: resolve as unknown as (value: {
              snapshot: { cursor: number; entries: never[] }
              subscriptionId: string
            }) => void,
          })
        })
      }
      return Promise.resolve({ args, channel })
    })
    const updates = Array.from({ length: 9 }, () => [] as LogFeedUpdate[])
    const stops = updates.map((subscriptionUpdates) =>
      api.subscribeServerLogs((update) => subscriptionUpdates.push(update)),
    )
    expect(pending).toHaveLength(9)

    pending.forEach(({ requestId }, index) => {
      emitRenderer(
        'server:log-batch',
        {},
        {
          batch: {
            cursor: 1,
            entries: [{ cursor: 1, message: `subscription-${index}` }],
            reset: false,
          },
          requestId,
          subscriptionId: `sub-${index}`,
        },
      )
    })
    pending.forEach(({ resolve }, index) => {
      resolve({
        snapshot: { cursor: 0, entries: [] },
        subscriptionId: `sub-${index}`,
      })
    })
    await Promise.resolve()
    await Promise.resolve()

    updates.forEach((subscriptionUpdates, index) => {
      expect(subscriptionUpdates).toEqual([
        { kind: 'snapshot', snapshot: { cursor: 0, entries: [] } },
        {
          batch: {
            cursor: 1,
            entries: [{ cursor: 1, message: `subscription-${index}` }],
            reset: false,
          },
          kind: 'batch',
        },
      ])
    })
    stops.forEach((stop) => stop())
    await Promise.resolve()
    expect(rendererListeners.has('server:log-batch')).toBe(false)
  })

  test('preload releases a subscription that is disposed before invoke resolves', async () => {
    const api = exposedApi as DesktopApi
    let resolveSubscribe:
      | ((value: {
          snapshot: { cursor: number; entries: never[] }
          subscriptionId: string
        }) => void)
      | undefined
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'server:logs-subscribe') {
        return new Promise((resolve) => {
          resolveSubscribe = resolve as unknown as typeof resolveSubscribe
        })
      }
      return Promise.resolve({ args, channel })
    })

    const stop = api.subscribeServerLogs(() => undefined)
    stop()
    resolveSubscribe?.({
      snapshot: { cursor: 0, entries: [] },
      subscriptionId: 'disposed-subscription',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(rendererListeners.has('server:log-batch')).toBe(false)
    expect(invoke.mock.calls).toContainEqual([
      'server:logs-unsubscribe',
      'disposed-subscription',
    ])
  })

  test('preload bounds a capacity-plus-N burst raced before the snapshot', async () => {
    const api = exposedApi as DesktopApi
    let requestId = ''
    let resolveSubscribe:
      | ((value: {
          snapshot: { cursor: number; entries: never[] }
          subscriptionId: string
        }) => void)
      | undefined
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'server:logs-subscribe') {
        requestId = String(args[0])
        return new Promise((resolve) => {
          resolveSubscribe = resolve as unknown as typeof resolveSubscribe
        })
      }
      return Promise.resolve({ args, channel })
    })
    const updates: LogFeedUpdate[] = []
    const stop = api.subscribeServerLogs((update) => updates.push(update))
    for (let cursor = 1; cursor <= 2002; cursor += 1) {
      emitRenderer(
        'server:log-batch',
        {},
        {
          batch: {
            cursor,
            entries: [{ cursor, message: String(cursor) }],
            reset: false,
          },
          requestId,
          subscriptionId: 'burst-subscription',
        },
      )
    }
    resolveSubscribe?.({
      snapshot: { cursor: 0, entries: [] },
      subscriptionId: 'burst-subscription',
    })
    await Promise.resolve()

    expect(updates).toHaveLength(2)
    const burstUpdate = updates[1]
    expect(burstUpdate?.kind).toBe('batch')
    if (burstUpdate?.kind !== 'batch') throw new Error('missing burst batch')
    expect(burstUpdate.batch.cursor).toBe(2002)
    expect(burstUpdate.batch.entries).toHaveLength(2000)
    expect(burstUpdate.batch.entries[0]).toEqual({ cursor: 3, message: '3' })
    expect(burstUpdate.batch.entries.at(-1)).toEqual({
      cursor: 2002,
      message: '2002',
    })
    expect(burstUpdate.batch.reset).toBe(true)
    stop()
  })

  test('preload callback failure unsubscribes main exactly once', async () => {
    const api = exposedApi as DesktopApi
    let requestId = ''
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'server:logs-subscribe') {
        requestId = String(args[0])
        return Promise.resolve({
          args,
          channel,
          snapshot: { cursor: 0, entries: [] },
          subscriptionId: 'throwing-renderer-subscription',
        })
      }
      return Promise.resolve({ args, channel })
    })
    const stop = api.subscribeServerLogs((update) => {
      if (update.kind === 'batch') throw new Error('renderer callback failed')
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(() =>
      emitRenderer(
        'server:log-batch',
        {},
        {
          batch: {
            cursor: 1,
            entries: [{ cursor: 1, message: 'boom' }],
            reset: false,
          },
          requestId,
          subscriptionId: 'throwing-renderer-subscription',
        },
      ),
    ).not.toThrow()
    stop()
    await Promise.resolve()

    expect(
      invoke.mock.calls.filter(
        ([channel, subscriptionId]) =>
          channel === 'server:logs-unsubscribe'
          && subscriptionId === 'throwing-renderer-subscription',
      ),
    ).toHaveLength(1)
    expect(rendererListeners.has('server:log-batch')).toBe(false)
  })

  test('IPC returns serializable read and save outcomes', async () => {
    const requestedUrls: string[] = []
    const config = {
      configPath: '/tmp/config.json',
      modelMappings: { alias: 'provider/model' },
    }
    const saveResult = {
      ...config,
      catalogRefresh: {
        clientVersion: '0.144.2',
        degraded: false,
        inputRevision: 1,
        modelCount: 1,
        path: '/tmp/models.json',
        restartRequired: false,
        status: 'unchanged',
      },
    }
    globalThis.fetch = mock(
      (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl =
          typeof url === 'string' ? url
          : url instanceof URL ? url.toString()
          : url.url
        requestedUrls.push(requestUrl)
        const body =
          requestUrl.includes('/admin/config/model-mappings') ?
            init?.method === 'POST' ?
              saveResult
            : config
          : { ok: true }
        return Promise.resolve(Response.json(body))
      },
    ) as unknown as typeof fetch

    const readHandler = ipcHandlers.get('config:get-model-mappings')
    const saveHandler = ipcHandlers.get('config:save-model-mappings')
    expect(readHandler).toBeDefined()
    expect(saveHandler).toBeDefined()
    await expect(readHandler?.({})).resolves.toEqual({ config, ok: true })
    await expect(
      saveHandler?.({}, { alias: 'provider/model' }),
    ).resolves.toEqual({ ok: true, result: saveResult })

    await ipcHandlers.get('server:fetch-usage')?.({})
    await ipcHandlers.get('server:fetch-models')?.({})
    await ipcHandlers.get('server:fetch-token-usage')?.({}, 'day')
    await ipcHandlers.get('server:fetch-token-usage-daily')?.({}, 'week')
    await ipcHandlers.get('server:fetch-token-usage-events')?.(
      {},
      'month',
      2,
      10,
    )
    expect(
      requestedUrls.every((url) => url.startsWith('http://127.0.0.1:4510/')),
    ).toBeTrue()

    serverRunning = false
    await expect(readHandler?.({})).resolves.toMatchObject({ ok: false })
    await expect(
      saveHandler?.({}, { alias: 'provider/model' }),
    ).resolves.toMatchObject({ ok: false })
    serverRunning = true
  })

  test('IPC owns bounded log snapshots, batches, clear, and unsubscribe', async () => {
    const sent: unknown[] = []
    const lifecycleListeners = new Map<string, Set<IpcHandler>>()
    const sender = {
      id: 7,
      isDestroyed: () => false,
      on: (event: string, listener: IpcHandler) => {
        const listeners = lifecycleListeners.get(event) ?? new Set()
        listeners.add(listener)
        lifecycleListeners.set(event, listeners)
      },
      once: (event: string, listener: IpcHandler) => {
        const listeners = lifecycleListeners.get(event) ?? new Set()
        listeners.add(listener)
        lifecycleListeners.set(event, listeners)
      },
      removeListener: (event: string, listener: IpcHandler) =>
        lifecycleListeners.get(event)?.delete(listener),
      send: (...args: unknown[]) => sent.push(args),
    }
    const snapshot = ipcHandlers.get('server:logs-snapshot')
    const clear = ipcHandlers.get('server:logs-clear')
    const subscribe = ipcHandlers.get('server:logs-subscribe')
    const unsubscribe = ipcHandlers.get('server:logs-unsubscribe')

    expect(snapshot?.({ sender })).toEqual({ cursor: 0, entries: [] })
    expect(clear?.({ sender })).toEqual({ cursor: 0, entries: [] })
    expect(clearLogsCalls).toBe(1)
    expect(subscribe?.({ sender }, 'renderer-main-1')).toEqual({
      snapshot: { cursor: 0, entries: [] },
      subscriptionId: 'sub-main-1',
    })
    expect(lifecycleListeners.get('destroyed')?.size).toBe(1)
    expect(lifecycleListeners.get('did-start-navigation')?.size).toBe(1)

    const batch = {
      cursor: 1,
      entries: [{ cursor: 1, message: 'batched' }],
      reset: false,
    }
    logBatchReceiver?.(batch)
    expect(sent).toEqual([
      [
        'server:log-batch',
        {
          batch,
          requestId: 'renderer-main-1',
          subscriptionId: 'sub-main-1',
        },
      ],
    ])

    unsubscribe?.({ sender }, 'sub-main-1')
    expect(logSubscriptionStopCalls).toBe(1)
    expect(lifecycleListeners.get('destroyed')?.size).toBe(0)
    expect(lifecycleListeners.get('did-start-navigation')?.size).toBe(0)

    for (let index = 0; index < 3; index += 1) {
      const result = subscribe?.({ sender }, `renderer-main-${index + 2}`) as {
        subscriptionId: string
      }
      expect(lifecycleListeners.get('destroyed')?.size).toBe(1)
      expect(lifecycleListeners.get('did-start-navigation')?.size).toBe(1)
      unsubscribe?.({ sender }, result.subscriptionId)
      expect(lifecycleListeners.get('destroyed')?.size).toBe(0)
      expect(lifecycleListeners.get('did-start-navigation')?.size).toBe(0)
    }
  })

  test('IPC releases a renderer log subscription before reload navigation', () => {
    const lifecycleListeners = new Map<string, Set<IpcHandler>>()
    const sender = {
      id: 70,
      isDestroyed: () => false,
      on: (event: string, listener: IpcHandler) => {
        const listeners = lifecycleListeners.get(event) ?? new Set()
        listeners.add(listener)
        lifecycleListeners.set(event, listeners)
      },
      once: (event: string, listener: IpcHandler) => {
        const listeners = lifecycleListeners.get(event) ?? new Set()
        listeners.add(listener)
        lifecycleListeners.set(event, listeners)
      },
      removeListener: (event: string, listener: IpcHandler) =>
        lifecycleListeners.get(event)?.delete(listener),
      send: () => undefined,
    }
    const subscribe = ipcHandlers.get('server:logs-subscribe')
    const stopCallsBefore = logSubscriptionStopCalls

    subscribe?.({ sender }, 'renderer-reload')
    const navigationCleanup = [
      ...(lifecycleListeners.get('did-start-navigation') ?? []),
    ][0]
    expect(navigationCleanup).toBeDefined()
    navigationCleanup?.({ isMainFrame: false, isSameDocument: false })
    expect(logSubscriptionStopCalls).toBe(stopCallsBefore)
    navigationCleanup?.({ isMainFrame: true, isSameDocument: true })
    expect(logSubscriptionStopCalls).toBe(stopCallsBefore)
    navigationCleanup?.({ isMainFrame: true, isSameDocument: false })

    expect(logSubscriptionStopCalls).toBe(stopCallsBefore + 1)
    expect(lifecycleListeners.get('destroyed')?.size).toBe(0)
    expect(lifecycleListeners.get('did-start-navigation')?.size).toBe(0)
  })

  test('IPC evicts a log subscription when send races with renderer destruction', () => {
    const destroyedListeners = new Set<() => void>()
    const sender = {
      id: 8,
      isDestroyed: () => false,
      on: () => undefined,
      once: (_event: string, listener: () => void) => {
        destroyedListeners.add(listener)
      },
      removeListener: (_event: string, listener: () => void) =>
        destroyedListeners.delete(listener),
      send: () => {
        throw new Error('renderer destroyed during send')
      },
    }
    const subscribe = ipcHandlers.get('server:logs-subscribe')
    const stopCallsBefore = logSubscriptionStopCalls

    subscribe?.({ sender })
    expect(destroyedListeners.size).toBe(1)
    expect(() =>
      logBatchReceiver?.({ cursor: 1, entries: [], reset: false }),
    ).not.toThrow()
    expect(logSubscriptionStopCalls).toBe(stopCallsBefore + 1)
    expect(destroyedListeners.size).toBe(0)
  })

  test('IPC exposes deterministic status, stop, missing-auth start, and logout', async () => {
    const status = ipcHandlers.get('server:get-status')
    const stop = ipcHandlers.get('server:stop')
    const start = ipcHandlers.get('server:start')
    const logout = ipcHandlers.get('auth:logout')
    const clearsBeforeLogout = clearLogsCalls

    expect(status?.({})).toEqual({
      owned: true,
      port: 4510,
      running: true,
      statusRevision: 0,
    })
    await expect(stop?.({})).resolves.toEqual({
      status: {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 1,
      },
      stopped: true,
    })
    await expect(start?.({}, 4510, 'provider')).resolves.toMatchObject({
      running: false,
      statusRevision: 2,
    })
    await expect(logout?.({})).resolves.toBeUndefined()
    expect(clearLogsCalls).toBe(clearsBeforeLogout + 1)
  })

  test('Electron main and runtime entry modules load with the shared boundary', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(null))) as never
    const runtime = await import('../electron/server-manager-runtime')
    const {
      bindServerLifecycleToWindow,
      createMainApplicationShutdown,
      handleApplicationBeforeQuit,
      loadServerRuntimeDependencies,
    } = await import('../electron/main')
    const { DesktopServerIpcCoordinator } =
      await import('../electron/server-ipc-lifecycle')
    const { createServerManager } = await import('../electron/server-manager')

    expect(runtime.isRunning()).toBe(false)
    expect(runtime.getLogSnapshot()).toEqual({ cursor: 0, entries: [] })
    const subscription = runtime.subscribeLogs(() => undefined)
    expect(runtime.clearLogs()).toEqual({ cursor: 1, entries: [] })
    subscription.unsubscribe()

    expect(typeof runtime.startServer).toBe('function')
    expect(typeof runtime.stopServer).toBe('function')
    await expect(runtime.startServer(4511, 'provider')).resolves.toEqual({
      owned: true,
      port: 4511,
      running: true,
      statusRevision: 2,
    })
    expect(checkedListenerPorts).toEqual([{ host: '0.0.0.0', port: 4511 }])
    expect(forkedProcesses).toHaveLength(1)
    await runtime.stopServer()
    expect(runtime.isRunning()).toBeFalse()

    const injectedProcess = new EventEmitter() as EventEmitter & {
      kill: () => boolean
      stderr: PassThrough
      stdout: PassThrough
    }
    injectedProcess.stderr = new PassThrough()
    injectedProcess.stdout = new PassThrough()
    injectedProcess.kill = () => {
      queueMicrotask(() => injectedProcess.emit('exit', 0))
      return true
    }
    const checkedPorts: number[] = []
    const manager = createServerManager({
      env: {},
      fork: () => injectedProcess,
      getServerPath: () => '/isolated/server/main.js',
      isPortAvailable: (port) => {
        checkedPorts.push(port)
        return Promise.resolve(true)
      },
      probeServer: (_port, signal) => Promise.resolve(!signal.aborted),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      stopTimeoutMs: 5,
      translate: (key) => Promise.resolve(key),
    })
    await expect(manager.start(4511, 'provider')).resolves.toEqual({
      owned: true,
      port: 4511,
      running: true,
      statusRevision: 2,
    })
    expect(checkedPorts).toEqual([4511])
    await manager.stop()
    expect(manager.isRunning()).toBe(false)

    let releaseCredential: (() => void) | undefined
    let credentialReadStarted: (() => void) | undefined
    const credentialRead = new Promise<void>((resolve) => {
      releaseCredential = resolve
    })
    const credentialStarted = new Promise<void>((resolve) => {
      credentialReadStarted = resolve
    })
    let admissionForkCalls = 0
    const admissionManager = createServerManager({
      env: {},
      fork: () => {
        admissionForkCalls += 1
        return injectedProcess
      },
      getServerPath: () => '/isolated/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: (_port, signal) => Promise.resolve(!signal.aborted),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      stopTimeoutMs: 5,
      translate: (key) => Promise.resolve(key),
    })
    const credentialStart = admissionManager.startResolvingCredentials(
      4512,
      'copilot',
      {},
      async () => {
        credentialReadStarted?.()
        await credentialRead
        return { generation: 1, mode: 'copilot' as const, token: 'secret' }
      },
    )
    await credentialStarted
    const stoppedDuringCredentialRead = admissionManager.stop()
    releaseCredential?.()
    await expect(credentialStart).resolves.toMatchObject({ running: false })
    await expect(stoppedDuringCredentialRead).resolves.toMatchObject({
      stopped: true,
    })
    expect(admissionForkCalls).toBe(0)
    runtime.clearCallbacks()

    const sent: unknown[][] = []
    let destroyed = false
    let publishStatus:
      ((status: import('../../shared-types').ServerStatus) => void) | undefined
    bindServerLifecycleToWindow(
      {
        isDestroyed: () => destroyed,
        webContents: { send: (...args: unknown[]) => sent.push(args) },
      } as never,
      (callback) => {
        publishStatus = callback
      },
    )
    publishStatus?.({
      owned: true,
      port: 4511,
      running: true,
      statusRevision: 2,
    })
    destroyed = true
    publishStatus?.({
      owned: false,
      port: 4511,
      running: false,
      statusRevision: 3,
    })
    expect(sent).toEqual([
      [
        'server:status',
        { owned: true, port: 4511, running: true, statusRevision: 2 },
      ],
    ])
    expect(sent.flat()).not.toContain('server:log')

    const loaded = await loadServerRuntimeDependencies({
      loadIpcHandlers: () =>
        Promise.resolve({ registerIpcHandlers: (() => undefined) as never }),
      loadServerManager: () =>
        Promise.resolve({
          clearCallbacks: () => undefined,
          onStatusChange: () => undefined,
          stopServer: () =>
            Promise.resolve({
              status: {
                owned: false,
                port: 4511,
                running: false,
                statusRevision: 3,
              },
              stopped: true as const,
            }),
        } as never),
    })
    expect(Object.keys(loaded).sort()).toEqual([
      'clearCallbacks',
      'onStatusChange',
      'registerIpcHandlers',
      'stopServer',
    ])

    expect(appListeners.has('before-quit')).toBeTrue()
    let clearCallbacksCalls = 0
    let preventDefaultCalls = 0
    let quitting = false
    let resolveQuit: (() => void) | undefined
    const quitObserved = new Promise<void>((resolve) => {
      resolveQuit = resolve
    })
    const shutdown = createMainApplicationShutdown({
      coordinator: new DesktopServerIpcCoordinator(),
      loadRuntime: () =>
        Promise.resolve({
          clearCallbacks: () => {
            clearCallbacksCalls += 1
          },
          stopServer: () =>
            Promise.resolve({
              status: {
                owned: false,
                port: 4511,
                running: false,
                statusRevision: 1,
              },
              stopped: true as const,
            }),
        }),
      quit: () => resolveQuit?.(),
    })
    handleApplicationBeforeQuit(
      {
        preventDefault: () => {
          preventDefaultCalls += 1
        },
      },
      shutdown,
      (value) => {
        quitting = value
      },
    )
    await quitObserved
    expect(preventDefaultCalls).toBe(1)
    expect(clearCallbacksCalls).toBe(1)
    expect(quitting).toBeTrue()
  })

  test('renderer modules consume only the shared Desktop contract', async () => {
    const [
      { ModelMappingRowEditor },
      { buildDashboardServerUrls, DashboardLogRows, default: DashboardPage },
    ] = await Promise.all([
      import('../src/components/ModelMappingRowEditor'),
      import('../src/pages/DashboardPage'),
    ])
    const sharedTypes = await import('../src/types/ipc')

    expect(typeof DashboardPage).toBe('function')
    expect(buildDashboardServerUrls(4510)).toEqual({
      anthropicUrl: 'http://127.0.0.1:4510',
      openaiUrl: 'http://127.0.0.1:4510/v1',
    })
    expect(
      renderToStaticMarkup(
        createElement(DashboardLogRows, {
          emptyText: 'No logs',
          endRef: { current: null },
          entries: [
            { cursor: 1, message: 'first\n' },
            { cursor: 2, message: 'second' },
          ],
        }),
      ),
    ).toContain('first')
    expect(
      renderToStaticMarkup(
        createElement(DashboardLogRows, {
          emptyText: 'No logs',
          endRef: { current: null },
          entries: [],
        }),
      ),
    ).toContain('No logs')
    expect(sharedTypes.TOKEN_USAGE_OUTCOME_VALUES).toContain('failed')
    expect(
      renderToStaticMarkup(
        createElement(ModelMappingRowEditor, {
          onChange: () => undefined,
          onRemove: () => undefined,
          removeLabel: 'Remove',
          row: {
            diagnostics: [{ code: 'chain', source: 'alias', target: 'target' }],
            id: 'row-1',
            source: 'alias',
            target: 'target',
          },
          sourceLabel: 'Source',
          targetLabel: 'Target',
        }),
      ),
    ).toContain('chain · source=&quot;alias&quot; · target=&quot;target&quot;')
  })
})
