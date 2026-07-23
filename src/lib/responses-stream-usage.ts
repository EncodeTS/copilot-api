import type { ResponsesStreamSessionOutcome } from "~/lib/responses-stream-session"
import type {
  TokenUsageErrorCode,
  TokenUsageRecordMetadata,
  TokenUsageRecordResult,
  TokenUsageRecorder,
  UsageTokens,
} from "~/lib/token-usage"
import { TOKEN_USAGE_ERROR_CODE_VALUES } from "~/lib/token-usage"
import type { ResponsesResult } from "~/services/copilot/create-responses"

const TOKEN_USAGE_ERROR_CODE_SET = new Set<string>(
  TOKEN_USAGE_ERROR_CODE_VALUES,
)

const RESPONSES_ERROR_CODE_ALIASES: ReadonlyMap<string, TokenUsageErrorCode> =
  new Map([
    ["rate_limit_exceeded", "rate_limited"],
    ["server_error", "upstream_error"],
    ["temporarily_unavailable", "overloaded"],
  ])

export interface ResponsesStreamUsageContext {
  abortOrigin?: "caller" | "local_protocol_error"
  failureOrigin?: "local_materialization_error"
}

export interface ResponsesStreamSessionUsageRecord {
  readonly metadata: Readonly<TokenUsageRecordMetadata>
  readonly usage: Readonly<UsageTokens>
}

export const resolveResponsesStreamSessionUsageRecord = (
  outcome: ResponsesStreamSessionOutcome,
  context: ResponsesStreamUsageContext = {},
): ResponsesStreamSessionUsageRecord =>
  Object.freeze({
    metadata: Object.freeze({
      ...getResponsesStreamSessionUsageMetadata(outcome, context),
    }),
    usage: Object.freeze({ ...(outcome.terminal?.usage ?? {}) }),
  })

export const recordResponsesStreamSessionUsage = (
  recordUsage: TokenUsageRecorder,
  outcome: ResponsesStreamSessionOutcome,
  context: ResponsesStreamUsageContext = {},
): TokenUsageRecordResult => {
  const record = resolveResponsesStreamSessionUsageRecord(outcome, context)
  return recordUsage(record.usage, record.metadata)
}

// Session outcome describes delivery/transport truth. A captured terminal is
// independent upstream truth, so keep its usage and event type even when the
// client-facing delivery later aborts, times out, or fails.
const getResponsesStreamSessionUsageMetadata = (
  outcome: ResponsesStreamSessionOutcome,
  context: ResponsesStreamUsageContext,
): TokenUsageRecordMetadata => {
  if (context.failureOrigin === "local_materialization_error") {
    return {
      errorCode: "invalid_response",
      outcome: "failed",
      terminal: outcome.terminal?.event.type ?? "unknown_terminal",
    }
  }
  switch (outcome.kind) {
    case "abort":
      if (context.abortOrigin === "local_protocol_error") {
        return {
          errorCode: "invalid_response",
          outcome: "failed",
          terminal: outcome.terminal?.event.type ?? "unknown_terminal",
        }
      }
      return {
        errorCode: "caller_aborted",
        outcome: "aborted",
        terminal: outcome.terminal?.event.type ?? "aborted",
      }
    case "completed":
      return {
        outcome: "completed",
        terminal: outcome.terminal.event.type,
      }
    case "delivery_failed":
      return {
        errorCode: "connection_error",
        outcome: "transport_error",
        terminal: outcome.terminal?.event.type ?? "transport_error",
      }
    case "eof":
      return {
        errorCode: "upstream_disconnect",
        outcome: "transport_error",
        terminal: "eof",
      }
    case "error":
      return {
        errorCode: normalizeResponsesErrorCode(
          outcome.terminal.event.error?.code ?? outcome.terminal.event.code,
          "upstream_error",
        ),
        outcome: "failed",
        terminal: outcome.terminal.event.type,
      }
    case "failed":
      return {
        errorCode: normalizeResponsesErrorCode(
          outcome.terminal.event.response.error?.code,
          "response_failed",
        ),
        outcome: "failed",
        terminal: outcome.terminal.event.type,
      }
    case "incomplete": {
      const reason = outcome.terminal.event.response.incomplete_details?.reason
      return {
        ...(reason === "max_output_tokens" || reason === "max_tokens" ?
          { errorCode: "max_output_tokens" as const }
        : {}),
        outcome: "incomplete",
        terminal: outcome.terminal.event.type,
      }
    }
    case "throw":
      return {
        errorCode: "upstream_disconnect",
        outcome: "transport_error",
        terminal: "transport_error",
      }
    case "timeout":
      return {
        errorCode: "upstream_timeout",
        outcome: "transport_error",
        terminal: outcome.terminal?.event.type ?? "transport_error",
      }
  }
}

export const getResponsesResultUsageMetadata = (
  result: ResponsesResult,
): TokenUsageRecordMetadata => {
  if (result.status === "cancelled") {
    return {
      errorCode: "aborted",
      outcome: "aborted",
      terminal: "aborted",
    }
  }
  if (result.status === "failed" || result.error) {
    return {
      errorCode: normalizeResponsesErrorCode(
        result.error?.code,
        "response_failed",
      ),
      outcome: "failed",
      terminal: "response.failed",
    }
  }
  if (result.status === "incomplete") {
    return getIncompleteResponsesUsageMetadata(result)
  }
  if (result.status === "completed") {
    return { outcome: "completed", terminal: "response.completed" }
  }
  return {
    errorCode: "invalid_response",
    outcome: "failed",
    terminal: "unknown_terminal",
  }
}

const getIncompleteResponsesUsageMetadata = (
  result: Pick<ResponsesResult, "incomplete_details">,
): TokenUsageRecordMetadata => {
  const reason = result.incomplete_details?.reason
  return {
    ...(reason === "max_output_tokens" || reason === "max_tokens" ?
      { errorCode: "max_output_tokens" as const }
    : {}),
    outcome: "incomplete",
    terminal: "response.incomplete",
  }
}

export const normalizeResponsesErrorCode = (
  value: unknown,
  fallback: TokenUsageErrorCode,
): TokenUsageErrorCode => {
  if (typeof value !== "string") return fallback
  if (TOKEN_USAGE_ERROR_CODE_SET.has(value)) {
    return value as TokenUsageErrorCode
  }
  return RESPONSES_ERROR_CODE_ALIASES.get(value) ?? fallback
}
