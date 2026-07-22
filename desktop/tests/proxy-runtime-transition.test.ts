import { expect, mock, test } from 'bun:test'

import { applyDesktopProxySettingsToEnv } from '../electron/electron-proxy-config'
import { applyProxyRuntimeTransition } from '../electron/proxy-runtime-transition'
import { saveAndApplyDesktopSettings } from '../electron/settings-apply'
import {
  SETTINGS_RUNTIME_ACTIONS,
  type DesktopProxySettings,
  type DesktopSettings,
  type ServerStatus,
} from '../src/types/ipc'

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

const createSettings = (proxy: DesktopProxySettings): DesktopSettings => ({
  accountType: 'individual',
  apiHome: '',
  enterpriseUrl: '',
  language: 'auto',
  lastPort: 4141,
  minimizeToTray: false,
  oauthApp: 'default',
  proxy,
  theme: 'auto',
  verbose: false,
})

const createServerStatus = (
  overrides: Partial<ServerStatus> = {},
): ServerStatus => ({
  owned: false,
  port: 4141,
  running: false,
  statusRevision: 0,
  ...overrides,
})

test('running system proxy transitions to required custom proxy by stop-apply-restart', async () => {
  const events: string[] = []
  const restartedEnv: NodeJS.ProcessEnv = {
    npm_config_https_proxy: 'http://poison.example:8080',
  }
  let running = true
  let statusRevision = 1

  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async (proxy) => {
        events.push(`apply:${proxy.mode}`)
      },
      getStatus: () =>
        createServerStatus({
          owned: running,
          running,
          statusRevision,
        }),
      isRunning: () => running,
      restartServerWithProxy: async (proxy) => {
        events.push(`restart:${proxy.mode}`)
        applyDesktopProxySettingsToEnv(restartedEnv, proxy)
        running = true
        statusRevision += 1
        return createServerStatus({
          owned: true,
          running: true,
          statusRevision,
        })
      },
      stopServer: async () => {
        events.push('stop')
        running = false
        statusRevision += 1
      },
    },
  })

  expect(events).toEqual(['stop', 'apply:custom', 'restart:custom'])
  expect(result).toEqual({
    action: 'restarted',
    proxyChanged: true,
    serverStatus: {
      owned: true,
      port: 4141,
      running: true,
      statusRevision: 3,
    },
    success: true,
  })
  expect(restartedEnv.COPILOT_API_PROXY_REQUIRED).toBe('1')
  expect(restartedEnv.npm_config_https_proxy).toBeUndefined()
  expect(restartedEnv.HTTPS_PROXY).toBe('socks5://127.0.0.1:1080')
})

test('proxy apply failure leaves the previously running server stopped', async () => {
  let running = true
  let statusRevision = 1
  const restartServerWithProxy = mock(async (_proxy: DesktopProxySettings) =>
    createServerStatus({
      owned: true,
      running: true,
      statusRevision: 3,
    }),
  )

  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {
        throw new Error('proxy activation failed')
      },
      getStatus: () =>
        createServerStatus({
          owned: running,
          running,
          statusRevision,
        }),
      isRunning: () => running,
      restartServerWithProxy,
      stopServer: async () => {
        running = false
        statusRevision += 1
      },
    },
  })

  expect(result).toEqual({
    action: 'stopped',
    error: 'proxy activation failed',
    proxyChanged: true,
    serverStatus: {
      error: 'proxy activation failed',
      owned: false,
      port: 4141,
      running: false,
      statusRevision: 2,
    },
    success: false,
  })
  expect(running).toBe(false)
  expect(restartServerWithProxy).not.toHaveBeenCalled()
})

test('proxy restart failure remains stopped with a structured outcome', async () => {
  let running = true
  let statusRevision = 1
  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      getStatus: () =>
        createServerStatus({
          owned: running,
          running,
          statusRevision,
        }),
      isRunning: () => running,
      restartServerWithProxy: async () =>
        createServerStatus({
          error: 'utility server failed to restart',
          statusRevision: 3,
        }),
      stopServer: async () => {
        running = false
        statusRevision += 1
      },
    },
  })

  expect(result).toEqual({
    action: 'stopped',
    error: 'utility server failed to restart',
    proxyChanged: true,
    serverStatus: {
      error: 'utility server failed to restart',
      owned: false,
      port: 4141,
      running: false,
      statusRevision: 3,
    },
    success: false,
  })
  expect(running).toBe(false)
})

test('stopped server applies a changed proxy without starting utility runtime', async () => {
  const stoppedStatus = createServerStatus({ statusRevision: 4 })
  const restartServerWithProxy = mock(async (_proxy: DesktopProxySettings) =>
    createServerStatus({
      owned: true,
      running: true,
      statusRevision: 5,
    }),
  )
  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      getStatus: () => stoppedStatus,
      isRunning: () => false,
      restartServerWithProxy,
      stopServer: async () => {},
    },
  })

  expect(result).toEqual({
    action: 'applied',
    proxyChanged: true,
    serverStatus: stoppedStatus,
    success: true,
  })
  expect(restartServerWithProxy).not.toHaveBeenCalled()
})

