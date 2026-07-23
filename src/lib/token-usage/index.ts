import { requestContext, generateTraceId } from "~/lib/request-context"
import { state } from "~/lib/state"
import type { TokenUsagePricingConfig } from "~/lib/config"

import { resolveTokenUsageCost } from "./pricing"
import {
  enqueueTokenUsageWrite,
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  normalizeTokenUsageErrorCode,
  normalizeTokenUsageOutcome,
  normalizeTokenUsageTerminal,
  resolveTotalTokens,
  type PersistedTokenUsageEvent,
  type TokenUsageEndpoint,
  type TokenUsageEnqueueResult,
  type TokenUsageErrorCode,
  type TokenUsageOutcome,
  type TokenUsageSource,
  type TokenUsageTerminal,
  type UsageTokens,
} from "./store"

export { normalizeResponsesUsage } from "./normalize-responses"

export {
  closeUsageStore,
  getTokenUsageWriteQueueStatus,
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  normalizeOptionalToken,
  normalizeToken,
  TOKEN_USAGE_ERROR_CODE_VALUES,
  TOKEN_USAGE_OUTCOME_VALUES,
  TOKEN_USAGE_TERMINAL_VALUES,
} from "./store"

export type {
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageCost,
  TokenUsageEventCost,
  TokenUsageEndpoint,
  TokenUsageEnqueueResult,
  TokenUsageErrorCode,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsageOutcome,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTerminal,
  TokenUsageTotals,
  TokenUsageWriteQueueStatus,
  UsageTokens,
} from "./store"

export interface TokenUsageEventInput extends UsageTokens {
  endpoint: TokenUsageEndpoint
  errorCode?: TokenUsageErrorCode | null
  fallbackSessionId?: string | null
  model: string
  outcome: TokenUsageOutcome
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  terminal?: TokenUsageTerminal | null
  traceId?: string | null
}

export interface TokenUsageRecordMetadata {
  errorCode?: TokenUsageErrorCode | null
  outcome?: TokenUsageOutcome
  terminal?: TokenUsageTerminal | null
}

export type TokenUsageRecorder = (
  usage: UsageTokens,
  metadata?: TokenUsageRecordMetadata,
) => TokenUsageRecordResult

export type TokenUsageRecordResult =
  | TokenUsageEnqueueResult
  | "already_recorded"
  | "ignored_empty"
  | "retry_exhausted"
  | "retry_mismatch"

