import type {
  DesktopProxySettings,
  ServerStatus,
  SettingsSaveResult,
} from '../src/types/ipc'

export interface ProxyRuntimeTransitionDependencies {
  applyProxy: (proxy: DesktopProxySettings) => Promise<void>
  getStatus: () => ServerStatus
  isRunning: () => boolean
  restartServerWithProxy: (proxy: DesktopProxySettings) => Promise<ServerStatus>
  stopServer: () => Promise<void>
}

export interface ProxyRuntimeTransitionInput {
  dependencies: ProxyRuntimeTransitionDependencies
  next: DesktopProxySettings
  previous: DesktopProxySettings
}

export const hasProxyPolicyChanged = (
  previous: DesktopProxySettings,
  next: DesktopProxySettings,
): boolean =>
  previous.mode !== next.mode
  || previous.http_proxy !== next.http_proxy
  || previous.https_proxy !== next.https_proxy
  || previous.no_proxy !== next.no_proxy

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to apply proxy settings'

const stoppedFailure = (
  message: string,
  proxyChanged: boolean,
  status: ServerStatus,
): SettingsSaveResult => ({
  action: 'stopped',
  error: message,
  proxyChanged,
  serverStatus: { ...status, error: message },
  success: false,
})

export const applyProxyRuntimeTransition = async ({
  dependencies,
  next,
  previous,
}: ProxyRuntimeTransitionInput): Promise<SettingsSaveResult> => {
  const proxyChanged = hasProxyPolicyChanged(previous, next)
  const initialStatus = dependencies.getStatus()
  const wasRunning = initialStatus.running
  if (!proxyChanged) {
    return {
      action: 'unchanged',
      proxyChanged: false,
      serverStatus: initialStatus,
      success: true,
    }
  }

  if (wasRunning) {
    try {
      await dependencies.stopServer()
    } catch (error) {
      return stoppedFailure(errorMessage(error), true, dependencies.getStatus())
    }
    if (dependencies.isRunning()) {
      return stoppedFailure(
        'Utility server did not stop safely',
        true,
        dependencies.getStatus(),
      )
    }
  }

  try {
    await dependencies.applyProxy(next)
  } catch (error) {
    return stoppedFailure(errorMessage(error), true, dependencies.getStatus())
  }

  if (!wasRunning) {
    return {
      action: 'applied',
      proxyChanged: true,
      serverStatus: dependencies.getStatus(),
      success: true,
    }
  }

  let serverStatus: ServerStatus
  try {
    serverStatus = await dependencies.restartServerWithProxy(next)
  } catch (error) {
    return stoppedFailure(errorMessage(error), true, dependencies.getStatus())
  }
  if (!serverStatus.running) {
    return stoppedFailure(
      serverStatus.error ?? 'Utility server failed to restart',
      true,
      serverStatus,
    )
  }

  return {
    action: 'restarted',
    proxyChanged: true,
    serverStatus,
    success: true,
  }
}
