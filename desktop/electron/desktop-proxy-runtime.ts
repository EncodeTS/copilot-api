import type { DesktopProxySettings, SettingsSaveResult } from '../src/types/ipc'
import { applyElectronProxy } from './electron-proxy'
import { applyProxyRuntimeTransition } from './proxy-runtime-transition'

export const applyDesktopProxyRuntimeTransition = async (
  previous: DesktopProxySettings,
  next: DesktopProxySettings,
): Promise<SettingsSaveResult> => {
  const [serverManager, serverCredentials] = await Promise.all([
    import('./server-manager'),
    import('./server-credentials'),
  ])
  return applyProxyRuntimeTransition({
    dependencies: {
      applyProxy: applyElectronProxy,
      getStatus: serverManager.getStatus,
      isRunning: serverManager.isRunning,
      restartServerWithProxy: (proxy) =>
        serverManager.restartServerWithProxy(
          proxy,
          serverCredentials.resolveDesktopServerCredentials,
        ),
      stopServer: serverManager.stopServer,
    },
    next,
    previous,
  })
}
