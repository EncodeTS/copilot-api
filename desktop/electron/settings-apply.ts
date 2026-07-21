import type { DesktopSettings, SettingsSaveResult } from '../src/types/ipc'
import { hasProxyPolicyChanged } from './proxy-runtime-transition'

export interface SettingsApplyDependencies {
  getPort: () => number
  isRunning: () => boolean
  onSettingsChange?: (
    settings: DesktopSettings,
    previous: DesktopSettings,
  ) => SettingsSaveResult | void | Promise<SettingsSaveResult | void>
  readSettings: () => Promise<DesktopSettings>
  writeSettings: (settings: DesktopSettings) => Promise<void>
}

export const saveAndApplyDesktopSettings = async (
  settings: DesktopSettings,
  dependencies: SettingsApplyDependencies,
): Promise<SettingsSaveResult> => {
  const previous = await dependencies.readSettings()
  await dependencies.writeSettings(settings)

  try {
    const result = await dependencies.onSettingsChange?.(settings, previous)
    const running = dependencies.isRunning()
    return (
      result ?? {
        action: 'unchanged',
        proxyChanged: false,
        serverStatus: {
          port: running ? dependencies.getPort() : undefined,
          running,
        },
        success: true,
      }
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to apply settings'
    const running = dependencies.isRunning()
    return {
      action: 'failed',
      error: message,
      proxyChanged: hasProxyPolicyChanged(previous.proxy, settings.proxy),
      serverStatus: {
        error: message,
        port: running ? dependencies.getPort() : undefined,
        running,
      },
      success: false,
    }
  }
}
