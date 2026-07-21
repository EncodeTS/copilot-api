import { expect, mock, test } from 'bun:test'

import { applyDesktopProxySettingsToEnv } from '../electron/electron-proxy-config'
import { applyProxyRuntimeTransition } from '../electron/proxy-runtime-transition'
import { saveAndApplyDesktopSettings } from '../electron/settings-apply'
import {
  SETTINGS_RUNTIME_ACTIONS,
  type DesktopProxySettings,
  type DesktopSettings,
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
  showToken: false,
  theme: 'auto',
  verbose: false,
})

test('running system proxy transitions to required custom proxy by stop-apply-restart', async () => {
  const events: string[] = []
  const restartedEnv: NodeJS.ProcessEnv = {
    npm_config_https_proxy: 'http://poison.example:8080',
  }
  let running = true

  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async (proxy) => {
        events.push(`apply:${proxy.mode}`)
      },
      isRunning: () => running,
      restartServerWithProxy: async (proxy) => {
        events.push(`restart:${proxy.mode}`)
        applyDesktopProxySettingsToEnv(restartedEnv, proxy)
        running = true
        return { running: true, port: 4141 }
      },
      stopServer: async () => {
        events.push('stop')
        running = false
      },
    },
  })

  expect(events).toEqual(['stop', 'apply:custom', 'restart:custom'])
  expect(result).toEqual({
    action: 'restarted',
    proxyChanged: true,
    serverStatus: { running: true, port: 4141 },
    success: true,
  })
  expect(restartedEnv.COPILOT_API_PROXY_REQUIRED).toBe('1')
  expect(restartedEnv.npm_config_https_proxy).toBeUndefined()
  expect(restartedEnv.HTTPS_PROXY).toBe('socks5://127.0.0.1:1080')
})

test('proxy apply failure leaves the previously running server stopped', async () => {
  let running = true
  const restartServerWithProxy = mock(async (_proxy: DesktopProxySettings) => ({
    running: true,
    port: 4141,
  }))

  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {
        throw new Error('proxy activation failed')
      },
      isRunning: () => running,
      restartServerWithProxy,
      stopServer: async () => {
        running = false
      },
    },
  })

  expect(result).toEqual({
    action: 'stopped',
    error: 'proxy activation failed',
    proxyChanged: true,
    serverStatus: { error: 'proxy activation failed', running: false },
    success: false,
  })
  expect(running).toBe(false)
  expect(restartServerWithProxy).not.toHaveBeenCalled()
})

test('proxy restart failure remains stopped with a structured outcome', async () => {
  let running = true
  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      isRunning: () => running,
      restartServerWithProxy: async () => ({
        error: 'utility server failed to restart',
        running: false,
      }),
      stopServer: async () => {
        running = false
      },
    },
  })

  expect(result).toEqual({
    action: 'stopped',
    error: 'utility server failed to restart',
    proxyChanged: true,
    serverStatus: {
      error: 'utility server failed to restart',
      running: false,
    },
    success: false,
  })
  expect(running).toBe(false)
})

test('stopped server applies a changed proxy without starting utility runtime', async () => {
  const restartServerWithProxy = mock(async (_proxy: DesktopProxySettings) => ({
    port: 4141,
    running: true,
  }))
  const result = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      isRunning: () => false,
      restartServerWithProxy,
      stopServer: async () => {},
    },
  })

  expect(result).toEqual({
    action: 'applied',
    proxyChanged: true,
    serverStatus: { running: false },
    success: true,
  })
  expect(restartServerWithProxy).not.toHaveBeenCalled()
})

test('stop and thrown restart failures return stopped outcomes', async () => {
  let stoppedBeforeFailure = false
  const stopFailure = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      isRunning: () => !stoppedBeforeFailure,
      restartServerWithProxy: async () => ({ running: true }),
      stopServer: async () => {
        stoppedBeforeFailure = true
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
  const restartFailure = await applyProxyRuntimeTransition({
    next: customProxy,
    previous: systemProxy,
    dependencies: {
      applyProxy: async () => {},
      isRunning: () => running,
      restartServerWithProxy: async () => {
        throw new Error('restart threw')
      },
      stopServer: async () => {
        running = false
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
  const stopServer = mock(async () => {})
  const applyProxy = mock(async (_proxy: DesktopProxySettings) => {})
  const restartServerWithProxy = mock(async (_proxy: DesktopProxySettings) => ({
    running: true,
    port: 4141,
  }))

  const result = await applyProxyRuntimeTransition({
    next: { ...customProxy },
    previous: customProxy,
    dependencies: {
      applyProxy,
      isRunning: () => true,
      restartServerWithProxy,
      stopServer,
    },
  })

  expect(result).toEqual({
    action: 'unchanged',
    proxyChanged: false,
    serverStatus: { running: true },
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

  const result = await saveAndApplyDesktopSettings(next, {
    getPort: () => 4141,
    isRunning: () => false,
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
      port: undefined,
      running: false,
    },
    success: false,
  })
})

test('settings apply returns the default runtime snapshot without a callback', async () => {
  const settings = createSettings(systemProxy)
  const result = await saveAndApplyDesktopSettings(settings, {
    getPort: () => 4510,
    isRunning: () => true,
    readSettings: async () => settings,
    writeSettings: async () => {},
  })

  expect(result).toEqual({
    action: 'unchanged',
    proxyChanged: false,
    serverStatus: { port: 4510, running: true },
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
        serverStatus: { error: 'proxy restart failed', running: false },
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
        serverStatus: { port: 4141, running: true },
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