interface TokenUsageRecorderOptions {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  outcome: TokenUsageOutcome
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

type CopilotTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "providerName" | "source"
>

type ProviderTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "source"
>

function resolveTraceId(traceId: string | null | undefined): string {
  return (
    traceId?.trim() || requestContext.getStore()?.traceId || generateTraceId()
  )
}

export function resolveTokenUsageSessionId(
  sessionId: string | null | undefined,
  fallbackSessionId?: string | null,
): string {
  return (
    requestContext.getStore()?.sessionAffinity?.trim()
    || sessionId?.trim()
    || fallbackSessionId?.trim()
    || ""
  )
}

function resolveUserId(input: TokenUsageEventInput): string {
  if (input.source === "provider") {
    return input.providerName?.trim() || ""
  }
  return state.userName?.trim() || ""
}

function toPersistedEvent(
  input: TokenUsageEventInput,
): PersistedTokenUsageEvent | null {
  const outcome = normalizeTokenUsageOutcome(input.outcome)
  if (!hasAnyToken(input) && outcome === "completed") {
    return null
  }

  const now = new Date()
  const cost = resolveTokenUsageCost(input)
  return {
    cache_creation_input_tokens: normalizeToken(
      input.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeToken(input.cache_read_input_tokens),
    cost_currency: cost?.currency ?? null,
    cost_source: cost?.source ?? null,
    created_at_ms: now.getTime(),
    created_at_utc: now.toISOString(),
    endpoint: input.endpoint,
    error_code: normalizeTokenUsageErrorCode(input.errorCode),
    input_tokens: normalizeToken(input.input_tokens),
    model: input.model.trim() || "unknown",
    outcome,
    output_tokens: normalizeToken(input.output_tokens),
    provider_name: input.providerName?.trim() || null,
    session_id: resolveTokenUsageSessionId(
      input.sessionId,
      input.fallbackSessionId,
    ),
    source: input.source,
    terminal: normalizeTokenUsageTerminal(input.terminal),
    total_nano_aiu:
      input.total_nano_aiu === undefined || input.total_nano_aiu === null ?
        null
      : normalizeToken(input.total_nano_aiu),
    total_cost_nanos: cost?.total_cost_nanos ?? null,
    total_tokens: resolveTotalTokens(input),
    trace_id: resolveTraceId(input.traceId),
    user_id: resolveUserId(input),
  }
}

export function recordTokenUsageEvent(
  input: TokenUsageEventInput,
): TokenUsageRecordResult {
  const event = toPersistedEvent(input)
  if (!event) {
    return "ignored_empty"
  }

  return enqueueTokenUsageWrite(event)
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions,
): TokenUsageRecorder {
  // A recorder is request-scoped. The first recordable terminal outcome wins
  // so retrying caller cleanup cannot duplicate one request in the ledger.
  let recorded = false
  let rejectedFingerprint: string | null = null
  let retryConsumed = false
  return (usage, metadata) => {
    if (recorded) {
      return "already_recorded"
    }
    const fingerprint = createRecorderFingerprint(usage, metadata, options)
    if (rejectedFingerprint !== null) {
      if (fingerprint !== rejectedFingerprint) {
        return "retry_mismatch"
      }
      if (retryConsumed) {
        return "retry_exhausted"
      }
      retryConsumed = true
    }
    const result = recordTokenUsageEvent({
      ...usage,
      ...options,
      ...metadata,
    })
    recorded = result === "accepted"
    if (
      !recorded
      && result !== "ignored_empty"
      && rejectedFingerprint === null
    ) {
      rejectedFingerprint = fingerprint
    }
    return result
  }
}

function createRecorderFingerprint(
  usage: UsageTokens,
  metadata: TokenUsageRecordMetadata | undefined,
  options: TokenUsageRecorderOptions,
): string {
  return JSON.stringify([
    normalizeToken(usage.cache_creation_input_tokens),
    normalizeToken(usage.cache_read_input_tokens),
    normalizeToken(usage.input_tokens),
    normalizeToken(usage.output_tokens),
    normalizeToken(usage.total_nano_aiu),
    normalizeOptionalToken(usage.total_tokens) ?? null,
    normalizeTokenUsageOutcome(metadata?.outcome ?? options.outcome),
    normalizeTokenUsageTerminal(metadata?.terminal),
    normalizeTokenUsageErrorCode(metadata?.errorCode),
  ])
}

export function createCopilotTokenUsageRecorder(
  options: CopilotTokenUsageRecorderOptions,
): TokenUsageRecorder {
  return createTokenUsageRecorder({
    ...options,
    source: "copilot",
  })
}

export function createProviderTokenUsageRecorder(
  options: ProviderTokenUsageRecorderOptions,
): TokenUsageRecorder {
  return createTokenUsageRecorder({
    ...options,
    source: "provider",
  })
}

export function normalizeOpenAIUsage(
  usage:
    | {
        completion_tokens?: number
        prompt_tokens?: number
        total_tokens?: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
        prompt_tokens_details?: {
          cache_creation_input_tokens?: number
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  if (
    usage
    && (Object.hasOwn(usage, "prompt_cache_hit_tokens")
      || Object.hasOwn(usage, "prompt_cache_miss_tokens"))
  ) {
    return {
      cache_read_input_tokens: normalizeToken(usage.prompt_cache_hit_tokens),
      input_tokens: normalizeToken(usage.prompt_cache_miss_tokens),
      output_tokens: normalizeToken(usage.completion_tokens),
      total_tokens: normalizeOptionalToken(usage.total_tokens),
    }
  }

  const promptDetails = usage?.prompt_tokens_details
  const hasCacheCreationTokens = Boolean(
    promptDetails
      && Object.hasOwn(promptDetails, "cache_creation_input_tokens"),
  )
  const hasCachedTokens = Boolean(
    promptDetails && Object.hasOwn(promptDetails, "cached_tokens"),
  )
  const cachedTokens = normalizeToken(promptDetails?.cached_tokens)
  const cacheCreationTokens = normalizeToken(
    promptDetails?.cache_creation_input_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    ...(hasCacheCreationTokens && {
      cache_creation_input_tokens: cacheCreationTokens,
    }),
    ...(hasCachedTokens && {
      cache_read_input_tokens: cachedTokens,
    }),
    input_tokens: Math.max(
      0,
      promptTokens - cachedTokens - cacheCreationTokens,
    ),
    output_tokens: normalizeToken(usage?.completion_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeAnthropicUsage(
  usage:
    | {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  return {
    cache_creation_input_tokens: normalizeOptionalToken(
      usage?.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeOptionalToken(
      usage?.cache_read_input_tokens,
    ),
    input_tokens: normalizeOptionalToken(usage?.input_tokens),
    output_tokens: normalizeOptionalToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function mergeAnthropicUsage(
  current: UsageTokens,
  next: UsageTokens,
): UsageTokens {
  return {
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_nano_aiu: next.total_nano_aiu ?? current.total_nano_aiu,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}
