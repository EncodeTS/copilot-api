import consola from "consola"

import {
  TOKEN_USAGE_ERROR_CODE_VALUES,
  TOKEN_USAGE_OUTCOME_VALUES,
  TOKEN_USAGE_TERMINAL_VALUES,
} from "../../../shared-types"
import type {
  TokenUsageCost,
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageErrorCode,
  TokenUsageEventCost,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsageOutcome,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTerminal,
  TokenUsageTotals,
} from "../../../shared-types"

import { PATHS } from "~/lib/paths"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import {
  isSqliteRuntimeSupported,
  iterateSqliteStatement,
  SqliteDbStore,
  type SqliteDatabase,
} from "~/lib/sqlite"

import { normalizeOptionalToken, normalizeToken } from "./normalize-number"

export { normalizeOptionalToken, normalizeToken } from "./normalize-number"

export {
  TOKEN_USAGE_ERROR_CODE_VALUES,
  TOKEN_USAGE_OUTCOME_VALUES,
  TOKEN_USAGE_TERMINAL_VALUES,
} from "../../../shared-types"
export type {
  TokenUsageCost,
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageErrorCode,
  TokenUsageEventCost,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsageOutcome,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTerminal,
  TokenUsageTotals,
} from "../../../shared-types"

export type TokenUsageEnqueueResult = "accepted" | "disabled" | "queue_full"

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_nano_aiu?: number | null
  total_tokens?: number | null
}

export interface PersistedTokenUsageEvent {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_currency: string | null
  cost_source: string | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  error_code: TokenUsageErrorCode | null
  input_tokens: number
  model: string
  outcome: TokenUsageOutcome
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  terminal: TokenUsageTerminal | null
  total_cost_nanos: number | null
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_id: string
}

const WRITE_QUEUE_CAPACITY_ENV = "COPILOT_API_TOKEN_USAGE_WRITE_QUEUE_CAPACITY"
const DEFAULT_WRITE_QUEUE_CAPACITY = 1_024
const MAX_WRITE_QUEUE_CAPACITY = 100_000
const COST_NANOS_PER_UNIT = 1_000_000_000

const pendingWrites: Array<PersistedTokenUsageEvent | undefined> = []
let pendingWriteHead = 0
let drainPromise: Promise<void> | null = null
let drainScheduled = false
let inFlightWriteCount = 0
let droppedWriteCount = 0
let enqueuedWriteCount = 0
let writtenWriteCount = 0
let writeErrorCount = 0

export interface TokenUsageWriteQueueStatus {
  capacity: number
  draining: boolean
  dropped: number
  enqueued: number
  in_flight: number
  pending: number
  write_errors: number
  written: number
}

function isStringValueOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && values.includes(value)
}

export function normalizeTokenUsageOutcome(value: unknown): TokenUsageOutcome {
  return isStringValueOf(TOKEN_USAGE_OUTCOME_VALUES, value) ? value : "failed"
}

export function normalizeTokenUsageErrorCode(
  value: unknown,
): TokenUsageErrorCode | null {
  if (value === null || value === undefined || value === "") return null
  return isStringValueOf(TOKEN_USAGE_ERROR_CODE_VALUES, value) ? value : (
      "unknown_error"
    )
}

export function normalizeTokenUsageTerminal(
  value: unknown,
): TokenUsageTerminal | null {
  if (value === null || value === undefined || value === "") return null
  return isStringValueOf(TOKEN_USAGE_TERMINAL_VALUES, value) ? value : (
      "unknown_terminal"
    )
}

function getDbPath(): string {
  return PATHS.getTokenUsageDbPath()
}

const tokenUsageDbStore = new SqliteDbStore({
  getPath: getDbPath,
  initialize: initializeTokenUsageDb,
})

function getDb(): Promise<SqliteDatabase> {
  return tokenUsageDbStore.getDb()
}

export function isTokenUsageStorageEnabled(): boolean {
  return isSqliteRuntimeSupported()
}

