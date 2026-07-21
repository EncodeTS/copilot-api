import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import type { DesktopProxySettings } from '../src/types/ipc'

class FakeUtilityProcess extends EventEmitter {
  killCount = 0
  pid: number | undefined = 42_424
  stderr = null
  stdout = null

  kill(): boolean {
    this.killCount += 1
    queueMicrotask(() => {
      this.pid = undefined
      this.emit('exit', 0)
    })
    return true
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const forks: Array<{
  args: string[]
  options: { env?: NodeJS.ProcessEnv }
  process: FakeUtilityProcess
}> = []
const setAppProxy = mock((_config: unknown) => Promise.resolve())
const setSessionProxy = mock((_config: unknown) => Promise.resolve())
const closeAllConnections = mock(() => Promise.resolve())
const forceReloadProxyConfig = mock(() => Promise.resolve())
let nextForkError: Error | null = null
let nextForkObserver: Deferred<FakeUtilityProcess> | null = null
let nextFetchObserver: Deferred<void> | null = null
let readinessBarrier: Promise<void> | null = null
const ipcHandle = mock((_channel: string, _handler: unknown) => {})
const appendSwitch = mock((_name: string, _value?: string) => {})
const testSettings = {
  accountType: 'individual' as const,
  apiHome: '',
  enterpriseUrl: '',
  language: 'auto' as const,
  lastPort: 4141,
  minimizeToTray: false,
  oauthApp: 'default' as const,
  proxy: {
    mode: 'system' as const,
    http_proxy: '',
    https_proxy: '',
    no_proxy: '',
  },
  showToken: false,
  theme: 'auto' as const,
  verbose: false,
}
const actualSettingsStore = await import('../electron/settings-store')

await mock.module('../electron/settings-store', () => ({
  ...actualSettingsStore,
  readSettings: () => Promise.resolve(testSettings),
  readSettingsSync: () => testSettings,
  writeSettings: (_settings: unknown) => Promise.resolve(),
}))

await mock.module('electron', () => ({
  app: {
    commandLine: { appendSwitch },
    dock: undefined,
    exit: mock((_code: number) => {}),
    getAppPath: () => '/tmp/copilot-api-desktop',
    getLocale: () => 'en-US',
    isPackaged: false,
    isReady: () => true,
    on: mock(() => {}),
    quit: mock(() => {}),
    setProxy: setAppProxy,
    whenReady: () => new Promise<void>(() => {}),
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: mock(() => ({})) },
  Tray: class {},
  ipcMain: {
    handle: ipcHandle,
    on: mock(() => {}),
  },
  nativeImage: { createFromPath: mock(() => ({})) },
  nativeTheme: { shouldUseDarkColors: false },
  session: {
    defaultSession: {
      closeAllConnections,
      forceReloadProxyConfig,
      setProxy: setSessionProxy,
    },
  },
  shell: { openExternal: mock(() => Promise.resolve()) },
  utilityProcess: {
    fork: (
      _serverPath: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      if (nextForkError) {
        const error = nextForkError
        nextForkError = null
        throw error
      }
      const process = new FakeUtilityProcess()
      forks.push({
        args,
        options,
        process,
      })
      nextForkObserver?.resolve(process)
      nextForkObserver = null
      return process
    },
  },
}))

const manager = await import('../electron/server-manager')
const { applyElectronProxy } = await import('../electron/electron-proxy')
const runtime = await import('../electron/desktop-proxy-runtime')
const originalFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = mock(async () => {
    if (readinessBarrier) {
      nextFetchObserver?.resolve()
      nextFetchObserver = null
      await readinessBarrier
    }
    return new Response('ok')
  }) as unknown as typeof fetch
})

beforeEach(() => {
  setAppProxy.mockReset()
  setSessionProxy.mockReset()
  closeAllConnections.mockReset()
  forceReloadProxyConfig.mockReset()
  setAppProxy.mockResolvedValue(undefined)
  setSessionProxy.mockResolvedValue(undefined)
  closeAllConnections.mockResolvedValue(undefined)
  forceReloadProxyConfig.mockResolvedValue(undefined)
})

afterAll(async () => {
  await manager.stopServer()
  globalThis.fetch = originalFetch
  delete process.env.npm_config_https_proxy
})

test('custom Electron proxy mode fails closed when proxy activation fails', async () => {
  setAppProxy.mockRejectedValueOnce(new Error('proxy unavailable'))

  await expect(
    applyElectronProxy({
      mode: 'custom',
      http_proxy: 'http://127.0.0.1:8888',
      https_proxy: 'socks5://127.0.0.1:1080',
      no_proxy: 'localhost,127.0.0.1',
    }),
  ).rejects.toThrow('Required custom proxy configuration failed')
  expect(setSessionProxy).not.toHaveBeenCalled()
})