test('stop and thrown restart failures return stopped outcomes', async () => {
  let stoppedBeforeFailure = false
  let stopFailureRevision = 1
  const stopFailure = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      getStatus: () =>
        createServerStatus({
          owned: !stoppedBeforeFailure,
          running: !stoppedBeforeFailure,
          statusRevision: stopFailureRevision,
        }),
      isRunning: () => !stoppedBeforeFailure,
      restartServerWithProxy: async () =>
        createServerStatus({
          owned: true,
          running: true,
          statusRevision: 3,
        }),
      stopServer: async () => {
        stoppedBeforeFailure = true
        stopFailureRevision += 1
        throw new Error('stop failed')
      },
    },
  })
  expect(stopFailure).toMatchObject({
    action: 'stopped',
    error: 'stop failed',
    success: false,
  })

  let running = true
  let restartFailureRevision = 1
  const restartFailure = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      getStatus: () =>
        createServerStatus({
          owned: running,
          running,
          statusRevision: restartFailureRevision,
        }),
      isRunning: () => running,
      restartServerWithProxy: async () => {
        throw new Error('restart threw')
      },
      stopServer: async () => {
        running = false
        restartFailureRevision += 1
      },
    },
  })
  expect(restartFailure).toMatchObject({
    action: 'stopped',
    error: 'restart threw',
    success: false,
  })
})

test('unchanged proxy policy does not disturb a running server', async () => {
  const runningStatus = createServerStatus({
    owned: true,
    running: true,
    statusRevision: 7,
  })
  const stopServer = mock(async () => {})
  const applyProxy = mock(async (_proxy: DesktopProxySettings) => {})
  const restartServerWithProxy = mock(
    async (_proxy: DesktopProxySettings) => runningStatus,
  )

  const result = await applyProxyRuntimeTransition({
    next: { ...customProxy },
    previous: customProxy,
    dependencies: {
      applyProxy,
      getStatus: () => runningStatus,
      isRunning: () => true,
      restartServerWithProxy,
      stopServer,
    },
  })

  expect(result).toEqual({
    action: 'unchanged',
    proxyChanged: false,
    serverStatus: runningStatus,
    success: true,
  })
  expect(stopServer).not.toHaveBeenCalled()
  expect(applyProxy).not.toHaveBeenCalled()
  expect(restartServerWithProxy).not.toHaveBeenCalled()
})

test('settings apply returns a structured failure while preserving stopped state', async () => {
  const previous = createSettings(systemProxy)
  const next = createSettings(customProxy)
  const writes: DesktopSettings[] = []
  const stoppedStatus = createServerStatus({ statusRevision: 2 })

  const result = await saveAndApplyDesktopSettings(next, {
    getStatus: () => stoppedStatus,
    onSettingsChange: async () => {
      throw new Error('runtime apply failed')
    },
    readSettings: async () => previous,
    writeSettings: async (settings) => {
      writes.push(settings)
    },
  })

  expect(writes).toEqual([next])
  expect(result).toEqual({
    action: 'failed',
    error: 'runtime apply failed',
    proxyChanged: true,
    serverStatus: {
      error: 'runtime apply failed',
      owned: false,
      port: 4141,
      running: false,
      statusRevision: 2,
    },
    success: false,
  })
})

test('settings apply returns the default runtime snapshot without a callback', async () => {
  const settings = createSettings(systemProxy)
  const runningStatus = createServerStatus({
    owned: true,
    port: 4510,
    running: true,
    statusRevision: 5,
  })
  const result = await saveAndApplyDesktopSettings(settings, {
    getStatus: () => runningStatus,
    readSettings: async () => settings,
    writeSettings: async () => {},
  })

  expect(result).toEqual({
    action: 'unchanged',
    proxyChanged: false,
    serverStatus: runningStatus,
    success: true,
  })
})

test('settings UI and shared runtime action contract are loadable', async () => {
  const settingsModule = await import('../src/components/SettingsModal')

  expect(settingsModule.default).toBeFunction()
  expect(
    settingsModule.resolveSettingsRuntimeError(
      {
        action: 'stopped',
        proxyChanged: true,
        serverStatus: createServerStatus({
          error: 'proxy restart failed',
          statusRevision: 8,
        }),
        success: false,
      },
      'fallback',
    ),
  ).toBe('proxy restart failed')
  expect(
    settingsModule.resolveSettingsRuntimeError(
      {
        action: 'restarted',
        proxyChanged: true,
        serverStatus: createServerStatus({
          owned: true,
          running: true,
          statusRevision: 9,
        }),
        success: true,
      },
      'fallback',
    ),
  ).toBeNull()
  expect(SETTINGS_RUNTIME_ACTIONS).toEqual([
    'applied',
    'failed',
    'restarted',
    'stopped',
    'unchanged',
  ])
})