function initializeTokenUsageDb(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      provider_name TEXT,
      model TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'completed',
      terminal TEXT,
      error_code TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_nano_aiu INTEGER,
      cost_currency TEXT,
      total_cost_nanos INTEGER,
      cost_source TEXT
    )
  `)
  ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "outcome", "TEXT NOT NULL DEFAULT 'completed'")
  ensureColumn(db, "terminal", "TEXT")
  ensureColumn(db, "error_code", "TEXT")
  ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "total_nano_aiu", "INTEGER")
  ensureColumn(db, "cost_currency", "TEXT")
  ensureColumn(db, "total_cost_nanos", "INTEGER")
  ensureColumn(db, "cost_source", "TEXT")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_created_at_ms
    ON token_usage_events(created_at_ms)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_model
    ON token_usage_events(model)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_trace_id
    ON token_usage_events(trace_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_session_id
    ON token_usage_events(session_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_id
    ON token_usage_events(user_id)
  `)
}

function ensureColumn(
  db: SqliteDatabase,
  name: string,
  definition: string,
): void {
  const rows = db
    .prepare("PRAGMA table_info(token_usage_events)")
    .all() as Array<Record<string, unknown>>
  const hasColumn = rows.some((row) => row.name === name)
  if (!hasColumn) {
    db.exec(`ALTER TABLE token_usage_events ADD COLUMN ${name} ${definition}`)
  }
}

export function hasAnyToken(tokens: UsageTokens): boolean {
  return (
    normalizeToken(tokens.input_tokens) > 0
    || normalizeToken(tokens.output_tokens) > 0
    || normalizeToken(tokens.cache_read_input_tokens) > 0
    || normalizeToken(tokens.cache_creation_input_tokens) > 0
    || normalizeToken(tokens.total_tokens) > 0
    || normalizeToken(tokens.total_nano_aiu) > 0
  )
}

export function resolveTotalTokens(input: UsageTokens): number {
  const explicitTotal = normalizeOptionalToken(input.total_tokens)
  if (explicitTotal !== undefined) {
    return explicitTotal
  }
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.output_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}

async function writeTokenUsageEvent(
  event: PersistedTokenUsageEvent,
): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
      INSERT INTO token_usage_events (
        created_at_ms,
        created_at_utc,
        trace_id,
        session_id,
        user_id,
        source,
        endpoint,
        provider_name,
        model,
        outcome,
        terminal,
        error_code,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        total_nano_aiu,
        cost_currency,
        total_cost_nanos,
        cost_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.created_at_ms,
    event.created_at_utc,
    event.trace_id,
    event.session_id,
    event.user_id,
    event.source,
    event.endpoint,
    event.provider_name,
    event.model,
    event.outcome,
    event.terminal,
    event.error_code,
    event.input_tokens,
    event.output_tokens,
    event.cache_read_input_tokens,
    event.cache_creation_input_tokens,
    event.total_tokens,
    event.total_nano_aiu,
    event.cost_currency,
    event.total_cost_nanos,
    event.cost_source,
  )
}

function getWriteQueueCapacity(): number {
  const parsed = Number.parseInt(
    process.env[WRITE_QUEUE_CAPACITY_ENV] ?? "",
    10,
  )
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_WRITE_QUEUE_CAPACITY
  }
  return Math.min(MAX_WRITE_QUEUE_CAPACITY, parsed)
}

export function getTokenUsageWriteQueueStatus(): TokenUsageWriteQueueStatus {
  return {
    capacity: getWriteQueueCapacity(),
    draining: drainPromise !== null,
    dropped: droppedWriteCount,
    enqueued: enqueuedWriteCount,
    in_flight: inFlightWriteCount,
    pending: getPendingWriteCount(),
    write_errors: writeErrorCount,
    written: writtenWriteCount,
  }
}

