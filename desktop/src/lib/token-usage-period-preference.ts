import {
  isTokenUsagePeriod,
  type TokenUsagePeriod,
} from '../../../shared-types'

export const DEFAULT_TOKEN_USAGE_PERIOD: TokenUsagePeriod = 'all'
export const TOKEN_USAGE_PERIOD_STORAGE_KEY =
  'copilot-api.desktop.token-usage-period'

type TokenUsagePeriodStorage = Pick<Storage, 'getItem' | 'setItem'>

function getRendererStorage(): TokenUsagePeriodStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readTokenUsagePeriodPreference(
  storage: TokenUsagePeriodStorage | undefined = getRendererStorage(),
): TokenUsagePeriod {
  if (!storage) return DEFAULT_TOKEN_USAGE_PERIOD
  try {
    const value = storage.getItem(TOKEN_USAGE_PERIOD_STORAGE_KEY)
    return isTokenUsagePeriod(value) ? value : DEFAULT_TOKEN_USAGE_PERIOD
  } catch {
    return DEFAULT_TOKEN_USAGE_PERIOD
  }
}

export function writeTokenUsagePeriodPreference(
  period: TokenUsagePeriod,
  storage: TokenUsagePeriodStorage | undefined = getRendererStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(TOKEN_USAGE_PERIOD_STORAGE_KEY, period)
  } catch {
    // The dashboard remains usable when renderer storage is unavailable.
  }
}
