export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export const TOKEN_USAGE_PERIOD_VALUES = ["day", "week", "month"] as const
export type TokenUsagePeriod = (typeof TOKEN_USAGE_PERIOD_VALUES)[number]

export const TOKEN_USAGE_OUTCOME_VALUES = [
  "aborted",
  "completed",
  "failed",
  "incomplete",
  "transport_error",
] as const

export type TokenUsageOutcome = (typeof TOKEN_USAGE_OUTCOME_VALUES)[number]

export const TOKEN_USAGE_ERROR_CODE_VALUES = [
  "aborted",
  "authentication_error",
  "bad_request",
  "caller_aborted",
  "connection_error",
  "invalid_request",
  "invalid_response",
  "max_output_tokens",
  "overloaded",
  "permission_error",
  "rate_limited",
  "response_failed",
  "timeout",
  "unknown_error",
  "upstream_disconnect",
  "upstream_error",
  "upstream_timeout",
] as const

export type TokenUsageErrorCode = (typeof TOKEN_USAGE_ERROR_CODE_VALUES)[number]

export const TOKEN_USAGE_TERMINAL_VALUES = [
  "aborted",
  "done",
  "eof",
  "error",
  "message_stop",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "transport_error",
  "unknown_terminal",
] as const

export type TokenUsageTerminal = (typeof TOKEN_USAGE_TERMINAL_VALUES)[number]

export interface TokenUsageCost {
  amount: number
  currency: string
  total_cost_nanos: number
}

export interface TokenUsageEventCost extends TokenUsageCost {
  source: string
}

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  costs: TokenUsageCost[]
  input_tokens: number
  output_tokens: number
  request_count: number
  total_nano_aiu: number | null
  total_tokens: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string
}

export interface TokenUsageRange {
  end_ms: number
  end_utc: string
  start_ms: number
  start_utc: string
}

export interface TokenUsageSummary {
  byModel: TokenUsageModelSummary[]
  period: TokenUsagePeriod
  range: TokenUsageRange
  totals: TokenUsageTotals
}

export interface TokenUsageDailyBucket {
  byModel: TokenUsageModelSummary[]
  date: string
  end_ms: number
  start_ms: number
  totals: TokenUsageTotals
}

export interface TokenUsageDailySummary {
  byModel: TokenUsageModelSummary[]
  days: TokenUsageDailyBucket[]
  period: TokenUsagePeriod
  range: TokenUsageRange
  totals: TokenUsageTotals
}

export interface TokenUsageEventRecord {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost: TokenUsageEventCost | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  error_code: TokenUsageErrorCode | null
  id: number
  input_tokens: number
  model: string
  outcome: TokenUsageOutcome
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  terminal: TokenUsageTerminal | null
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_id: string
}

export interface TokenUsageEventsPage {
  items: TokenUsageEventRecord[]
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: TokenUsageRange
  total: number
  total_pages: number
}