export function enqueueTokenUsageWrite(
  event: PersistedTokenUsageEvent,
): TokenUsageEnqueueResult {
  if (!isTokenUsageStorageEnabled()) {
    return "disabled"
  }

  if (getPendingWriteCount() >= getWriteQueueCapacity()) {
    droppedWriteCount += 1
    if (droppedWriteCount === 1 || isPowerOfTwo(droppedWriteCount)) {
      consola.warn("Token usage write queue full; dropping newest event", {
        dropped: droppedWriteCount,
      })
    }
    return "queue_full"
  }

  pendingWrites.push(event)
  enqueuedWriteCount += 1
  scheduleDrain()
  return "accepted"
}

function getPendingWriteCount(): number {
  return pendingWrites.length - pendingWriteHead
}

function takePendingWrite(): PersistedTokenUsageEvent | undefined {
  const event = pendingWrites[pendingWriteHead]
  if (!event) return undefined

  pendingWrites[pendingWriteHead] = undefined
  pendingWriteHead += 1
  if (pendingWriteHead === pendingWrites.length) {
    pendingWrites.length = 0
    pendingWriteHead = 0
  } else if (
    pendingWriteHead >= 1_024
    && pendingWriteHead * 2 >= pendingWrites.length
  ) {
    pendingWrites.splice(0, pendingWriteHead)
    pendingWriteHead = 0
  }
  return event
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

function scheduleDrain(): void {
  if (drainScheduled || drainPromise) {
    return
  }
  drainScheduled = true
  queueMicrotask(() => {
    drainScheduled = false
    startDrain()
  })
}

function startDrain(): void {
  if (drainPromise || getPendingWriteCount() === 0) {
    return
  }

  drainPromise = drainTokenUsageWrites().finally(() => {
    drainPromise = null
    if (getPendingWriteCount() > 0) {
      scheduleDrain()
    }
  })
}

async function drainTokenUsageWrites(): Promise<void> {
  let event = takePendingWrite()
  while (event) {
    inFlightWriteCount = 1
    try {
      await writeTokenUsageEvent(event)
      writtenWriteCount += 1
    } catch {
      writeErrorCount += 1
      consola.warn("Failed to record token usage", {
        writeErrors: writeErrorCount,
      })
    }
    inFlightWriteCount = 0
    event = takePendingWrite()
  }
}

async function flushTokenUsageEvents(): Promise<void> {
  while (drainScheduled || drainPromise || getPendingWriteCount() > 0) {
    if (drainScheduled && !drainPromise) {
      await Promise.resolve()
      continue
    }
    if (!drainPromise) {
      startDrain()
      continue
    }
    await drainPromise
  }
}

function getPeriodRange(
  period: TokenUsagePeriod,
  now = new Date(),
  earliestUsageMs?: number,
) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  if (period === "all") {
    if (earliestUsageMs !== undefined) {
      start.setTime(Math.min(earliestUsageMs, now.getTime()))
      start.setHours(0, 0, 0, 0)
    }
    const end = new Date(now)
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + 1)
    return {
      endMs: end.getTime(),
      startMs: start.getTime(),
    }
  }

  switch (period) {
    case "day": {
      break
    }
    case "week": {
      start.setDate(start.getDate() - 6)
      break
    }
    case "month": {
      start.setDate(start.getDate() - 29)
      break
    }
    default: {
      break
    }
  }

  const end = new Date(start)
  switch (period) {
    case "day": {
      end.setDate(end.getDate() + 1)
      break
    }
    case "week": {
      end.setDate(end.getDate() + 7)
      break
    }
    case "month": {
      end.setDate(end.getDate() + 30)
      break
    }
    default: {
      break
    }
  }

  return {
    endMs: end.getTime(),
    startMs: start.getTime(),
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function createDailyIntervals(range: { endMs: number; startMs: number }) {
  const intervals: Array<{
    date: string
    endMs: number
    startMs: number
  }> = []
  const cursor = new Date(range.startMs)

  while (cursor.getTime() < range.endMs) {
    const startMs = cursor.getTime()
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    const endMs = Math.min(next.getTime(), range.endMs)
    intervals.push({
      date: formatLocalDate(cursor),
      endMs,
      startMs,
    })
    cursor.setTime(endMs)
  }

  return intervals
}

function createEmptyTotals(): TokenUsageTotals {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    costs: [],
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_nano_aiu: null,
    total_tokens: 0,
  }
}

