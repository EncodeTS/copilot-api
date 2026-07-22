import type {
  DesktopSettings,
  ServerStatus,
  SettingsSaveResult,
} from '../src/types/ipc'
import { hasProxyPolicyChanged } from './proxy-runtime-transition'

export interface SettingsApplyDependencies {
  getStatus: () => ServerStatus
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
    return (
      result ?? {
        action: 'unchanged',
        proxyChanged: false,
        serverStatus: dependencies.getStatus(),
        success: true,
      }
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to apply settings'
    const status = dependencies.getStatus()
    return {
      action: 'failed',
      error: message,
      proxyChanged: hasProxyPolicyChanged(previous.proxy, settings.proxy),
      serverStatus: { ...status, error: message },
      success: false,
    }
  }
}
