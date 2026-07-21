import net from 'node:net'
import path from 'node:path'

import type {
  DesktopProxySettings,
  LogFeedBatch,
  LogFeedSnapshot,
  ServerStatus,
  ServerStopOutcome,
} from '../src/types/ipc'
import { applyDesktopProxySettingsToEnv } from './electron-proxy-config'
import { createLogStream, LogFeed } from './log-feed'
import type {
  ResolvedServerCredentials,
  ServerCredentialMode,
} from './server-credentials'
import {
  buildServerEnvironment,
  buildServerStartArgs,
  type DesktopServerLaunchMode,
} from './server-start-args'
import { buildServerLoopbackUrl } from './server-loopback'

interface ManagedLogStream {
  on(event: 'data', listener: (data: Buffer) => void): unknown
  once(event: 'close' | 'end', listener: () => void): unknown
}

export interface ManagedUtilityProcess {
  kill(): boolean
  on(event: 'exit', listener: (code: number | null) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  stderr?: ManagedLogStream | null
  stdout?: ManagedLogStream | null
}

interface ManagedForkOptions {
  env?: NodeJS.ProcessEnv
  serviceName?: string
  stdio?: 'ignore' | 'inherit' | 'pipe'
}

export interface ServerManagerDependencies {
  env?: NodeJS.ProcessEnv
  fork: (
    modulePath: string,
    args: string[],
    options: ManagedForkOptions,
  ) => ManagedUtilityProcess
  getServerPath: () => string
  isPortAvailable: (port: number) => Promise<boolean>
  logDrainTimeoutMs?: number
  probeServer: (port: number, signal: AbortSignal) => Promise<boolean>
  readinessAttempts?: number
  readinessIntervalMs?: number
  stopTimeoutMs?: number
  translate: (
    key:
      | 'server.portInUse'
      | 'server.processExit'
      | 'server.startFailed'
      | 'server.startTimeout'
      | 'server.stopTimeout',
    values?: Record<string, string | number>,
  ) => Promise<string>
}

interface ServerStartOptions {
  proxy?: DesktopProxySettings
  verbose?: boolean
}

export interface ServerCredentialContext {
  generation: number
  mode: ServerCredentialMode
}

interface ServerRestartContext {
  credentialGeneration: number
  credentialMode: ServerCredentialMode
  nonce: number
  options: ServerStartOptions
  port: number
}

interface PreparedServerCredentials {
  context: ServerCredentialContext
}

interface ServerRestartGuard {
  invalidateContext: () => void
  isContextCurrent: () => boolean
  prepareForFork: () => Promise<PreparedServerCredentials | null>
  validateBeforeCommit: () => Promise<boolean>
}

interface StartResult {
  cancelled?: boolean
  exit?: ManagedProcessExit
  ok: boolean
}

type ManagedProcessExit = { code: number; kind: 'code' } | { kind: 'signal' }

interface ManagedProcessRecord {
  exit: ManagedProcessExit | null
  exited: boolean
  exitObservedPromise: Promise<void>
  exitPromise: Promise<void>
  generation: number
  process: ManagedUtilityProcess
  ready: boolean
  resolveExitObserved: () => void
  resolveExit: () => void
  stderr: ReturnType<typeof createLogStream>
  stdout: ReturnType<typeof createLogStream>
  stopping: boolean
  publishStoppedOnExit: boolean
}

const LOG_CAPACITY = 2000
const LOG_DRAIN_TIMEOUT_MS = 250
const READINESS_ATTEMPTS = 20
const READINESS_INTERVAL_MS = 500
const STOP_TIMEOUT_MS = 5000

const cloneProxySettings = (
  proxy: DesktopProxySettings | undefined,
): DesktopProxySettings | undefined => (proxy ? { ...proxy } : undefined)

function sleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(completed)
    }
    const abort = () => finish(false)
    const timeout = setTimeout(() => finish(true), delayMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class ServerManager {
  private readonly dependencies: Required<ServerManagerDependencies>
  private drainBarrier: Promise<void> = Promise.resolve()
  private readonly drainingStreams = new Set<
    ReturnType<typeof createLogStream>
  >()
  private readonly logFeed = new LogFeed(LOG_CAPACITY)
  private currentPort = 4141
  private generation = 0
  private lastPublishedStatusRevision = -1
  private lifecycle: Promise<void> = Promise.resolve()
  private process: ManagedProcessRecord | null = null
  private restartContext: ServerRestartContext | null = null
  private restartContextNonce = 0
  private readonly starts = new Set<AbortController>()
  private status: ServerStatus = {
    owned: false,
    port: this.currentPort,
    running: false,
    statusRevision: 0,
  }
  private statusCallback: ((status: ServerStatus) => void) | null = null

  constructor(dependencies: ServerManagerDependencies) {
    this.dependencies = {
      ...dependencies,
      env: dependencies.env ?? process.env,
      logDrainTimeoutMs: dependencies.logDrainTimeoutMs ?? LOG_DRAIN_TIMEOUT_MS,
      readinessAttempts: dependencies.readinessAttempts ?? READINESS_ATTEMPTS,
      readinessIntervalMs:
        dependencies.readinessIntervalMs ?? READINESS_INTERVAL_MS,
      stopTimeoutMs: dependencies.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    }
  }

  start(
    port: number,
    launchMode: DesktopServerLaunchMode,
    options: ServerStartOptions = {},
    credentialContext?: ServerCredentialContext,
    restartGuard?: ServerRestartGuard,
  ): Promise<ServerStatus> {
    if (!restartGuard) this.clearRestartContext()
    this.generation += 1
    const generation = this.generation
    const controller = new AbortController()
    this.starts.add(controller)
    return this.enqueue(() =>
      this.startUnlocked(
        port,
        launchMode,
        options,
        credentialContext,
        restartGuard,
        generation,
        controller.signal,
      ),
    ).finally(() => {
      this.starts.delete(controller)
    })
  }

  stop(): Promise<ServerStopOutcome> {
    for (const controller of this.starts) controller.abort()
    return this.enqueue(() => this.stopUnlocked())
  }

  startResolvingCredentials(
    port: number,
    launchMode: DesktopServerLaunchMode,
    options: ServerStartOptions,
    resolveCredentials: (
      preferredMode: ServerCredentialMode,
    ) => Promise<ResolvedServerCredentials | null>,
  ): Promise<ServerStatus> {
    this.clearRestartContext()
    const admissionNonce = this.restartContextNonce
    let admittedCredentials: ServerCredentialContext | null = null
    return this.start(port, launchMode, options, undefined, {
      invalidateContext: () => this.clearRestartContext(),
      isContextCurrent: () => this.restartContextNonce === admissionNonce,
      prepareForFork: async () => {
        const credentials = await resolveCredentials(launchMode)
        if (
          !credentials
          || credentials.mode !== launchMode
          || this.restartContextNonce !== admissionNonce
        ) {
          return null
        }
        admittedCredentials = {
          generation: credentials.generation,
          mode: credentials.mode,
        }
        return { context: admittedCredentials }
      },
      validateBeforeCommit: async () => {
        if (!admittedCredentials) return false
        const currentCredentials = await resolveCredentials(launchMode)
        return Boolean(
          currentCredentials
          && currentCredentials.generation === admittedCredentials.generation
          && currentCredentials.mode === admittedCredentials.mode
          && this.restartContextNonce === admissionNonce,
        )
      },
    })
  }

  clearRestartContext(): void {
    this.restartContextNonce += 1
    this.restartContext = null
  }

  getRestartContextDiagnostics(): {
    generation: number
    mode: ServerCredentialMode
    port: number
  } | null {
    return this.restartContext ?
        {
          generation: this.restartContext.credentialGeneration,
          mode: this.restartContext.credentialMode,
          port: this.restartContext.port,
        }
      : null
  }

  async restartWithProxy(
    proxy: DesktopProxySettings,
    resolveCredentials: (
      preferredMode: ServerCredentialMode,
    ) => Promise<ResolvedServerCredentials | null>,
  ): Promise<ServerStatus> {
    if (this.ownsProcess()) {
      return {
        ...this.getStatus(),
        error: 'Utility server must be stopped before applying a proxy restart',
      }
    }
    if (!this.restartContext) {
      return {
        ...this.getStatus(),
        error: 'No safe utility server restart context is available',
      }
    }

    const contextSnapshot = {
      ...this.restartContext,
      options: {
        ...this.restartContext.options,
        proxy: cloneProxySettings(this.restartContext.options.proxy),
      },
    }
    const credentials = await resolveCredentials(contextSnapshot.credentialMode)
    if (!this.restartContextMatches(contextSnapshot)) {
      return {
        ...this.getStatus(),
        error: 'Utility server restart context was invalidated',
      }
    }
    if (!credentials || credentials.mode !== contextSnapshot.credentialMode) {
      this.clearRestartContext()
      return {
        ...this.getStatus(),
        error:
          'Current credentials are unavailable; utility server remains stopped',
      }
    }

    return this.start(
      contextSnapshot.port,
      credentials.mode,
      {
        ...contextSnapshot.options,
        proxy: cloneProxySettings(proxy),
      },
      { generation: credentials.generation, mode: credentials.mode },
      {
        invalidateContext: () => this.clearRestartContext(),
        isContextCurrent: () => this.restartContextMatches(contextSnapshot),
        prepareForFork: async () => {
          const currentCredentials = await resolveCredentials(
            contextSnapshot.credentialMode,
          )
          if (
            !currentCredentials
            || currentCredentials.generation !== credentials.generation
            || currentCredentials.mode !== credentials.mode
            || !this.restartContextMatches(contextSnapshot)
          ) {
            return null
          }
          return {
            context: {
              generation: currentCredentials.generation,
              mode: currentCredentials.mode,
            },
          }
        },
        validateBeforeCommit: async () => {
          const currentCredentials = await resolveCredentials(
            contextSnapshot.credentialMode,
          )
          return Boolean(
            currentCredentials
            && currentCredentials.generation === credentials.generation
            && currentCredentials.mode === credentials.mode
            && this.restartContextMatches(contextSnapshot),
          )
        },
      },
    )
  }

  reportError(error: string): ServerStatus {
    return this.transitionStatus({ ...this.status, error }, false)
  }

  clearCallbacks(): void {
    this.statusCallback = null
    this.logFeed.clearSubscribers()
  }

  clearLogs(): LogFeedSnapshot {
    for (const stream of this.drainingStreams) stream.flush()
    return this.logFeed.clear()
  }

  getLogSnapshot(): LogFeedSnapshot {
    return this.logFeed.snapshot()
  }

  getPort(): number {
    return this.currentPort
  }

  isRunning(): boolean {
    return this.process?.ready ?? false
  }

  ownsProcess(): boolean {
    return this.process !== null
  }

  getStatus(): ServerStatus {
    return { ...this.status }
  }

  onStatusChange(callback: (status: ServerStatus) => void): void {
    this.statusCallback = callback
  }

  subscribeLogs(receive: (batch: LogFeedBatch) => void) {
    return this.logFeed.subscribe(receive)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async startUnlocked(
    port: number,
    launchMode: DesktopServerLaunchMode,
    options: ServerStartOptions,
    credentialContext: ServerCredentialContext | undefined,
    restartGuard: ServerRestartGuard | undefined,
    generation: number,
    signal: AbortSignal,
  ): Promise<ServerStatus> {
    await this.waitForStableDrainBarrier()
    if (signal.aborted) return this.getStatus()
    if (this.process) {
      const stopOutcome = await this.stopUnlocked()
      if (!stopOutcome.stopped) {
        return stopOutcome.status
      }
    }
    if (signal.aborted) return this.getStatus()

    const available = await this.dependencies.isPortAvailable(port)
    if (signal.aborted) return this.getStatus()
    if (!available) {
      return this.transitionStatus(
        {
          owned: false,
          port: this.currentPort,
          running: false,
          error: await this.dependencies.translate('server.portInUse', {
            port,
          }),
        },
        false,
      )
    }

    this.currentPort = port
    this.logFeed.clear()

    const env = buildServerEnvironment(this.dependencies.env)
    let proxyEnabled: boolean
    try {
      proxyEnabled =
        options.proxy ?
          applyDesktopProxySettingsToEnv(env, options.proxy)
        : false
    } catch (error) {
      return this.transitionStatus(
        {
          error:
            error instanceof Error ? error.message : 'Invalid proxy settings',
          owned: false,
          port,
          running: false,
        },
        false,
      )
    }

    let effectiveLaunchMode = launchMode
    let effectiveCredentialContext = credentialContext
    if (restartGuard) {
      const preparedCredentials = await restartGuard.prepareForFork()
      if (signal.aborted) return this.getStatus()
      if (!preparedCredentials || !restartGuard.isContextCurrent()) {
        return this.transitionStatus(
          {
            error: 'Credential state changed before utility server restart',
            owned: false,
            port,
            running: false,
          },
          false,
        )
      }
      effectiveCredentialContext = preparedCredentials.context
      effectiveLaunchMode = preparedCredentials.context.mode
    }

    const args = buildServerStartArgs(port, effectiveLaunchMode)
    if (proxyEnabled) args.push('--proxy-env')
    if (options.verbose) args.push('--verbose')

    const stdout = createLogStream(this.logFeed)
    const stderr = createLogStream(this.logFeed)
    if (signal.aborted) return this.getStatus()
    let proc: ManagedUtilityProcess
    try {
      proc = this.dependencies.fork(this.dependencies.getServerPath(), args, {
        env,
        stdio: 'pipe',
        serviceName: 'copilot-api-server',
      })
    } catch {
      return this.transitionStatus(
        {
          error: await this.dependencies.translate('server.startFailed', {
            code: 'launch',
          }),
          owned: false,
          port,
          running: false,
        },
        false,
      )
    }
    let resolveExit: () => void = () => undefined
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let resolveExitObserved: () => void = () => undefined
    const exitObservedPromise = new Promise<void>((resolve) => {
      resolveExitObserved = resolve
    })
    const record: ManagedProcessRecord = {
      exited: false,
      exit: null,
      exitObservedPromise,
      exitPromise,
      generation,
      process: proc,
      ready: false,
      resolveExitObserved,
      resolveExit,
      stderr,
      stdout,
      stopping: false,
      publishStoppedOnExit: false,
    }
    this.process = record
    this.transitionStatus({ owned: true, port, running: false }, false)
    proc.once('exit', (code) => this.handleProcessExit(record, code))

    proc.stdout?.on('data', stdout.handleData)
    proc.stdout?.once('end', stdout.flush)
    proc.stdout?.once('close', stdout.flush)
    proc.stderr?.on('data', stderr.handleData)
    proc.stderr?.once('end', stderr.flush)
    proc.stderr?.once('close', stderr.flush)

    let startResult = await this.waitForServer(port, record, signal)
    if (startResult.ok) {
      if (signal.aborted || (!record.exited && this.process !== record)) {
        startResult = { cancelled: true, ok: false }
      } else if (record.exited) {
        startResult = { exit: record.exit ?? undefined, ok: false }
      }
    }
    if (!startResult.ok) {
      if (!record.exited) {
        record.stopping = true
        const stopOutcome = await this.terminateProcess(record)
        if (!stopOutcome.stopped) {
          record.publishStoppedOnExit = true
          return stopOutcome.status
        }
      }
      if (record.exited) await record.exitPromise
      if (this.process === record) this.process = null
      if (startResult.cancelled) return this.getStatus()
      const error =
        startResult.exit ?
          await this.dependencies.translate('server.startFailed', {
            code: this.formatExitDiagnostic(startResult.exit),
          })
        : await this.dependencies.translate('server.startTimeout', { port })
      return this.transitionStatus(
        { error, owned: false, port, running: false },
        false,
      )
    }

    if (restartGuard) {
      let credentialsStillCurrent = false
      try {
        credentialsStillCurrent = await restartGuard.validateBeforeCommit()
      } catch {
        credentialsStillCurrent = false
      }
      if (!credentialsStillCurrent || !restartGuard.isContextCurrent()) {
        restartGuard.invalidateContext()
        record.stopping = true
        record.publishStoppedOnExit = true
        await this.terminateProcess(record)
        return this.reportError(
          'Credential state changed while utility server was starting',
        )
      }
    }

    record.ready = true
    this.commitRestartContext(port, options, effectiveCredentialContext)
    return this.transitionStatus({ owned: true, port, running: true }, false)
  }

  private async stopUnlocked(): Promise<ServerStopOutcome> {
    const record = this.process
    if (!record) {
      await this.waitForStableDrainBarrier()
      return { status: this.getStatus(), stopped: true }
    }
    record.stopping = true
    record.publishStoppedOnExit = true
    return this.terminateProcess(record)
  }

  private async terminateProcess(
    record: ManagedProcessRecord,
  ): Promise<ServerStopOutcome> {
    if (record.exited) {
      await record.exitPromise
      return { status: this.getStatus(), stopped: true }
    }
    record.process.kill()
    if (
      await this.waitForProcessExit(record, this.dependencies.stopTimeoutMs)
    ) {
      await record.exitPromise
      return { status: this.getStatus(), stopped: true }
    }
    const error = await this.dependencies.translate('server.stopTimeout')
    if (record.exited) {
      await record.exitPromise
      return { status: this.getStatus(), stopped: true }
    }
    if (this.process !== record) {
      await this.waitForStableDrainBarrier()
      return { status: this.getStatus(), stopped: true }
    }
    const status = this.transitionStatus(
      {
        error,
        owned: true,
        port: this.currentPort,
        running: record.ready,
      },
      record.publishStoppedOnExit,
    )
    return {
      error,
      reason: 'timeout',
      status,
      stopped: false,
    }
  }

  private waitForProcessExit(
    record: ManagedProcessRecord,
    timeoutMs: number,
  ): Promise<boolean> {
    if (record.exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (exited: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(exited)
      }
      const timeout = setTimeout(() => finish(false), timeoutMs)

      void record.exitObservedPromise.then(() => finish(true))
    })
  }

  private handleProcessExit(
    record: ManagedProcessRecord,
    code: number | null,
  ): void {
    const exit: ManagedProcessExit =
      code === null ? { kind: 'signal' } : { code, kind: 'code' }
    record.exited = true
    record.exit = exit
    record.resolveExitObserved()
    const drain = Promise.all([
      this.drainLogStream(record.stdout),
      this.drainLogStream(record.stderr),
    ]).then(() => record.resolveExit())
    this.drainBarrier = Promise.all([this.drainBarrier, drain]).then(
      () => undefined,
    )

    if (record.stopping) {
      const wasCurrent = this.process === record
      if (wasCurrent) this.process = null
      if (wasCurrent) {
        this.transitionStatus(
          { owned: false, port: this.currentPort, running: false },
          record.publishStoppedOnExit,
        )
      }
      return
    }

    if (this.process !== record) return
    this.process = null
    const stoppedStatus = this.transitionStatus(
      { owned: false, port: this.currentPort, running: false },
      false,
    )
    if (this.generation !== record.generation || !record.ready) {
      return
    }

    if (code === 0) {
      this.publishStatus(stoppedStatus)
      return
    }
    const generation = record.generation
    const stoppedRevision = stoppedStatus.statusRevision
    void this.dependencies
      .translate('server.processExit', {
        code: this.formatExitDiagnostic(exit),
      })
      .then((error) => {
        if (
          this.generation !== generation
          || this.process !== null
          || this.status.statusRevision !== stoppedRevision
        ) {
          return
        }
        this.transitionStatus(
          { error, owned: false, port: this.currentPort, running: false },
          true,
        )
      })
  }

  private async waitForServer(
    port: number,
    record: ManagedProcessRecord,
    signal: AbortSignal,
  ): Promise<StartResult> {
    for (
      let attempt = 0;
      attempt < this.dependencies.readinessAttempts;
      attempt += 1
    ) {
      if (!(await sleep(this.dependencies.readinessIntervalMs, signal))) {
        return { cancelled: true, ok: false }
      }
      if (record.exited) return { exit: record.exit ?? undefined, ok: false }
      const ready = await this.dependencies.probeServer(port, signal)
      if (signal.aborted) return { cancelled: true, ok: false }
      if (record.exited) return { exit: record.exit ?? undefined, ok: false }
      if (ready) return { ok: true }
    }
    return { ok: false }
  }

  private formatExitDiagnostic(exit: ManagedProcessExit): string | number {
    return exit.kind === 'signal' ? 'signal' : exit.code
  }

  private async waitForStableDrainBarrier(): Promise<void> {
    while (true) {
      const barrier = this.drainBarrier
      await barrier
      if (barrier === this.drainBarrier) return
    }
  }

  private drainLogStream(
    stream: ReturnType<typeof createLogStream>,
  ): Promise<void> {
    if (stream.isFlushed()) return stream.drained
    this.drainingStreams.add(stream)
    const timeout = setTimeout(
      stream.flush,
      this.dependencies.logDrainTimeoutMs,
    )
    timeout.unref?.()
    return stream.drained.finally(() => {
      clearTimeout(timeout)
      this.drainingStreams.delete(stream)
    })
  }

  private commitRestartContext(
    port: number,
    options: ServerStartOptions,
    credentials: ServerCredentialContext | undefined,
  ): void {
    this.restartContextNonce += 1
    this.restartContext =
      credentials ?
        {
          credentialGeneration: credentials.generation,
          credentialMode: credentials.mode,
          nonce: this.restartContextNonce,
          options: {
            ...options,
            proxy: cloneProxySettings(options.proxy),
          },
          port,
        }
      : null
  }

  private restartContextMatches(snapshot: ServerRestartContext): boolean {
    return (
      this.restartContext?.nonce === snapshot.nonce
      && this.restartContext.credentialGeneration
        === snapshot.credentialGeneration
    )
  }

  private transitionStatus(
    status: Omit<ServerStatus, 'statusRevision'>,
    publish: boolean,
  ): ServerStatus {
    const nextStatus = {
      ...status,
      statusRevision: this.status.statusRevision + 1,
    }
    this.status = nextStatus
    if (publish) this.publishStatus(nextStatus)
    return { ...nextStatus }
  }

  private publishStatus(status: ServerStatus): void {
    if (status.statusRevision <= this.lastPublishedStatusRevision) return
    this.lastPublishedStatusRevision = status.statusRevision
    this.statusCallback?.({ ...status })
  }
}

let defaultManager: ServerManager | null = null
let defaultManagerPromise: Promise<ServerManager> | null = null

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '0.0.0.0')
  })
}