function addTotals(target: TokenUsageTotals, next: TokenUsageTotals): void {
  target.cache_creation_input_tokens += next.cache_creation_input_tokens
  target.cache_read_input_tokens += next.cache_read_input_tokens
  target.costs = mergeCosts(target.costs, next.costs)
  target.input_tokens += next.input_tokens
  target.output_tokens += next.output_tokens
  target.request_count += next.request_count
  target.total_nano_aiu = addNullableNumbers(
    target.total_nano_aiu,
    next.total_nano_aiu,
  )
  target.total_tokens += next.total_tokens
}

function addNullableNumbers(
  current: number | null,
  next: number | null,
): number | null {
  if (current === null) return next
  if (next === null) return current
  return current + next
}

function mergeCosts(
  current: Array<TokenUsageCost>,
  next: Array<TokenUsageCost>,
): Array<TokenUsageCost> {
  const byCurrency = new Map<string, number>()
  for (const cost of [...current, ...next]) {
    byCurrency.set(
      cost.currency,
      (byCurrency.get(cost.currency) ?? 0) + cost.total_cost_nanos,
    )
  }

  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totalCostNanos]) => createCost(currency, totalCostNanos))
}

function createEmptySummary(period: TokenUsagePeriod): TokenUsageSummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: createEmptyTotals(),
  }
}

function createEmptyDailySummary(
  period: TokenUsagePeriod,
): TokenUsageDailySummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    days: createDailyIntervals(range).map((interval) => ({
      byModel: [],
      date: interval.date,
      end_ms: interval.endMs,
      start_ms: interval.startMs,
      totals: createEmptyTotals(),
    })),
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: createEmptyTotals(),
  }
}

function createEmptyEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): TokenUsageEventsPage {
  const range = getPeriodRange(input.period)
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))

  return {
    items: [],
    page,
    page_size: pageSize,
    period: input.period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total: 0,
    total_pages: 1,
  }
}

function rangePayload(range: { endMs: number; startMs: number }) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString(),
  }
}

function numberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nullableNumberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function getPeriodRangeForDatabase(
  db: SqliteDatabase,
  period: TokenUsagePeriod,
) {
  if (period !== "all") return getPeriodRange(period)
  const row = db
    .prepare(
      "SELECT MIN(created_at_ms) AS earliest_usage_ms FROM token_usage_events",
    )
    .get() as Record<string, unknown> | undefined
  const earliestUsageMs = nullableNumberFromRow(row, "earliest_usage_ms")
  return getPeriodRange(period, new Date(), earliestUsageMs ?? undefined)
}

function createCost(currency: string, totalCostNanos: number): TokenUsageCost {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos,
  }
}

function costFromRow(row: Record<string, unknown>): TokenUsageCost | null {
  const currency = row.cost_currency
  const totalCostNanos = row.total_cost_nanos
  if (
    typeof currency !== "string"
    || !currency
    || typeof totalCostNanos !== "number"
    || !Number.isFinite(totalCostNanos)
  ) {
    return null
  }

  return createCost(currency, totalCostNanos)
}

function eventCostFromRow(
  row: Record<string, unknown>,
): TokenUsageEventCost | null {
  const cost = costFromRow(row)
  const source = row.cost_source
  if (!cost || typeof source !== "string" || !source) {
    return null
  }

  return {
    ...cost,
    source,
  }
}

function totalsFromRow(
  row: Record<string, unknown> | undefined,
  costs: Array<TokenUsageCost> = [],
): TokenUsageTotals {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    costs,
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens"),
  }
}

function modelSummaryFromRow(
  row: Record<string, unknown>,
  costs: Array<TokenUsageCost> = [],
): TokenUsageModelSummary {
  return {
    ...totalsFromRow(row, costs),
    model: typeof row.model === "string" ? row.model : "unknown",
  }
}

function stringFromRow(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : ""
}

