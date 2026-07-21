import type {
  DesktopProxySettings,
  ServerStatus,
  SettingsSaveResult,
} from '../src/types/ipc'

export interface ProxyRuntimeTransitionDependencies {
  applyProxy: (proxy: DesktopProxySettings) => Promise<void>
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
): SettingsSaveResult => ({
  action: 'stopped',
  error: message,
  proxyChanged,
  serverStatus: { error: message, running: false },
  success: false,
})

export const applyProxyRuntimeTransition = async ({
  dependencies,
  next,
  previous,
}: ProxyRuntimeTransitionInput): Promise<SettingsSaveResult> => {
  const proxyChanged = hasProxyPolicyChanged(previous, next)
  const wasRunning = dependencies.isRunning()
  if (!proxyChanged) {
    return {
      action: 'unchanged',
      proxyChanged: false,
      serverStatus: { running: wasRunning },
      success: true,
    }
  }

  if (wasRunning) {
    try {
      await dependencies.stopServer()
    } catch (error) {
      return stoppedFailure(errorMessage(error), true)
    }
    if (dependencies.isRunning()) {
      return stoppedFailure('Utility server did not stop safely', true)
    }
  }

  try {
    await dependencies.applyProxy(next)
  } catch (error) {
    return stoppedFailure(errorMessage(error), true)
  }

  if (!wasRunning) {
    return {
      action: 'applied',
      proxyChanged: true,
      serverStatus: { running: false },
      success: true,
    }
  }

  let serverStatus: ServerStatus
  try {
    serverStatus = await dependencies.restartServerWithProxy(next)
  } catch (error) {
    return stoppedFailure(errorMessage(error), true)
  }
  if (!serverStatus.running) {
    return stoppedFailure(
      serverStatus.error ?? 'Utility server failed to restart',
      true,
    )
  }

  return {
    action: 'restarted',
    proxyChanged: true,
    serverStatus,
    success: true,
  }
}