interface ManagedElectronApp {
  getAppPath(): string
  isPackaged: boolean
}

function getServerPath(app: ManagedElectronApp): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export function getServerReadinessUrl(port: number): string {
  return buildServerLoopbackUrl(port)
}

async function probeServer(
  port: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(getServerReadinessUrl(port), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

async function createSystemServerManager(): Promise<ServerManager> {
  const [{ app, utilityProcess }, { tMain }] = await Promise.all([
    import('electron'),
    import('./i18n'),
  ])
  return new ServerManager({
    fork: (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options),
    getServerPath: () => getServerPath(app),
    isPortAvailable: checkPortAvailable,
    probeServer,
    translate: tMain,
  })
}

async function getDefaultManager(): Promise<ServerManager> {
  if (defaultManager) return defaultManager
  defaultManagerPromise ??= createSystemServerManager()
  const manager = await defaultManagerPromise
  defaultManager ??= manager
  return defaultManager
}

export function createServerManager(
  dependencies: ServerManagerDependencies,
): ServerManager {
  return new ServerManager(dependencies)
}

export function registerDefaultServerManager(manager: ServerManager): void {
  defaultManager ??= manager
}

export async function startServer(
  port: number,
  token: string | null,
  options: ServerStartOptions = {},
  credentialContext?: ServerCredentialContext,
  restartGuard?: ServerRestartGuard,
): Promise<ServerStatus> {
  const launchMode = credentialContext?.mode ?? (token ? 'copilot' : 'provider')
  return (await getDefaultManager()).start(
    port,
    launchMode,
    options,
    credentialContext,
    restartGuard,
  )
}

export function startServerResolvingCredentials(
  port: number,
  launchMode: DesktopServerLaunchMode,
  options: ServerStartOptions,
  resolveCredentials: (
    preferredMode: ServerCredentialMode,
  ) => Promise<ResolvedServerCredentials | null>,
): Promise<ServerStatus> {
  if (defaultManager) {
    return defaultManager.startResolvingCredentials(
      port,
      launchMode,
      options,
      resolveCredentials,
    )
  }
  return getDefaultManager().then((manager) =>
    manager.startResolvingCredentials(
      port,
      launchMode,
      options,
      resolveCredentials,
    ),
  )
}

export async function stopServer(): Promise<void> {
  if (!defaultManager && !defaultManagerPromise) return
  const outcome = await (await getDefaultManager()).stop()
  if (!outcome.stopped) throw new Error(outcome.error)
}

export async function restartServerWithProxy(
  proxy: DesktopProxySettings,
  resolveCredentials: (
    preferredMode: ServerCredentialMode,
  ) => Promise<ResolvedServerCredentials | null>,
): Promise<ServerStatus> {
  return (await getDefaultManager()).restartWithProxy(proxy, resolveCredentials)
}

export function clearServerRestartContext(): void {
  defaultManager?.clearRestartContext()
}

export function getServerRestartContextDiagnostics(): {
  generation: number
  mode: ServerCredentialMode
  port: number
} | null {
  return defaultManager?.getRestartContextDiagnostics() ?? null
}

export function isRunning(): boolean {
  return defaultManager?.isRunning() ?? false
}

export function getStatus(): ServerStatus {
  return (
    defaultManager?.getStatus() ?? {
      owned: false,
      port: 4141,
      running: false,
      statusRevision: 0,
    }
  )
}
