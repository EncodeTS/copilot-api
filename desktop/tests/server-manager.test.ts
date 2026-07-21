import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import {
  createServerManager,
  type ManagedUtilityProcess,
  type ServerManagerDependencies,
} from '../electron/server-manager'
import type { ServerStatus } from '../../shared-types'

class FakeUtilityProcess extends EventEmitter implements ManagedUtilityProcess {
  readonly stderr = new PassThrough()
  readonly stdout = new PassThrough()
  killCalls = 0
  explicitExitListenerRemovals = 0
  private readonly exitOnKill: boolean

  constructor(exitOnKill = true) {
    super()
    this.exitOnKill = exitOnKill
    this.on('removeListener', (eventName) => {
      if (eventName === 'exit') this.explicitExitListenerRemovals += 1
    })
  }

  kill(): boolean {
    this.killCalls += 1
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

interface HarnessOptions {
  exitOnKill?: boolean
  fork?: ServerManagerDependencies['fork']
  logDrainTimeoutMs?: number
  probeServer?: ServerManagerDependencies['probeServer']
}

function createHarness(options: HarnessOptions = {}) {
  const processes: FakeUtilityProcess[] = []
  const forkCalls: Array<{
    args: string[]
    env: NodeJS.ProcessEnv | undefined
  }> = []
  const fork: ServerManagerDependencies['fork'] =
    options.fork
    ?? ((_modulePath, args, forkOptions) => {
      const proc = new FakeUtilityProcess(options.exitOnKill)
      processes.push(proc)
      forkCalls.push({ args, env: forkOptions.env })
      return proc
    })
  const manager = createServerManager({
    env: {
      ANTHROPIC_API_KEY: 'provider-secret',
      COPILOT_API_HOME: '/tmp/copilot-frp-14a-manager',
      GITHUB_TOKEN: 'github-secret-sentinel',
    },
    fork,
    getServerPath: () => '/app/server/main.js',
    isPortAvailable: () => Promise.resolve(true),
    logDrainTimeoutMs: options.logDrainTimeoutMs ?? 1,
    probeServer: options.probeServer ?? (() => Promise.resolve(true)),
    readinessAttempts: 2,
    readinessIntervalMs: 0,
    stopTimeoutMs: 2,
    translate: (key) => Promise.resolve(key),
  })

  return { forkCalls, manager, processes }
}

describe('Desktop ServerManager', () => {
  test('issues monotonic status revisions and reuses the stop transition for its event and response', async () => {
    const { manager } = createHarness()
    const initial = manager.getStatus()
    const statuses: ServerStatus[] = []
    manager.onStatusChange((status) => statuses.push(status))

    const started = await manager.start(4510, 'copilot')
    const stopped = await manager.stop()

    expect(initial.statusRevision).toBe(0)
    expect(started.statusRevision).toBeGreaterThan(initial.statusRevision)
    expect(stopped).toEqual({
      status: statuses[statuses.length - 1],
      stopped: true,
    })
    expect(stopped.status.statusRevision).toBeGreaterThan(
      started.statusRevision,
    )
    expect(manager.getStatus()).toEqual(stopped.status)
  })

  test('publishes one complete owned snapshot when stop times out', async () => {
    const { manager } = createHarness({ exitOnKill: false })
    const statuses: ServerStatus[] = []
    manager.onStatusChange((status) => statuses.push(status))
    const started = await manager.start(4510, 'copilot')

    const outcome = await manager.stop()

    expect(outcome).toEqual({
      error: 'server.stopTimeout',
      reason: 'timeout',
      status: {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: true,
        statusRevision: started.statusRevision + 1,
      },
      stopped: false,
    })
    expect(statuses.at(-1)).toEqual(outcome.status)
    expect(manager.getStatus()).toEqual(outcome.status)
  })

  test('starts Copilot from the protected file without exposing a token in argv or env', async () => {
    const { forkCalls, manager } = createHarness()

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      owned: true,
      port: 4510,
      running: true,
      statusRevision: 2,
    })

    expect(JSON.stringify(forkCalls)).not.toContain('github-secret-sentinel')
    expect(forkCalls[0]?.args).toEqual([
      'start',
      '--port',
      '4510',
      '--desktop-auth-mode',
      'copilot',
    ])
    expect(manager.isRunning()).toBe(true)
  })

  test('starts provider-only mode explicitly', async () => {
    const { forkCalls, manager } = createHarness()

    await manager.start(4510, 'provider')

    expect(forkCalls[0]?.args).toContain('provider')
  })

  test('turns a utility-process launch failure into a versioned status', async () => {
    const { manager } = createHarness({
      fork: () => {
        throw new Error('launch failed without credentials')
      },
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startFailed',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 1,
    })
    expect(manager.getStatus()).toEqual({
      error: 'server.startFailed',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 1,
    })
  })

  test('reports an early child exit and releases the process', async () => {
    const earlyProcess = new FakeUtilityProcess()
    const { manager } = createHarness({
      fork: () => {
        queueMicrotask(() => earlyProcess.emit('exit', 17))
        return earlyProcess
      },
      probeServer: () => Promise.resolve(false),
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startFailed',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(manager.isRunning()).toBe(false)
  })

  test('classifies a signal exit during readiness as startup failure, not timeout', async () => {
    const proc = new FakeUtilityProcess()
    const diagnostics: Array<{ key: string; code?: string | number }> = []
    const manager = createServerManager({
      env: {},
      fork: () => {
        queueMicrotask(() => proc.emit('exit', null))
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: () => Promise.resolve(false),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key, values) => {
        diagnostics.push({ key, code: values?.code })
        return Promise.resolve(`${key}:${String(values?.code)}`)
      },
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startFailed:signal',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(diagnostics).toEqual([{ key: 'server.startFailed', code: 'signal' }])
  })

  test('lets an exit during a successful readiness probe win the race', async () => {
    const proc = new FakeUtilityProcess()
    const { manager } = createHarness({
      fork: () => proc,
      probeServer: () => {
        proc.emit('exit', 19)
        return Promise.resolve(true)
      },
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startFailed',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(manager.isRunning()).toBe(false)
  })

  test('lets an exit between readiness resolution and commit win the race', async () => {
    const proc = new FakeUtilityProcess()
    const { manager } = createHarness({
      fork: () => proc,
      probeServer: () => {
        const ready = Promise.resolve(true)
        void ready.then(() => queueMicrotask(() => proc.emit('exit', 19)))
        return ready
      },
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startFailed',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(manager.isRunning()).toBe(false)
    expect(manager.getStatus().running).toBe(false)
  })

  test('installs one persistent exit listener immediately and shares its exit record with readiness', async () => {
    const proc = new FakeUtilityProcess()
    const { manager } = createHarness({
      fork: () => proc,
      probeServer: () => {
        expect(proc.listenerCount('exit')).toBe(1)
        return Promise.resolve(true)
      },
    })

    await manager.start(4510, 'copilot')

    expect(proc.listenerCount('exit')).toBe(1)
    expect(proc.explicitExitListenerRemovals).toBe(0)
  })

  test('an old child cannot publish its delayed exit status after a newer start', async () => {
    const processes: FakeUtilityProcess[] = []
    let resolveExitMessage: ((message: string) => void) | undefined
    const exitMessage = new Promise<string>((resolve) => {
      resolveExitMessage = resolve
    })
    const manager = createServerManager({
      env: {},
      fork: () => {
        const proc = new FakeUtilityProcess()
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key) =>
        key === 'server.processExit' ? exitMessage : Promise.resolve(key),
    })
    const statuses: Array<{
      error?: string
      owned: boolean
      running: boolean
    }> = []
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')

    processes[0]?.emit('exit', 23)
    await manager.start(4511, 'provider')
    resolveExitMessage?.('old child exited')
    await Promise.resolve()

    expect(manager.isRunning()).toBe(true)
    expect(statuses).toEqual([])
  })

  test('a new start attempt suppresses old async exit status before its port check finishes', async () => {
    const processes: FakeUtilityProcess[] = []
    let resolveExitMessage: ((message: string) => void) | undefined
    let resolveSecondPortCheck: ((available: boolean) => void) | undefined
    let markSecondPortCheckStarted: (() => void) | undefined
    const secondPortCheckStarted = new Promise<void>((resolve) => {
      markSecondPortCheckStarted = resolve
    })
    const exitMessage = new Promise<string>((resolve) => {
      resolveExitMessage = resolve
    })
    let portChecks = 0
    const manager = createServerManager({
      env: {},
      fork: () => {
        const proc = new FakeUtilityProcess()
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => {
        portChecks += 1
        if (portChecks === 1) return Promise.resolve(true)
        return new Promise((resolve) => {
          resolveSecondPortCheck = resolve
          markSecondPortCheckStarted?.()
        })
      },
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key) =>
        key === 'server.processExit' ? exitMessage : Promise.resolve(key),
    })
    const statuses: Array<{
      error?: string
      owned: boolean
      running: boolean
    }> = []
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')
    processes[0]?.emit('exit', 24)

    const nextStart = manager.start(4511, 'provider')
    await secondPortCheckStarted
    resolveExitMessage?.('old child exited')
    await Promise.resolve()
    expect(statuses).toEqual([])

    resolveSecondPortCheck?.(true)
    await nextStart
    expect(manager.isRunning()).toBe(true)
  })

  test('a queued start intent suppresses old async status before its operation runs', async () => {
    const processes: FakeUtilityProcess[] = []
    let resolveExitMessage: ((message: string) => void) | undefined
    const exitMessage = new Promise<string>((resolve) => {
      resolveExitMessage = resolve
    })
    const manager = createServerManager({
      env: {},
      fork: () => {
        const proc = new FakeUtilityProcess()
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key) =>
        key === 'server.processExit' ? exitMessage : Promise.resolve(key),
    })
    const statuses: Array<{
      error?: string
      owned: boolean
      running: boolean
    }> = []
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')
    processes[0]?.emit('exit', 25)

    const queuedStop = manager.stop()
    const nextStart = manager.start(4511, 'provider')
    resolveExitMessage?.('old child exited')
    await queuedStop
    await nextStart

    expect(statuses).toEqual([])
    expect(manager.isRunning()).toBe(true)
  })

  test('kills and releases a child after readiness timeout', async () => {
    const { manager, processes } = createHarness({
      probeServer: () => Promise.resolve(false),
    })

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.startTimeout',
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(processes[0]?.killCalls).toBe(1)
    expect(manager.isRunning()).toBe(false)
  })

  test('Stop aborts an in-flight readiness probe before the queued kill', async () => {
    let markProbeStarted: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const { manager, processes } = createHarness({
      probeServer: (_port, signal) => {
        markProbeStarted?.()
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(false), { once: true })
        })
      },
    })

    const start = manager.start(4510, 'copilot')
    await probeStarted
    const stop = manager.stop()

    await expect(start).resolves.toEqual({
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 2,
    })
    await expect(stop).resolves.toEqual({
      status: {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 2,
      },
      stopped: true,
    })
    expect(processes[0]?.killCalls).toBe(1)
  })

  test('readiness cleanup timeout reports owned-but-not-ready until late exit', async () => {
    const statuses: ServerStatus[] = []
    const { manager, processes } = createHarness({
      exitOnKill: false,
      probeServer: () => Promise.resolve(false),
    })
    manager.onStatusChange((status) => statuses.push(status))

    await expect(manager.start(4510, 'copilot')).resolves.toEqual({
      error: 'server.stopTimeout',
      owned: true,
      port: 4510,
      running: false,
      statusRevision: 2,
    })
    expect(manager.isRunning()).toBe(false)
    expect(manager.ownsProcess()).toBe(true)
    await expect(manager.start(4511, 'provider')).resolves.toEqual({
      error: 'server.stopTimeout',
      owned: true,
      port: 4510,
      running: false,
      statusRevision: 3,
    })
    expect(processes).toHaveLength(1)
    expect(statuses).toEqual([
      {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: false,
        statusRevision: 3,
      },
    ])

    processes[0]?.emit('exit', null)
    await Promise.resolve()
    expect(manager.ownsProcess()).toBe(false)
    expect(statuses).toEqual([
      {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: false,
        statusRevision: 3,
      },
      { owned: false, port: 4510, running: false, statusRevision: 4 },
    ])
  })

  test('keeps split UTF-8 log tails readable after cleanup times out', async () => {
    const proc = new FakeUtilityProcess(false)
    const encoded = Buffer.from('中')
    let wrotePrefix = false
    const manager = createServerManager({
      env: {},
      fork: () => proc,
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: () => {
        if (!wrotePrefix) {
          wrotePrefix = true
          proc.stdout.write(encoded.subarray(0, 2))
        }
        return Promise.resolve(false)
      },
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 1,
      translate: (key) => Promise.resolve(key),
    })

    await manager.start(4510, 'copilot')
    proc.stdout.write(encoded.subarray(2))
    proc.emit('exit', null)
    await Promise.resolve()

    expect(
      manager.getLogSnapshot().entries.map((entry) => entry.message),
    ).toEqual(['中'])
  })

  test('stops the current child before checking and starting a same-port restart', async () => {
    const events: string[] = []
    const processes: FakeUtilityProcess[] = []
    const manager = createServerManager({
      env: {},
      fork: () => {
        events.push('fork')
        const proc = new FakeUtilityProcess()
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => {
        events.push('check-port')
        return Promise.resolve(true)
      },
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key) => Promise.resolve(key),
    })

    await manager.start(4510, 'copilot')
    events.length = 0
    await manager.start(4510, 'copilot')

    expect(processes[0]?.killCalls).toBe(1)
    expect(events).toEqual(['check-port', 'fork'])
    expect(processes).toHaveLength(2)
  })

  test('treats a signal exit during stop as one final stopped status', async () => {
    const statuses: ServerStatus[] = []
    const proc = new FakeUtilityProcess(false)
    proc.kill = () => {
      proc.killCalls += 1
      queueMicrotask(() => proc.emit('exit', null))
      return true
    }
    const { manager } = createHarness({
      fork: () => proc,
    })
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')

    await expect(manager.stop()).resolves.toEqual({
      status: {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 3,
      },
      stopped: true,
    })

    expect(proc.killCalls).toBe(1)
    expect(manager.isRunning()).toBe(false)
    expect(statuses).toEqual([
      { owned: false, port: 4510, running: false, statusRevision: 3 },
    ])
  })

  test('keeps ownership fail-closed until a timed-out child exits, then publishes stopped once', async () => {
    const statuses: ServerStatus[] = []
    const { manager, processes } = createHarness({ exitOnKill: false })
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')

    await expect(manager.stop()).resolves.toEqual({
      error: 'server.stopTimeout',
      reason: 'timeout',
      status: {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: true,
        statusRevision: 3,
      },
      stopped: false,
    })
    expect(manager.isRunning()).toBe(true)
    await expect(manager.start(4511, 'provider')).resolves.toEqual({
      error: 'server.stopTimeout',
      owned: true,
      port: 4510,
      running: true,
      statusRevision: 4,
    })
    expect(processes).toHaveLength(1)
    expect(statuses).toEqual([
      {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: true,
        statusRevision: 3,
      },
      {
        error: 'server.stopTimeout',
        owned: true,
        port: 4510,
        running: true,
        statusRevision: 4,
      },
    ])

    processes[0]?.emit('exit', null)
    await Promise.resolve()
    expect(manager.isRunning()).toBe(false)
    expect(statuses.at(-1)).toEqual({
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 5,
    })
    processes[0]?.emit('exit', null)
    expect(statuses.at(-1)).toEqual({
      owned: false,
      port: 4510,
      running: false,
      statusRevision: 5,
    })
    await manager.start(4511, 'provider')
    expect(processes).toHaveLength(2)
  })

  test('does not reissue a stale runtime-exit translation above a newer status', async () => {
    let resolveExitMessage: ((message: string) => void) | undefined
    const exitMessage = new Promise<string>((resolve) => {
      resolveExitMessage = resolve
    })
    const processes: FakeUtilityProcess[] = []
    const guardedManager = createServerManager({
      env: {},
      fork: (_modulePath, _args, _options) => {
        const proc = new FakeUtilityProcess()
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      logDrainTimeoutMs: 1,
      stopTimeoutMs: 2,
      translate: (key) =>
        key === 'server.processExit' ? exitMessage : Promise.resolve(key),
    })
    const statuses: ServerStatus[] = []
    guardedManager.onStatusChange((status) => statuses.push(status))
    await guardedManager.start(4510, 'copilot')

    processes[0]?.emit('exit', 23)
    expect(guardedManager.getStatus().statusRevision).toBe(3)
    const authRequired = guardedManager.reportError('auth required')
    expect(authRequired.statusRevision).toBe(4)
    resolveExitMessage?.('stale process exit')
    await Promise.resolve()
    await Promise.resolve()

    expect(guardedManager.getStatus()).toEqual(authRequired)
    expect(statuses).toEqual([])
  })

  test('a nonzero runtime exit emits one stopped status', async () => {
    const statuses: ServerStatus[] = []
    const { manager, processes } = createHarness()
    manager.onStatusChange((status) => statuses.push(status))
    await manager.start(4510, 'copilot')

    processes[0]?.emit('exit', 23)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(manager.isRunning()).toBe(false)
    expect(statuses).toEqual([
      {
        error: 'server.processExit',
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 4,
      },
    ])
  })

  test('drains stdout data that arrives after the child exit event', async () => {
    const proc = new FakeUtilityProcess()
    const { manager } = createHarness({ fork: () => proc })
    const encoded = Buffer.from('退出尾部')
    await manager.start(4510, 'copilot')

    proc.emit('exit', 0)
    proc.stdout.write(encoded.subarray(0, 2))
    proc.stdout.end(encoded.subarray(2))
    await Promise.resolve()

    expect(
      manager.getLogSnapshot().entries.map((entry) => entry.message),
    ).toEqual(['退出尾部'])
  })

  test('force-flushes an unterminated exited stream after a bounded drain', async () => {
    const proc = new FakeUtilityProcess()
    const { manager } = createHarness({
      fork: () => proc,
      logDrainTimeoutMs: 1,
    })
    await manager.start(4510, 'copilot')

    proc.emit('exit', 0)
    proc.stdout.write(Buffer.from('bounded tail'))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(
      manager.getLogSnapshot().entries.map((entry) => entry.message),
    ).toEqual(['bounded tail'])
  })

  test('Stop completion drains old tail before a subsequent clear', async () => {
    const proc = new FakeUtilityProcess(false)
    proc.kill = () => {
      proc.killCalls += 1
      queueMicrotask(() => {
        proc.emit('exit', 0)
        setTimeout(() => {
          proc.stdout.end('tail-before-clear')
          proc.stderr.end()
        }, 5)
      })
      return true
    }
    const { manager } = createHarness({
      fork: () => proc,
      logDrainTimeoutMs: 20,
    })
    await manager.start(4510, 'copilot')

    await manager.stop()
    expect(
      manager.getLogSnapshot().entries.map((entry) => entry.message),
    ).toEqual(['tail-before-clear'])
    expect(manager.clearLogs().entries).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(manager.getLogSnapshot().entries).toEqual([])
  })

  test('direct clear retires an active exited-stream drain', async () => {
    const proc = new FakeUtilityProcess(false)
    const { manager } = createHarness({
      fork: () => proc,
      logDrainTimeoutMs: 20,
    })
    await manager.start(4510, 'copilot')

    proc.emit('exit', 0)
    expect(manager.clearLogs().entries).toEqual([])
    proc.stdout.end('tail-after-clear')
    proc.stderr.end()
    await Promise.resolve()

    expect(manager.getLogSnapshot().entries).toEqual([])
  })

  test('Restart drains the old child before clearing the replacement feed', async () => {
    const processes: FakeUtilityProcess[] = []
    const manager = createServerManager({
      env: {},
      fork: () => {
        const proc = new FakeUtilityProcess(false)
        if (processes.length === 0) {
          proc.kill = () => {
            proc.killCalls += 1
            queueMicrotask(() => {
              proc.emit('exit', 0)
              setTimeout(() => {
                proc.stdout.end('old-tail-before-restart')
                proc.stderr.end()
              }, 5)
            })
            return true
          }
        }
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      logDrainTimeoutMs: 20,
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      stopTimeoutMs: 30,
      translate: (key) => Promise.resolve(key),
    })
    await manager.start(4510, 'copilot')

    await manager.start(4511, 'provider')

    expect(processes).toHaveLength(2)
    expect(manager.getStatus()).toMatchObject({ port: 4511, running: true })
    expect(manager.getLogSnapshot().entries).toEqual([])
  })

  test('Restart rechecks a drain barrier replaced while its operation yields', async () => {
    const processes: FakeUtilityProcess[] = []
    const manager = createServerManager({
      env: {},
      fork: () => {
        const proc = new FakeUtilityProcess(false)
        processes.push(proc)
        return proc
      },
      getServerPath: () => '/app/server/main.js',
      isPortAvailable: () => Promise.resolve(true),
      logDrainTimeoutMs: 20,
      probeServer: () => Promise.resolve(true),
      readinessAttempts: 1,
      readinessIntervalMs: 0,
      stopTimeoutMs: 30,
      translate: (key) => Promise.resolve(key),
    })
    await manager.start(4510, 'copilot')

    const restart = manager.start(4511, 'provider')
    queueMicrotask(() => {
      const oldProcess = processes[0]
      oldProcess?.emit('exit', 0)
      setTimeout(() => {
        oldProcess?.stdout.end('old-tail-from-yield-race')
        oldProcess?.stderr.end()
      }, 5)
    })
    await restart

    expect(processes).toHaveLength(2)
    expect(manager.getStatus()).toMatchObject({ port: 4511, running: true })
    expect(manager.getLogSnapshot().entries).toEqual([])
  })
})
