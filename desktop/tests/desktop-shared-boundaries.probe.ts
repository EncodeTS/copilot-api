import { afterAll, describe, expect, mock, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DesktopApi } from '../../shared-types'
import { buildServerLoopbackUrl } from '../electron/server-loopback'

type IpcHandler = (...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()
const rendererListeners = new Map<string, IpcHandler>()
const invoke = mock((channel: string, ...args: unknown[]) =>
  Promise.resolve({ args, channel }),
)
let exposedApi: unknown
let serverRunning = true

void mock.module('electron', () => ({
  app: {
    getAppPath: () => '/tmp/copilot-api-desktop',
    getLocale: () => 'en',
    isPackaged: false,
  },
  BrowserWindow: class {},
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
    off: (channel: string) => rendererListeners.delete(channel),
    on: (channel: string, handler: IpcHandler) => {
      rendererListeners.set(channel, handler)
    },
    send: () => undefined,
  },
  shell: { openExternal: () => Promise.resolve() },
  utilityProcess: { fork: () => undefined },
}))

void mock.module('../electron/server-manager', () => ({
  clearServerRestartContext: () => undefined,
  getLogs: () => [],
  getPort: () => 4510,
  isRunning: () => serverRunning,
  startServer: () => Promise.resolve({ port: 4510, running: true }),
  stopServer: () => Promise.resolve(),
}))

const originalFetch = globalThis.fetch

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('Desktop shared boundaries', () => {
  test('server URLs use the explicit IPv4 listener', () => {
    expect(buildServerLoopbackUrl(4510)).toBe('http://127.0.0.1:4510/')
  })

  test('preload exposes the typed model mappings outcome bridge', async () => {
    await import('../electron/preload')
    const api = exposedApi as DesktopApi

    await api.getModelMappingsConfig()
    await api.saveModelMappings({ alias: 'provider/model' })
    await api.configureProvider({ apiKey: 'key', provider: 'deepseek' })
    await api.startServer(4510, 'provider')
    await api.saveSettings({} as never)
    await api.fetchTokenUsage('day')
    await api.fetchTokenUsageDaily('week')
    await api.fetchTokenUsageEvents('month', 2, 10)

    let authSuccess = false
    let observedPort = 0
    const stopAuth = api.onAuthSuccess((result) => {
      authSuccess = result.success
    })
    const stopStatus = api.onServerStatus((status) => {
      observedPort = status.port ?? 0
    })
    rendererListeners.get('auth:success')?.({}, { success: true })
    rendererListeners.get('server:status')?.({}, { port: 4510, running: true })
    stopAuth()
    stopStatus()

    expect(authSuccess).toBeTrue()
    expect(observedPort).toBe(4510)
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain(
      'server:fetch-token-usage-events',
    )
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

    const { registerIpcHandlers } = await import('../electron/ipc-handlers')
    registerIpcHandlers({
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    } as never)

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
      requestedUrls
        .filter((url) => !url.includes('/admin/config/model-mappings'))
        .every((url) => url.startsWith('http://127.0.0.1:4510/')),
    ).toBeTrue()

    serverRunning = false
    await expect(readHandler?.({})).resolves.toMatchObject({ ok: false })
    await expect(
      saveHandler?.({}, { alias: 'provider/model' }),
    ).resolves.toMatchObject({ ok: false })
    serverRunning = true
  })

  test('renderer modules consume only the shared Desktop contract', async () => {
    const [
      { ModelMappingRowEditor },
      { default: ModelMappingsPage },
      { LanguageProvider },
      dashboard,
    ] = await Promise.all([
      import('../src/components/ModelMappingRowEditor'),
      import('../src/pages/ModelMappingsPage'),
      import('../src/contexts/LanguageContext'),
      import('../src/pages/DashboardPage'),
    ])
    const sharedTypes = await import('../src/types/ipc')

    expect(typeof dashboard.default).toBe('function')
    expect(dashboard.buildDashboardServerUrls(4510)).toEqual({
      anthropicUrl: 'http://127.0.0.1:4510',
      openaiUrl: 'http://127.0.0.1:4510/v1',
    })
    expect(sharedTypes.TOKEN_USAGE_OUTCOME_VALUES).toContain('failed')
    expect(
      renderToStaticMarkup(
        createElement(
          LanguageProvider,
          null,
          createElement(ModelMappingsPage, { serverRunning: false }),
        ),
      ),
    ).toContain('Model mappings')
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
