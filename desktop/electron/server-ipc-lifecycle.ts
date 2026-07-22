import type {
  DesktopAuthMode,
  DesktopProxySettings,
  DesktopSettings,
  ServerStatus,
  ServerStopOutcome,
} from '../../shared-types'
import type { DesktopServerLaunchMode } from './server-start-args'
import { resolveDesktopServerStart } from './server-start-args'

interface DesktopServerIpcDependencies {
  getEffectiveProxySettings: (settings: DesktopSettings) => DesktopProxySettings
  getEnabledProviders: () => string[]
  getServerStatus: () => ServerStatus
  readSettings: () => Promise<DesktopSettings>
  readToken: () => Promise<string | null>
  reportServerError: (error: string) => ServerStatus
  startServer: (
    port: number,
    launchMode: DesktopServerLaunchMode,
    options: {
      proxy: DesktopProxySettings
      verbose: boolean
    },
  ) => Promise<ServerStatus>
  translateAuthRequired: () => Promise<string>
  writeSettings: (settings: DesktopSettings) => Promise<void>
}

export async function startDesktopServerFromIpc(
  port: number,
  authMode: DesktopAuthMode | undefined,
  dependencies: DesktopServerIpcDependencies,
  signal?: AbortSignal,
): Promise<ServerStatus> {
  if (signal?.aborted) return dependencies.getServerStatus()
  const token = authMode === 'provider' ? null : await dependencies.readToken()
  if (signal?.aborted) return dependencies.getServerStatus()
  const decision = resolveDesktopServerStart({
    authMode,
    enabledProviderCount: dependencies.getEnabledProviders().length,
    hasGitHubCredential: Boolean(token),
  })
  if (!decision.ok) {
    const error = await dependencies.translateAuthRequired()
    return signal?.aborted ?
        dependencies.getServerStatus()
      : dependencies.reportServerError(error)
  }

  const settings = await dependencies.readSettings()
  if (signal?.aborted) return dependencies.getServerStatus()
  await dependencies.writeSettings({ ...settings, lastPort: port })
  if (signal?.aborted) return dependencies.getServerStatus()
  return dependencies.startServer(port, decision.launchMode, {
    proxy: dependencies.getEffectiveProxySettings(settings),
    verbose: settings.verbose,
  })
}

interface DesktopLogoutDependencies {
  clearLogs: () => unknown
  clearToken: () => Promise<void>
  stopServer: () => Promise<ServerStopOutcome>
}

export class DesktopServerIpcCoordinator {
  private logoutFences = 0
  private lifecycle: Promise<void> = Promise.resolve()
  private shutdownFence = false
  private readonly starts = new Set<AbortController>()

  start<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    if (this.shutdownFence || this.logoutFences > 0) controller.abort()
    this.starts.add(controller)
    return this.enqueue(() => operation(controller.signal)).finally(() => {
      this.starts.delete(controller)
    })
  }

  logout(dependencies: DesktopLogoutDependencies): Promise<void> {
    this.logoutFences += 1
    const stop = this.requestStop(dependencies.stopServer)
    return this.enqueue(() =>
      logoutDesktopServer({
        ...dependencies,
        stopServer: () => stop,
      }),
    ).finally(() => {
      this.logoutFences -= 1
    })
  }

  stop(
    stopServer: () => Promise<ServerStopOutcome>,
  ): Promise<ServerStopOutcome> {
    const stop = this.requestStop(stopServer)
    return this.enqueue(() => stop)
  }

  stopForShutdown(
    stopServer: () => Promise<ServerStopOutcome>,
  ): Promise<ServerStopOutcome> {
    this.shutdownFence = true
    return this.stop(stopServer).then(
      (outcome) => {
        if (!outcome.stopped) this.shutdownFence = false
        return outcome
      },
      (error: unknown) => {
        this.shutdownFence = false
        throw error
      },
    )
  }

  private requestStop(
    stopServer: () => Promise<ServerStopOutcome>,
  ): Promise<ServerStopOutcome> {
    for (const controller of this.starts) controller.abort()
    let stop: Promise<ServerStopOutcome>
    try {
      stop = stopServer()
    } catch (error) {
      stop = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
    void stop.catch(() => undefined)
    return stop
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation)
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export const desktopServerIpcCoordinator = new DesktopServerIpcCoordinator()

export async function logoutDesktopServer(
  dependencies: DesktopLogoutDependencies,
): Promise<void> {
  const outcome = await dependencies.stopServer()
  if (!outcome.stopped) throw new Error(outcome.error)
  dependencies.clearLogs()
  await dependencies.clearToken()
}
