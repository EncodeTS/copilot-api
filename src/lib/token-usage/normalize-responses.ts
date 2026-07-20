import type { UsageTokens } from "./store"
import { normalizeOptionalToken, normalizeToken } from "./normalize-number"

export type { UsageTokens } from "./store"

export const normalizeResponsesUsage = (usage: unknown): UsageTokens => {
  const usageRecord = asRecord(usage)
  const inputDetails = asRecord(usageRecord?.input_tokens_details)
  const cachedTokens = normalizeToken(inputDetails?.cached_tokens)
  const cacheWriteTokens = normalizeToken(inputDetails?.cache_write_tokens)
  return {
    ...(cacheWriteTokens > 0 && {
      cache_creation_input_tokens: cacheWriteTokens,
    }),
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(
      0,
      normalizeToken(usageRecord?.input_tokens)
        - cachedTokens
        - cacheWriteTokens,
    ),
    output_tokens: normalizeToken(usageRecord?.output_tokens),
    total_tokens: normalizeOptionalToken(usageRecord?.total_tokens),
  }
}

export const normalizeResponsesAiu = (
  ...copilotUsageValues: Array<unknown>
): number | undefined => {
  for (const value of copilotUsageValues) {
    const totalNanoAiu = asRecord(value)?.total_nano_aiu
    if (totalNanoAiu !== null && totalNanoAiu !== undefined) {
      return normalizeOptionalToken(totalNanoAiu)
    }
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