function nullableStringFromRow(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key]
  return typeof value === "string" ? value : null
}

function usageEventFromRow(
  row: Record<string, unknown>,
): TokenUsageEventRecord {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    cost: eventCostFromRow(row),
    created_at_ms: numberFromRow(row, "created_at_ms"),
    created_at_utc: stringFromRow(row, "created_at_utc"),
    endpoint: stringFromRow(row, "endpoint") as TokenUsageEndpoint,
    error_code: normalizeTokenUsageErrorCode(row.error_code),
    id: numberFromRow(row, "id"),
    input_tokens: numberFromRow(row, "input_tokens"),
    model: stringFromRow(row, "model") || "unknown",
    outcome: normalizeTokenUsageOutcome(row.outcome || "completed"),
    output_tokens: numberFromRow(row, "output_tokens"),
    provider_name: nullableStringFromRow(row, "provider_name"),
    session_id: stringFromRow(row, "session_id"),
    source: stringFromRow(row, "source") as TokenUsageSource,
    terminal: normalizeTokenUsageTerminal(row.terminal),
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens"),
    trace_id: stringFromRow(row, "trace_id"),
    user_id: stringFromRow(row, "user_id"),
  }
}

function getModelRows(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Array<Record<string, unknown>> {
  return db
    .prepare(
      `
    SELECT
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY
      total_tokens DESC,
      model ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>
}

function getModelCostMap(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Map<string, Array<TokenUsageCost>> {
  const rows = db
    .prepare(
      `
    SELECT
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY model, cost_currency
    ORDER BY model ASC, cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>

  const costMap = new Map<string, Array<TokenUsageCost>>()
  for (const row of rows) {
    const model = stringFromRow(row, "model") || "unknown"
    const cost = costFromRow(row)
    if (!cost) {
      continue
    }
    costMap.set(model, [...(costMap.get(model) ?? []), cost])
  }

  return costMap
}

function getModelSummaries(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Array<TokenUsageModelSummary> {
  const costMap = getModelCostMap(db, range)
  return getModelRows(db, range).map((row) => {
    const model = stringFromRow(row, "model") || "unknown"
    return modelSummaryFromRow(row, costMap.get(model) ?? [])
  })
}

function mergeModelSummaryGroups(
  groups: Iterable<Array<TokenUsageModelSummary>>,
): Array<TokenUsageModelSummary> {
  const summariesByModel = new Map<string, TokenUsageModelSummary>()
  for (const group of groups) {
    for (const model of group) {
      const summary = summariesByModel.get(model.model) ?? {
        ...createEmptyTotals(),
        model: model.model,
      }
      addTotals(summary, model)
      summariesByModel.set(model.model, summary)
    }
  }
  return [...summariesByModel.values()].sort(
    (left, right) =>
      right.total_tokens - left.total_tokens
      || left.model.localeCompare(right.model),
  )
}

function totalsFromModelSummaries(
  byModel: Array<TokenUsageModelSummary>,
): TokenUsageTotals {
  const totals = createEmptyTotals()
  for (const model of byModel) addTotals(totals, model)
  return totals
}

function getAllTimeDailyModelSummaries(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Map<string, Array<TokenUsageModelSummary>> {
  const statement = db.prepare(
    `
    SELECT
      created_at_ms,
      model,
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      total_nano_aiu,
      total_tokens,
      cost_currency,
      total_cost_nanos
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
  )
  const rows = iterateSqliteStatement(statement, range.startMs, range.endMs)
  const summariesByDateAndModel = new Map<
    string,
    Map<string, TokenUsageModelSummary>
  >()
  for (const value of rows) {
    const row = value as Record<string, unknown>
    const date = formatLocalDate(new Date(numberFromRow(row, "created_at_ms")))
    const model = stringFromRow(row, "model") || "unknown"
    const summariesByModel =
      summariesByDateAndModel.get(date)
      ?? new Map<string, TokenUsageModelSummary>()
    const summary = summariesByModel.get(model) ?? {
      ...createEmptyTotals(),
      model,
    }
    const cost = costFromRow(row)
    addTotals(summary, {
      cache_creation_input_tokens: numberFromRow(
        row,
        "cache_creation_input_tokens",
      ),
      cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
      costs: cost ? [cost] : [],
      input_tokens: numberFromRow(row, "input_tokens"),
      output_tokens: numberFromRow(row, "output_tokens"),
      request_count: 1,
      total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
      total_tokens: numberFromRow(row, "total_tokens"),
    })
    summariesByModel.set(model, summary)
    summariesByDateAndModel.set(date, summariesByModel)
  }
  return new Map(
    [...summariesByDateAndModel].map(([date, summariesByModel]) => [
      date,
      [...summariesByModel.values()].sort(
        (left, right) =>
          right.total_tokens - left.total_tokens
          || left.model.localeCompare(right.model),
      ),
    ]),
  )
}

function createDailyBucket(
  interval: { date: string; endMs: number; startMs: number },
  byModel: Array<TokenUsageModelSummary>,
): TokenUsageDailyBucket {
  const totals = createEmptyTotals()
  for (const model of byModel) {
    addTotals(totals, model)
  }

  return {
    byModel,
    date: interval.date,
    end_ms: interval.endMs,
    start_ms: interval.startMs,
    totals,
  }
}

export async function getTokenUsageSummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageSummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptySummary(period)
  }

  await flushTokenUsageEvents()
  const db = await getDb()
  const range = getPeriodRangeForDatabase(db, period)
  const byModel = getModelSummaries(db, range)

  return {
    byModel,
    period,
    range: rangePayload(range),
    totals: totalsFromModelSummaries(byModel),
  }
}

export async function getTokenUsageDailySummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageDailySummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyDailySummary(period)
  }

  await flushTokenUsageEvents()
  const db = await getDb()
  const range = getPeriodRangeForDatabase(db, period)
  const intervals = createDailyIntervals(range)
  const allTimeSummaries =
    period === "all" ? getAllTimeDailyModelSummaries(db, range) : undefined
  const byModel =
    allTimeSummaries ?
      mergeModelSummaryGroups(allTimeSummaries.values())
    : getModelSummaries(db, range)

  return {
    byModel,
    days: intervals.map((interval) =>
      createDailyBucket(
        interval,
        period === "all" ?
          (allTimeSummaries?.get(interval.date) ?? [])
        : getModelSummaries(db, interval),
      ),
    ),
    period,
    range: rangePayload(range),
    totals: totalsFromModelSummaries(byModel),
  }
}

export async function getTokenUsageEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): Promise<TokenUsageEventsPage> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyEventsPage(input)
  }

  await flushTokenUsageEvents()
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const db = await getDb()
  const range = getPeriodRangeForDatabase(db, input.period)

  const totalRow = db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined

  const rows = db
    .prepare(
      `
    SELECT
      id,
      created_at_ms,
      created_at_utc,
      trace_id,
      session_id,
      user_id,
      source,
      endpoint,
      provider_name,
      model,
      outcome,
      terminal,
      error_code,
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      total_nano_aiu,
      total_tokens,
      cost_currency,
      total_cost_nanos,
      cost_source
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, pageSize, offset) as Array<
    Record<string, unknown>
  >

  const total = numberFromRow(totalRow, "total")

  return {
    items: rows.map((row) => usageEventFromRow(row)),
    page,
    page_size: pageSize,
    period: input.period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function closeUsageStore(): Promise<void> {
  await flushTokenUsageEvents()
  await tokenUsageDbStore.close({
    beforeClose: (db) => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore cleanup errors in tests.
      }
    },
  })
  pendingWrites.length = 0
  pendingWriteHead = 0
  drainPromise = null
  drainScheduled = false
  inFlightWriteCount = 0
  droppedWriteCount = 0
  enqueuedWriteCount = 0
  writtenWriteCount = 0
  writeErrorCount = 0
}

registerProcessCleanup(closeUsageStore)
