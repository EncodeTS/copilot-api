import type {
  ModelMappingsConfigOutcome,
  ModelMappingsSaveOutcome,
} from "./model-mappings"
import type { TokenUsagePeriod } from "./token-usage"

export type LangPreference = "auto" | "en" | "zh"

export interface DeviceCodeInfo {
  device_code: string
  expires_in: number
  interval: number
  user_code: string
  verification_uri: string
}

export type DesktopAuthMode = "copilot" | "provider" | "none"

export interface AuthResult {
  error?: string
  mode?: DesktopAuthMode
  providers?: string[]
  success: boolean
}

export interface AuthStatus extends AuthResult {
  mode: DesktopAuthMode
}

export type ProviderType =
  | "anthropic"
  | "openai-compatible"
  | "openai-responses"
export type ProviderAuthType = "authorization" | "x-api-key"
export type ProviderAuthTypeInput = ProviderAuthType | "__default__"
export type QuickProviderName =
  | "opencode-go"
  | "deepseek"
  | "dashscope"
  | "openrouter"

export type ProviderAuthInput =
  | {
      apiKey: string
      baseUrl?: string
      provider: QuickProviderName
      type?: ProviderType
    }
  | {
      apiKey: string
      authType?: ProviderAuthTypeInput
      baseUrl: string
      name: string
      provider: "custom"
      type: ProviderType
    }

export interface ServerStatus {
  error?: string
  owned: boolean
  port: number
  running: boolean
  statusRevision: number
}

export const SETTINGS_RUNTIME_ACTIONS = [
  "applied",
  "failed",
  "restarted",
  "stopped",
  "unchanged",
] as const

export type SettingsRuntimeAction = (typeof SETTINGS_RUNTIME_ACTIONS)[number]

export interface SettingsSaveResult {
  action: SettingsRuntimeAction
  error?: string
  proxyChanged: boolean
  serverStatus: ServerStatus
  success: boolean
}

export type ServerStopOutcome =
  | { status: ServerStatus; stopped: true }
  | {
      error: string
      reason: "timeout"
      status: ServerStatus
      stopped: false
    }

export interface LogFeedEntry {
  cursor: number
  message: string
}

export interface LogFeedSnapshot {
  cursor: number
  entries: LogFeedEntry[]
}

export interface LogFeedBatch extends LogFeedSnapshot {
  reset: boolean
}

export type LogFeedUpdate =
  | { kind: "snapshot"; snapshot: LogFeedSnapshot }
  | { batch: LogFeedBatch; kind: "batch" }

export interface ServerAuthInfo {
  enabled: boolean
  headerName?: string
  headerValue?: string
}

export type ThemePreference = "light" | "dark" | "auto"
export type DesktopProxyMode = "system" | "custom" | "direct"

export interface DesktopProxySettings {
  http_proxy: string
  https_proxy: string
  mode: DesktopProxyMode
  no_proxy: string
}

export interface DesktopSettings {
  accountType: "individual" | "business" | "enterprise"
  apiHome: string
  enterpriseUrl: string
  language: LangPreference
  lastPort: number
  minimizeToTray: boolean
  oauthApp: "default" | "opencode"
  proxy: DesktopProxySettings
  theme: ThemePreference
  verbose: boolean
}

export interface DesktopApi {
  checkSavedToken: () => Promise<AuthResult>
  clearServerLogs: () => Promise<LogFeedSnapshot>
  configureProvider: (input: ProviderAuthInput) => Promise<AuthResult>
  fetchModels: () => Promise<unknown>
  fetchTokenUsage: (period: TokenUsagePeriod) => Promise<unknown>
  fetchTokenUsageDaily: (period: TokenUsagePeriod) => Promise<unknown>
  fetchTokenUsageEvents: (
    period: TokenUsagePeriod,
    page: number,
    pageSize: number,
  ) => Promise<unknown>
  fetchUsage: () => Promise<unknown>
  getAuthStatus: () => Promise<AuthStatus>
  getDeviceCode: () => Promise<DeviceCodeInfo>
  getServerLogSnapshot: () => Promise<LogFeedSnapshot>
  getModelMappingsConfig: () => Promise<ModelMappingsConfigOutcome>
  getServerAuthInfo: () => Promise<ServerAuthInfo>
  getServerStatus: () => Promise<ServerStatus>
  getSettings: () => Promise<DesktopSettings>
  logout: () => Promise<void>
  onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
  onServerStatus: (callback: (status: ServerStatus) => void) => () => void
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => () => void
  openUrl: (url: string) => Promise<void>
  platform: string
  saveModelMappings: (
    modelMappings: Record<string, string>,
  ) => Promise<ModelMappingsSaveOutcome>
  saveSettings: (settings: DesktopSettings) => Promise<SettingsSaveResult>
  saveToken: (token: string) => Promise<AuthResult>
  startCodexLogin: (callbackUrlOrCode?: string) => Promise<AuthResult>
  startServer: (
    port: number,
    authMode?: DesktopAuthMode,
  ) => Promise<ServerStatus>
  stopServer: () => Promise<ServerStopOutcome>
  subscribeServerLogs: (callback: (update: LogFeedUpdate) => void) => () => void
  windowClose: () => void
  windowIsMaximized: () => Promise<boolean>
  windowMaximizeToggle: () => void
  windowMinimize: () => void
  windowQuit: () => void
  windowReload: () => void
  windowZoomIn: () => void
  windowZoomOut: () => void
  windowZoomReset: () => void
}

declare global {
  interface Window {
    electronAPI: DesktopApi
  }
}
