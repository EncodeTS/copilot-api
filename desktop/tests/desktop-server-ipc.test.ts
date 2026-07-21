import { describe, expect, test } from 'bun:test'

import {
  DesktopServerIpcCoordinator,
  logoutDesktopServer,
  startDesktopServerFromIpc,
} from '../electron/server-ipc-lifecycle'
import type {
  DesktopSettings,
  ServerStatus,
  ServerStopOutcome,
} from '../../shared-types'

const settings = {
  lastPort: 4141,
  proxy: { http_proxy: '', https_proxy: '', mode: 'system', no_proxy: '' },
  verbose: false,
} as DesktopSettings

function serverStatus(
  statusRevision: number,
  overrides: Partial<Omit<ServerStatus, 'statusRevision'>> = {},
): ServerStatus {
  return {
    owned: false,
    port: 4141,
    running: false,
    statusRevision,
    ...overrides,
  }
}

describe('Desktop server IPC lifecycle', () => {
  test('resolves the current credential on every start without forwarding it', async () => {
    let currentToken: string | null = 'first-current-token'
    let reads = 0
    const starts: unknown[][] = []
    const dependencies = {
      getEffectiveProxySettings: (value: DesktopSettings) => value.proxy,
      getEnabledProviders: () => ['provider-one'],
      getServerStatus: () => serverStatus(0),
      readSettings: () => Promise.resolve(settings),
      readToken: () => {
        reads += 1
        return Promise.resolve(currentToken)
      },
      reportServerError: (error: string) => serverStatus(1, { error }),
      startServer: (...args: unknown[]) => {
        starts.push(args)
        return Promise.resolve(
          serverStatus(starts.length, {
            owned: true,
            port: 4510,
            running: true,
          }),
        )
      },
      translateAuthRequired: () => Promise.resolve('auth required'),
      writeSettings: () => Promise.resolve(),
    }

    await startDesktopServerFromIpc(4510, 'copilot', dependencies)
    currentToken = 'rotated-current-token'
    await startDesktopServerFromIpc(4510, 'copilot', dependencies)

    expect(reads).toBe(2)
    expect(starts.map((args) => args.slice(0, 2))).toEqual([
      [4510, 'copilot'],
      [4510, 'copilot'],
    ])
    expect(JSON.stringify(starts)).not.toContain('current-token')
  })

  test('keeps provider-only explicit and fails closed for missing selected auth', async () => {
    let providers = ['provider-one']
    let token: string | null = 'ignored-provider-token'
    let currentStatus = serverStatus(0)
    const starts: unknown[][] = []
    const dependencies = {
      getEffectiveProxySettings: (value: DesktopSettings) => value.proxy,
      getEnabledProviders: () => providers,
      getServerStatus: () => currentStatus,
      readSettings: () => Promise.resolve(settings),
      readToken: () => Promise.resolve(token),
      reportServerError: (error: string) => {
        currentStatus = {
          ...currentStatus,
          error,
          statusRevision: currentStatus.statusRevision + 1,
        }
        return currentStatus
      },
      startServer: (...args: unknown[]) => {
        starts.push(args)
        currentStatus = serverStatus(currentStatus.statusRevision + 1, {
          owned: true,
          port: 4510,
          running: true,
        })
        return Promise.resolve(currentStatus)
      },
      translateAuthRequired: () => Promise.resolve('auth required'),
      writeSettings: () => Promise.resolve(),
    }

    await expect(
      startDesktopServerFromIpc(4510, 'provider', dependencies),
    ).resolves.toMatchObject({ running: true })
    expect(starts[0]?.slice(0, 2)).toEqual([4510, 'provider'])

    token = null
    await expect(
      startDesktopServerFromIpc(4510, 'copilot', dependencies),
    ).resolves.toEqual(
      serverStatus(2, {
        error: 'auth required',
        owned: true,
        port: 4510,
        running: true,
      }),
    )
    providers = []
    token = 'copilot-does-not-authorize-provider-mode'
    await expect(
      startDesktopServerFromIpc(4510, 'provider', dependencies),
    ).resolves.toEqual(
      serverStatus(3, {
        error: 'auth required',
        owned: true,
        port: 4510,
        running: true,
      }),
    )
    expect(starts).toHaveLength(1)
  })

  test('provider-only Start never reads the protected GitHub credential', async () => {
    let reads = 0
    await expect(
      startDesktopServerFromIpc(4510, 'provider', {
        getEffectiveProxySettings: (value) => value.proxy,
        getEnabledProviders: () => ['provider-one'],
        getServerStatus: () => serverStatus(0),
        readSettings: () => Promise.resolve(settings),
        readToken: () => {
          reads += 1
          return Promise.reject(new Error('credential store unavailable'))
        },
        reportServerError: (error) => serverStatus(1, { error }),
        startServer: () =>
          Promise.resolve(
            serverStatus(1, { owned: true, port: 4510, running: true }),
          ),
        translateAuthRequired: () => Promise.resolve('auth required'),
        writeSettings: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ running: true })
    expect(reads).toBe(0)
  })

  test('logout stops the child and clears logs before clearing credentials', async () => {
    const events: string[] = []

    await logoutDesktopServer({
      clearLogs: () => events.push('clear-logs'),
      clearToken: () => {
        events.push('clear-credential')
        return Promise.resolve()
      },
      stopServer: () => {
        events.push('stop-server')
        return Promise.resolve({ status: serverStatus(1), stopped: true })
      },
    })

    expect(events).toEqual(['stop-server', 'clear-logs', 'clear-credential'])
  })

  test('logout cancels a credential-resolving Start before clearing auth', async () => {
    const coordinator = new DesktopServerIpcCoordinator()
    let finishTokenRead: ((token: string | null) => void) | undefined
    let markTokenReadStarted: (() => void) | undefined
    const tokenReadStarted = new Promise<void>((resolve) => {
      markTokenReadStarted = resolve
    })
    const token = new Promise<string | null>((resolve) => {
      finishTokenRead = resolve
    })
    let status = serverStatus(0)
    let startCalls = 0
    const events: string[] = []
    const dependencies = {
      getEffectiveProxySettings: (value: DesktopSettings) => value.proxy,
      getEnabledProviders: () => [],
      getServerStatus: () => status,
      readSettings: () => Promise.resolve(settings),
      readToken: () => {
        markTokenReadStarted?.()
        return token
      },
      reportServerError: (error: string) => {
        status = serverStatus(status.statusRevision + 1, { error })
        return status
      },
      startServer: () => {
        startCalls += 1
        status = serverStatus(status.statusRevision + 1, {
          owned: true,
          running: true,
        })
        return Promise.resolve(status)
      },
      translateAuthRequired: () => Promise.resolve('auth required'),
      writeSettings: () => Promise.resolve(),
    }

    const start = coordinator.start((signal) =>
      startDesktopServerFromIpc(4510, 'copilot', dependencies, signal),
    )
    await tokenReadStarted
    const logout = coordinator.logout({
      clearLogs: () => events.push('clear-logs'),
      clearToken: () => {
        events.push('clear-credential')
        return Promise.resolve()
      },
      stopServer: () => {
        events.push('stop-server')
        status = serverStatus(status.statusRevision + 1)
        return Promise.resolve({ status, stopped: true })
      },
    })
    let lateStartAdmissions = 0
    const lateStart = coordinator.start(async (signal) => {
      if (!signal.aborted) lateStartAdmissions += 1
      return signal.aborted
    })
    finishTokenRead?.('credential-read-before-logout')

    await expect(start).resolves.toEqual(status)
    await expect(logout).resolves.toBeUndefined()
    await expect(lateStart).resolves.toBeTrue()
    expect(startCalls).toBe(0)
    expect(lateStartAdmissions).toBe(0)
    expect(events).toEqual(['stop-server', 'clear-logs', 'clear-credential'])

    await expect(
      coordinator.start(async (signal) => signal.aborted),
    ).resolves.toBeFalse()
  })

  test('Stop cancels an earlier IPC preflight before its queued outcome', async () => {
    const coordinator = new DesktopServerIpcCoordinator()
    let finishPreflight: (() => void) | undefined
    let markPreflightStarted: (() => void) | undefined
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve
    })
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const start = coordinator.start(async (signal) => {
      markPreflightStarted?.()
      await preflight
      return signal.aborted
    })
    await preflightStarted

    const stop = coordinator.stop(() =>
      Promise.resolve({ status: serverStatus(1), stopped: true }),
    )
    finishPreflight?.()

    await expect(start).resolves.toBeTrue()
    await expect(stop).resolves.toEqual({
      status: serverStatus(1),
      stopped: true,
    })
  })

  test('shutdown fencing rejects a Start that arrives while stop is pending', async () => {
    const coordinator = new DesktopServerIpcCoordinator()
    let finishStop: ((outcome: ServerStopOutcome) => void) | undefined
    const pendingStop = new Promise<ServerStopOutcome>((resolve) => {
      finishStop = resolve
    })
    const shutdown = coordinator.stopForShutdown(() => pendingStop)
    let admittedStarts = 0
    const start = coordinator.start(async (signal) => {
      if (!signal.aborted) admittedStarts += 1
      return signal.aborted
    })

    finishStop?.({ status: serverStatus(1), stopped: true })
    await expect(shutdown).resolves.toMatchObject({ stopped: true })
    await expect(start).resolves.toBeTrue()
    expect(admittedStarts).toBe(0)
  })

  test('failed shutdown attempts reopen Start admission', async () => {
    for (const failure of ['outcome', 'rejection'] as const) {
      const coordinator = new DesktopServerIpcCoordinator()
      const shutdown = coordinator.stopForShutdown(() =>
        failure === 'outcome' ?
          Promise.resolve({
            error: 'stop timeout',
            reason: 'timeout' as const,
            status: serverStatus(1, {
              error: 'stop timeout',
              owned: true,
              running: true,
            }),
            stopped: false as const,
          })
        : Promise.reject(new Error('stop IPC failed')),
      )
      if (failure === 'outcome') {
        await expect(shutdown).resolves.toMatchObject({ stopped: false })
      } else {
        await expect(shutdown).rejects.toThrow('stop IPC failed')
      }

      let admitted = false
      await coordinator.start(async (signal) => {
        admitted = !signal.aborted
      })
      expect(admitted).toBeTrue()
    }
  })

  test('logout preserves logs and credentials while child ownership remains', async () => {
    const events: string[] = []

    await expect(
      logoutDesktopServer({
        clearLogs: () => events.push('clear-logs'),
        clearToken: () => {
          events.push('clear-credential')
          return Promise.resolve()
        },
        stopServer: () => {
          events.push('stop-server')
          return Promise.resolve({
            error: 'Server process did not exit after graceful termination',
            reason: 'timeout',
            status: serverStatus(1, {
              error: 'Server process did not exit after graceful termination',
              owned: true,
              running: true,
            }),
            stopped: false,
          })
        },
      }),
    ).rejects.toThrow('did not exit')
    expect(events).toEqual(['stop-server'])
  })
})