test('system Electron proxy mode remains best effort', async () => {
  setAppProxy.mockRejectedValueOnce(new Error('system proxy unavailable'))

  await expect(
    applyElectronProxy({
      mode: 'system',
      http_proxy: '',
      https_proxy: '',
      no_proxy: '',
    }),
  ).resolves.toBeUndefined()
})

test('server manager restarts the last launch with the new required proxy env', async () => {
  const systemProxy: DesktopProxySettings = {
    mode: 'system',
    http_proxy: '',
    https_proxy: '',
    no_proxy: '',
  }
  const customProxy: DesktopProxySettings = {
    mode: 'custom',
    http_proxy: 'http://127.0.0.1:8888',
    https_proxy: 'socks5://127.0.0.1:1080',
    no_proxy: 'localhost,127.0.0.1',
  }

  const initial = await manager.startServer(
    0,
    'old-token',
    {
      proxy: systemProxy,
      verbose: true,
    },
    { generation: 1, mode: 'copilot' },
  )
  expect(initial).toEqual({ port: 0, running: true })
  expect(manager.getServerRestartContextDiagnostics()).toEqual({
    generation: 1,
    mode: 'copilot',
    port: 0,
  })
  expect(manager.getServerRestartContextDiagnostics()).not.toHaveProperty(
    'token',
  )
  expect(forks).toHaveLength(1)

  await manager.stopServer()
  process.env.npm_config_https_proxy = 'http://poison.example:8080'
  const restarted = await manager.restartServerWithProxy(customProxy, () =>
    Promise.resolve({
      generation: 2,
      mode: 'copilot' as const,
      token: 'new-token',
    }),
  )

  expect(restarted).toEqual({ port: 0, running: true })
  expect(manager.getServerRestartContextDiagnostics()).toEqual({
    generation: 2,
    mode: 'copilot',
    port: 0,
  })
  expect(forks).toHaveLength(2)
  const restart = forks[1]
  expect(restart?.args).toContain('--proxy-env')
  expect(restart?.args).toContain('--verbose')
  expect(restart?.args).toContain('new-token')
  expect(restart?.args).not.toContain('old-token')
  expect(restart?.options.env).toMatchObject({
    COPILOT_API_PROXY_REQUIRED: '1',
    HTTP_PROXY: 'http://127.0.0.1:8888/',
    HTTPS_PROXY: 'socks5://127.0.0.1:1080',
    NO_PROXY: 'localhost,127.0.0.1',
  })
  expect(restart?.options.env?.npm_config_https_proxy).toBeUndefined()

  expect(
    await manager.restartServerWithProxy(customProxy, () =>
      Promise.resolve({
        generation: 2,
        mode: 'copilot',
        token: 'new-token',
      }),
    ),
  ).toEqual({
    error: 'Utility server must be stopped before applying a proxy restart',
    running: false,
  })
  manager.clearServerRestartContext()
  expect(manager.getServerRestartContextDiagnostics()).toBeNull()
  await manager.stopServer()
  const clearedForkCount = forks.length
  expect(
    await runtime.applyDesktopProxyRuntimeTransition(customProxy, {
      ...customProxy,
      mode: 'direct',
    }),
  ).toMatchObject({
    action: 'applied',
    serverStatus: { running: false },
    success: true,
  })
  expect(forks).toHaveLength(clearedForkCount)
  expect(
    await manager.restartServerWithProxy(customProxy, () =>
      Promise.resolve({
        generation: 3,
        mode: 'copilot',
        token: 'new-token',
      }),
    ),
  ).toEqual({
    error: 'No safe utility server restart context is available',
    running: false,
  })
  expect(forks).toHaveLength(clearedForkCount)

  expect(
    await manager.startServer(
      0,
      null,
      { proxy: customProxy },
      { generation: 4, mode: 'provider' },
    ),
  ).toEqual({ port: 0, running: true })
  await manager.stopServer()
  expect(
    await manager.restartServerWithProxy(customProxy, () =>
      Promise.resolve({
        generation: 5,
        mode: 'provider',
        token: null,
      }),
    ),
  ).toEqual({ port: 0, running: true })
  const providerRestart = forks.at(-1)
  expect(providerRestart?.args).not.toContain('--github-token')
  expect(providerRestart?.args).not.toContain('old-token')
  expect(providerRestart?.args).not.toContain('new-token')
  await manager.stopServer()

  const forkCount = forks.length
  expect(
    await manager.startServer(0, null, {
      proxy: {
        ...customProxy,
        https_proxy: 'socks4://127.0.0.1:1080',
      },
    }),
  ).toMatchObject({
    running: false,
  })
  expect(forks).toHaveLength(forkCount)

  const secondResolveStarted = deferred<void>()
  const releaseSecondResolve = deferred<void>()
  let resolveCalls = 0
  const forkCountBeforeLogoutRace = forks.length
  const inFlightRestart = manager.restartServerWithProxy(
    customProxy,
    async () => {
      resolveCalls += 1
      if (resolveCalls === 2) {
        secondResolveStarted.resolve()
        await releaseSecondResolve.promise
      }
      return { generation: 5, mode: 'provider', token: null }
    },
  )

  await Promise.race([
    secondResolveStarted.promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('pre-fork resolve was not reached')),
        2_000,
      ),
    ),
  ])
  manager.clearServerRestartContext()
  releaseSecondResolve.resolve()

  expect(await inFlightRestart).toMatchObject({ running: false })
  expect(forks).toHaveLength(forkCountBeforeLogoutRace)
  expect(manager.getServerRestartContextDiagnostics()).toBeNull()

  expect(
    await manager.startServer(
      0,
      'rotation-old-token',
      { proxy: customProxy },
      { generation: 10, mode: 'copilot' },
    ),
  ).toEqual({ port: 0, running: true })
  await manager.stopServer()

  const rotationSecondResolveStarted = deferred<void>()
  const releaseRotationResolve = deferred<void>()
  let rotationResolveCalls = 0
  let rotated = false
  const forkCountBeforeRotationRace = forks.length
  const rotationRestart = manager.restartServerWithProxy(
    customProxy,
    async () => {
      rotationResolveCalls += 1
      if (rotationResolveCalls === 2) {
        rotationSecondResolveStarted.resolve()
        await releaseRotationResolve.promise
      }
      return rotated ?
          {
            generation: 11,
            mode: 'copilot' as const,
            token: 'rotation-new-token',
          }
        : {
            generation: 10,
            mode: 'copilot' as const,
            token: 'rotation-old-token',
          }
    },
  )

  await rotationSecondResolveStarted.promise
  rotated = true
  releaseRotationResolve.resolve()

  expect(await rotationRestart).toMatchObject({ running: false })
  expect(forks).toHaveLength(forkCountBeforeRotationRace)
  expect(forks.slice(forkCountBeforeRotationRace)).toEqual([])

  expect(
    await manager.restartServerWithProxy(customProxy, () =>
      Promise.resolve(null),
    ),
  ).toEqual({
    error:
      'Current credentials are unavailable; utility server remains stopped',
    running: false,
  })
  expect(manager.getServerRestartContextDiagnostics()).toBeNull()

  nextForkError = new Error('fork failed safely')
  expect(
    await manager.startServer(
      0,
      null,
      { proxy: customProxy },
      { generation: 12, mode: 'provider' },
    ),
  ).toEqual({ error: 'fork failed safely', running: false })

  expect(
    await manager.startServer(
      0,
      'post-fork-old-token',
      { proxy: customProxy },
      { generation: 20, mode: 'copilot' },
    ),
  ).toEqual({ port: 0, running: true })
  await manager.stopServer()

  let currentGeneration = 20
  let currentToken = 'post-fork-old-token'
  const releaseReady = deferred<void>()
  readinessBarrier = releaseReady.promise
  nextForkObserver = deferred<FakeUtilityProcess>()
  nextFetchObserver = deferred<void>()
  const forkObserved = nextForkObserver.promise
  const fetchObserved = nextFetchObserver.promise
  const postForkRotation = manager.restartServerWithProxy(customProxy, () =>
    Promise.resolve({
      generation: currentGeneration,
      mode: 'copilot' as const,
      token: currentToken,
    }),
  )

  const oldCredentialChild = await forkObserved
  await fetchObserved
  currentGeneration = 21
  currentToken = 'post-fork-new-token'
  releaseReady.resolve()
  readinessBarrier = null

  expect(await postForkRotation).toEqual({
    error: 'Credential state changed while utility server was starting',
    running: false,
  })
  expect(oldCredentialChild.killCount).toBeGreaterThanOrEqual(1)
  expect(manager.isRunning()).toBe(false)
  expect(manager.getServerRestartContextDiagnostics()).toBeNull()
})

test('Desktop proxy runtime, IPC, and main wiring load against the shared contract', async () => {
  const ipc = await import('../electron/ipc-handlers')
  await import('../electron/main')

  expect(runtime.applyDesktopProxyRuntimeTransition).toBeFunction()
  expect(ipc.registerIpcHandlers).toBeFunction()
  expect(
    await runtime.applyDesktopProxyRuntimeTransition(
      testSettings.proxy,
      testSettings.proxy,
    ),
  ).toMatchObject({ action: 'unchanged', success: true })
})
