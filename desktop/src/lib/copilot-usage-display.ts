export interface CopilotQuotaDetailLike {
  entitlement?: number
  quota_remaining?: number
  unlimited?: boolean
}

export interface CopilotQuotaSnapshotsLike {
  chat?: CopilotQuotaDetailLike
  completions?: CopilotQuotaDetailLike
  premium_interactions?: CopilotQuotaDetailLike
}

export interface CopilotUsageDisplayLike {
  _copilot_api?: {
    error_code?: string | null
    freshness?: 'fresh' | 'stale'
    last_attempt_at_ms?: number
    last_success_at_ms?: number
    stale_since_at_ms?: number | null
  }
  copilot_plan?: string
  quota_reset_date?: string
  quota_snapshots?: CopilotQuotaSnapshotsLike
}

const UNLIMITED_QUOTA_TEXT = '\u221e'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function getNonEmptyUsageText(
  value: string | null | undefined,
): string | null {
  const text = value?.trim()
  return text ? text : null
}

export function hasCopilotQuotaValue(
  quota: CopilotQuotaDetailLike | null | undefined,
): quota is CopilotQuotaDetailLike {
  return Boolean(
    quota
    && (quota.unlimited === true
      || (isFiniteNumber(quota.entitlement)
        && isFiniteNumber(quota.quota_remaining))),
  )
}

export function getPremiumUsedText(
  quota: CopilotQuotaDetailLike | null | undefined,
): string | null {
  if (!hasCopilotQuotaValue(quota)) return null
  if (quota.unlimited) return UNLIMITED_QUOTA_TEXT

  const entitlement = quota.entitlement ?? 0
  const quotaRemaining = quota.quota_remaining ?? 0

  return `${Math.floor(entitlement - quotaRemaining)} / ${Math.floor(entitlement)}`
}

export function hasAnyCopilotQuotaSnapshot(
  snapshots: CopilotQuotaSnapshotsLike | null | undefined,
): boolean {
  return Boolean(
    snapshots
    && (hasCopilotQuotaValue(snapshots.premium_interactions)
      || hasCopilotQuotaValue(snapshots.chat)
      || hasCopilotQuotaValue(snapshots.completions)),
  )
}

export function shouldShowCopilotUsageSummary(
  usage: CopilotUsageDisplayLike | null | undefined,
): boolean {
  return Boolean(
    getNonEmptyUsageText(usage?.copilot_plan)
    || getPremiumUsedText(usage?.quota_snapshots?.premium_interactions)
    || getNonEmptyUsageText(usage?.quota_reset_date),
  )
}

export function shouldShowCopilotQuotaUsage(
  usage: CopilotUsageDisplayLike | null | undefined,
): boolean {
  return hasAnyCopilotQuotaSnapshot(usage?.quota_snapshots)
}

export function getCopilotUsageLastSuccessAt(
  usage: CopilotUsageDisplayLike | null | undefined,
): number | null {
  const value = usage?._copilot_api?.last_success_at_ms
  return isFiniteNumber(value) && value > 0 ? value : null
}
