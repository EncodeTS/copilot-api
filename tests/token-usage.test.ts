import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { requestContext } from "~/lib/request-context"
import { openSqliteDatabase } from "~/lib/sqlite"
import { state } from "~/lib/state"
import {
  closeUsageStore,
  createCopilotTokenUsageRecorder,
  getTokenUsageWriteQueueStatus,
  normalizeOpenAIUsage,
  recordTokenUsageEvent,
  type TokenUsageDailySummary,
  type TokenUsageEventInput,
  type TokenUsageEventsPage,
  type TokenUsageRecorder,
  type TokenUsageSummary,
} from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import { tokenUsageRoute } from "~/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const WRITE_QUEUE_CAPACITY_ENV = "COPILOT_API_TOKEN_USAGE_WRITE_QUEUE_CAPACITY"

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  state.userName = "copilot-login"
  await closeUsageStore()
})

afterEach(async () => {
  await closeUsageStore()
  setSystemTime()
  state.userName = undefined
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Reflect.deleteProperty(process.env, WRITE_QUEUE_CAPACITY_ENV)
})

function createTokenUsageApp(): Hono {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function fetchEventsPage(pageSize = 20): Promise<TokenUsageEventsPage> {
  const response = await createTokenUsageApp().request(
    `/token-usage/events?period=day&page=1&page_size=${pageSize}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TokenUsageEventsPage
}

function localDate(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month, day, hour, 0, 0, 0)
}

function localDateLabel(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

describe("token usage storage", () => {
  test("normalizes OpenAI cache creation usage details", () => {
    expect(
      normalizeOpenAIUsage({
        completion_tokens: 10,
        prompt_tokens: 100,
        prompt_tokens_details: {
          cache_creation_input_tokens: 20,
          cached_tokens: 12,
        },
        total_tokens: 110,
      }),
    ).toEqual({
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 12,
      input_tokens: 68,
      output_tokens: 10,
      total_tokens: 110,
    })
  })

  test("records trace id and prefers x-session-affinity for session id", async () => {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () => {
        recordTokenUsageEvent({
          endpoint: "messages",
          input_tokens: 10,
          model: "gpt-test",
          outcome: "completed",
          output_tokens: 5,
          sessionId: "claude-session",
          source: "copilot",
        })
      },
    )

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(row.trace_id).toBe("trace-123")
    expect(row.session_id).toBe("opencode-session")
    expect(row.user_id).toBe("copilot-login")
    expect(row.total_tokens).toBe(15)
  })

  test("uses explicit metadata session id when no session affinity exists", async () => {
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 12,
      model: "claude-test",
      outcome: "completed",
      output_tokens: 4,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
    })

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(typeof row.trace_id).toBe("string")
    expect(row.trace_id.length).toBeGreaterThan(0)
    expect(row.session_id).toBe("claude-session")
    expect(row.user_id).toBe("anthropic")
    expect(row.total_tokens).toBe(16)
  })

  test("distinguishes completed and failed requests with identical usage without storing raw errors", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 10,
      model: "gpt-test",
      outcome: "completed",
      output_tokens: 5,
      source: "copilot",
      terminal: "response.completed",
    })
    recordTokenUsageEvent({
      endpoint: "responses",
      error: "private upstream response body",
      errorCode: "upstream_timeout",
      input_tokens: 10,
      model: "gpt-test",
      outcome: "failed",
      output_tokens: 5,
      source: "copilot",
      terminal: "response.failed",
    } as TokenUsageEventInput & { error: string })

    const page = await fetchEventsPage()

    expect(page.items).toHaveLength(2)
    expect(page.items.map((item) => item.outcome)).toEqual([
      "failed",
      "completed",
    ])
    expect(page.items[0]?.terminal).toBe("response.failed")
    expect(page.items[0]?.error_code).toBe("upstream_timeout")
    expect(JSON.stringify(page)).not.toContain("private upstream response body")
  })

  test("one request recorder persists a terminal failure exactly once", async () => {
    const recordUsage: TokenUsageRecorder = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      model: "gpt-test",
      outcome: "completed",
    })
    const usage = { input_tokens: 10, output_tokens: 5 }
    const terminal = {
      errorCode: "upstream_disconnect" as const,
      outcome: "transport_error" as const,
      terminal: "transport_error" as const,
    }

    recordUsage(usage, terminal)
    recordUsage(usage, terminal)
    const page = await fetchEventsPage()

    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.outcome).toBe("transport_error")
    expect(page.items[0]?.error_code).toBe("upstream_disconnect")
  })

  test("persists zero-token non-completions while ignoring zero-token completions", async () => {
    const nonCompletions = [
      {
        errorCode: "caller_aborted" as const,
        outcome: "aborted" as const,
        terminal: "aborted" as const,
      },
      {
        errorCode: "response_failed" as const,
        outcome: "failed" as const,
        terminal: "response.failed" as const,
      },
      {
        errorCode: "max_output_tokens" as const,
        outcome: "incomplete" as const,
        terminal: "response.incomplete" as const,
      },
      {
        errorCode: "upstream_disconnect" as const,
        outcome: "transport_error" as const,
        terminal: "transport_error" as const,
      },
    ]

    for (const metadata of nonCompletions) {
      const recordUsage = createCopilotTokenUsageRecorder({
        endpoint: "responses",
        model: `zero-${metadata.outcome}`,
        outcome: "completed",
      })
      expect(recordUsage({}, metadata)).toBe("accepted")
      expect(recordUsage({}, metadata)).toBe("already_recorded")
    }
    const recordCompleted = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      model: "zero-completed",
      outcome: "completed",
    })
    expect(
      recordCompleted(
        {},
        {
          outcome: "completed",
          terminal: "response.completed",
        },
      ),
    ).toBe("ignored_empty")

    const page = await fetchEventsPage()
    expect(page.items).toHaveLength(nonCompletions.length)
    expect(
      page.items.map((item) => ({
        errorCode: item.error_code,
        model: item.model,
        outcome: item.outcome,
        terminal: item.terminal,
        totalTokens: item.total_tokens,
      })),
    ).toEqual(
      [...nonCompletions].reverse().map((metadata) => ({
        errorCode: metadata.errorCode,
        model: `zero-${metadata.outcome}`,
        outcome: metadata.outcome,
        terminal: metadata.terminal,
        totalTokens: 0,
      })),
    )
  })

  test("bounds pending ledger writes and exposes dropped-event counters", async () => {
    process.env[WRITE_QUEUE_CAPACITY_ENV] = "2"
    for (let index = 0; index < 4; index += 1) {
      recordTokenUsageEvent({
        endpoint: "responses",
        input_tokens: index + 1,
        model: `gpt-${index}`,
        outcome: "completed",
        source: "copilot",
      })
    }

    expect(getTokenUsageWriteQueueStatus()).toEqual({
      capacity: 2,
      draining: false,
      dropped: 2,
      enqueued: 2,
      in_flight: 0,
      pending: 2,
      write_errors: 0,
      written: 0,
    })

    const page = await fetchEventsPage()
    expect(page.items).toHaveLength(2)
    expect(getTokenUsageWriteQueueStatus()).toMatchObject({
      dropped: 2,
      pending: 0,
      write_errors: 0,
      written: 2,
    })
  })

  test("a request recorder retries the same terminal once after queue admission fails", async () => {
    process.env[WRITE_QUEUE_CAPACITY_ENV] = "1"
    expect(
      recordTokenUsageEvent({
        endpoint: "responses",
        input_tokens: 1,
        model: "queue-filler",
        outcome: "completed",
        source: "copilot",
      }),
    ).toBe("accepted")
    const recordUsage = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      model: "retry-model",
      outcome: "completed",
    })
    const usage = { input_tokens: 10, output_tokens: 5 }
    const terminal = {
      errorCode: "upstream_disconnect" as const,
      outcome: "transport_error" as const,
      terminal: "transport_error" as const,
    }

    expect(recordUsage(usage, terminal)).toBe("queue_full")
    await fetchEventsPage()
    expect(recordUsage(usage, terminal)).toBe("accepted")
    expect(recordUsage(usage, terminal)).toBe("already_recorded")

    const page = await fetchEventsPage()
    expect(
      page.items.filter((item) => item.model === "retry-model"),
    ).toHaveLength(1)
    expect(getTokenUsageWriteQueueStatus()).toMatchObject({
      dropped: 1,
      enqueued: 2,
      pending: 0,
      written: 2,
    })
  })

  test("unknown terminal and error strings map to fixed safe enum values", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      errorCode: "private-secret-like-code" as never,
      input_tokens: 3,
      model: "gpt-test",
      outcome: "failed",
      source: "copilot",
      terminal: "private-secret-like-terminal" as never,
    })

    const page = await fetchEventsPage()
    expect(page.items[0]?.error_code).toBe("unknown_error")
    expect(page.items[0]?.terminal).toBe("unknown_terminal")
    expect(JSON.stringify(page)).not.toContain("private-secret")
  })

  test("migrates existing usage rows with backward-compatible completed defaults", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "copilot-usage-migration-"),
    )
    const dbPath = path.join(directory, "usage.sqlite")
    await closeUsageStore()
    process.env[DB_PATH_ENV] = dbPath

    try {
      const db = await openSqliteDatabase(dbPath)
      db.exec(`
        CREATE TABLE token_usage_events (
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
      const createdAt = Date.now()
      db.prepare(
        `
          INSERT INTO token_usage_events (
            created_at_ms, created_at_utc, trace_id, session_id, user_id,
            source, endpoint, model, input_tokens, output_tokens, total_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        createdAt,
        new Date(createdAt).toISOString(),
        "legacy-trace",
        "",
        "legacy-user",
        "copilot",
        "responses",
        "legacy-model",
        4,
        2,
        6,
      )
      db.close?.()

      const page = await fetchEventsPage()
      expect(page.items[0]).toMatchObject({
        error_code: null,
        outcome: "completed",
        terminal: null,
        total_tokens: 6,
        trace_id: "legacy-trace",
      })
    } finally {
      await closeUsageStore()
      rmSync(directory, { force: true, recursive: true })
      process.env[DB_PATH_ENV] = ":memory:"
    }
  })

  test("one SQLite write failure does not discard the next queued event", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "copilot-usage-isolation-"),
    )
    const dbPath = path.join(directory, "usage.sqlite")
    await closeUsageStore()
    process.env[DB_PATH_ENV] = dbPath

    try {
      await fetchEventsPage()
      const adminDb = await openSqliteDatabase(dbPath)
      adminDb.exec(`
        CREATE TRIGGER fail_one_usage_event
        BEFORE INSERT ON token_usage_events
        WHEN NEW.model = 'fail-model'
        BEGIN
          SELECT RAISE(FAIL, 'intentional test failure');
        END
      `)
      adminDb.close?.()

      recordTokenUsageEvent({
        endpoint: "responses",
        input_tokens: 1,
        model: "fail-model",
        outcome: "completed",
        source: "copilot",
      })
      recordTokenUsageEvent({
        endpoint: "responses",
        input_tokens: 2,
        model: "good-model",
        outcome: "completed",
        source: "copilot",
      })

      const page = await fetchEventsPage()
      expect(page.items.map((item) => item.model)).toEqual(["good-model"])
      expect(getTokenUsageWriteQueueStatus()).toMatchObject({
        write_errors: 1,
        written: 1,
      })
    } finally {
      await closeUsageStore()
      rmSync(directory, { force: true, recursive: true })
      process.env[DB_PATH_ENV] = ":memory:"
    }
  })

  test("does not write zero-token usage events", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 0,
      model: "gpt-test",
      outcome: "completed",
      output_tokens: 0,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.request_count).toBe(0)
  })

  test("summarizes by model with total token and user fields", async () => {
    recordTokenUsageEvent({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      outcome: "completed",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 1000,
    })
    recordTokenUsageEvent({
      cache_read_input_tokens: 4,
      endpoint: "responses",
      input_tokens: 20,
      model: "gpt-b",
      outcome: "completed",
      output_tokens: 6,
      source: "copilot",
      total_nano_aiu: 2500,
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)

    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      costs: [
        {
          amount: 0.000000035,
          currency: "USD",
          total_cost_nanos: 35,
        },
      ],
      input_tokens: 30,
      output_tokens: 9,
      request_count: 2,
      total_nano_aiu: 3500,
      total_tokens: 46,
    })
    expect(summary.totals.total_tokens).toBe(46)
    expect(summary.totals.total_nano_aiu).toBe(3500)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byModel.every((row) => row.total_tokens > 0)).toBe(true)
    expect(summary.byModel.map((row) => row.total_nano_aiu)).toEqual([
      2500, 1000,
    ])
  })

  test("returns paginated usage events with user id", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      outcome: "completed",
      output_tokens: 2,
      source: "copilot",
      total_nano_aiu: 1200,
    })
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 20,
      model: "claude-a",
      outcome: "completed",
      output_tokens: 5,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
      traceId: "trace-provider",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage/events?period=day&page=1&page_size=1",
    )
    expect(response.status).toBe(200)

    const page = (await response.json()) as TokenUsageEventsPage
    expect(page.total).toBe(2)
    expect(page.page).toBe(1)
    expect(page.page_size).toBe(1)
    expect(page.total_pages).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.total_nano_aiu).toBe(null)
    expect(page.items[0]?.user_id).toBe("anthropic")
    expect(page.items[0]?.trace_id).toBe("trace-provider")
    expect(page.items[0]?.session_id).toBe("claude-session")
    expect(page.items[0]?.total_tokens).toBe(25)
  })

  test("calculates built-in Codex GPT-5.6 prices with cached input discount", async () => {
    const expectedCosts = [
      { model: "gpt-5.6-sol", totalCostNanos: 96_000_000 },
      { model: "gpt-5.6-terra", totalCostNanos: 48_000_000 },
      { model: "gpt-5.6-luna", totalCostNanos: 19_200_000 },
    ]

    for (const { model } of expectedCosts) {
      recordTokenUsageEvent({
        cache_read_input_tokens: 2_000,
        endpoint: "responses",
        input_tokens: 1_000,
        model,
        outcome: "completed",
        output_tokens: 3_000,
        providerName: "codex",
        source: "provider",
      })
    }

    const page = await fetchEventsPage(10)
    const costsByModel = new Map(
      page.items.map((item) => [item.model, item.cost]),
    )

    for (const { model, totalCostNanos } of expectedCosts) {
      const cost = costsByModel.get(model)
      expect(cost?.currency).toBe("USD")
      expect(cost?.source).toBe("builtin")
      expect(cost?.total_cost_nanos).toBe(totalCostNanos)
    }

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.costs).toEqual([
      {
        amount: 0.1632,
        currency: "USD",
        total_cost_nanos: 163_200_000,
      },
    ])
  })

  test("only falls back to interaction id when no real session id exists", async () => {
    const recordWithFallback = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "interaction-session",
      model: "gpt-test",
      outcome: "completed",
    })
    const recordWithRealSession = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "ignored-interaction-session",
      model: "gpt-test",
      outcome: "completed",
      sessionId: "real-session",
    })

    recordWithFallback({
      input_tokens: 5,
    })
    recordWithRealSession({
      input_tokens: 7,
    })

    const page = await fetchEventsPage(10)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]?.session_id).toBe("real-session")
    expect(page.items[1]?.session_id).toBe("interaction-session")
  })

  test("returns all persisted history beyond the rolling month window", async () => {
    setSystemTime(localDate(2026, 4, 2, 9))
    recordTokenUsageEvent({
      endpoint: "messages",
      input_tokens: 10,
      model: "historical-model",
      outcome: "completed",
      output_tokens: 2,
      source: "copilot",
    })

    setSystemTime(localDate(2026, 6, 22, 10))
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 20,
      model: "current-model",
      outcome: "completed",
      output_tokens: 5,
      source: "copilot",
    })

    const app = createTokenUsageApp()
    const [summaryResponse, dailyResponse, eventsResponse] = await Promise.all([
      app.request("/token-usage?period=all"),
      app.request("/token-usage/daily?period=all"),
      app.request("/token-usage/events?period=all&page=1&page_size=10"),
    ])
    expect(summaryResponse.status).toBe(200)
    expect(dailyResponse.status).toBe(200)
    expect(eventsResponse.status).toBe(200)

    const summary = (await summaryResponse.json()) as TokenUsageSummary
    const daily = (await dailyResponse.json()) as TokenUsageDailySummary
    const events = (await eventsResponse.json()) as TokenUsageEventsPage
    expect(summary.period).toBe("all")
    expect(summary.totals.request_count).toBe(2)
    expect(summary.totals.total_tokens).toBe(37)
    expect(summary.range.start_ms).toBe(localDate(2026, 4, 2, 0).getTime())
    expect(summary.range.end_ms).toBe(localDate(2026, 6, 23, 0).getTime())
    expect(daily.period).toBe("all")
    expect(daily.days[0]?.date).toBe(localDateLabel(localDate(2026, 4, 2)))
    expect(daily.days.at(-1)?.date).toBe(localDateLabel(localDate(2026, 6, 22)))
    expect(events.period).toBe("all")
    expect(events.total).toBe(2)
    expect(events.items.map((event) => event.model)).toEqual([
      "current-model",
      "historical-model",
    ])
  })

  test("keeps an all-history range valid when the only event is future dated", async () => {
    setSystemTime(localDate(2026, 4, 16, 12))
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 10,
      model: "future-model",
      outcome: "completed",
      source: "copilot",
    })

    setSystemTime(localDate(2026, 4, 15, 12))
    const response = await createTokenUsageApp().request(
      "/token-usage?period=all",
    )
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.request_count).toBe(0)
    expect(summary.range.start_ms).toBe(localDate(2026, 4, 15, 0).getTime())
    expect(summary.range.end_ms).toBe(localDate(2026, 4, 16, 0).getTime())
    expect(summary.range.start_ms).toBeLessThan(summary.range.end_ms)
  })

  test("builds sparse multi-year all-history days without per-day database work", async () => {
    setSystemTime(localDate(2021, 0, 1, 12))
    recordTokenUsageEvent({
      endpoint: "messages",
      input_tokens: 1,
      model: "historical-model",
      outcome: "completed",
      source: "copilot",
    })

    setSystemTime(localDate(2026, 0, 1, 12))
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 2,
      model: "current-model",
      outcome: "completed",
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=all",
    )
    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.days.length).toBeGreaterThan(1_800)
    expect(daily.days[0]?.date).toBe(localDateLabel(localDate(2021, 0, 1)))
    expect(daily.days.at(-1)?.date).toBe(localDateLabel(localDate(2026, 0, 1)))
    expect(daily.totals.request_count).toBe(2)
  })

  test("returns daily token usage buckets by model with total tokens", async () => {
    setSystemTime(localDate(2026, 4, 8))
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 999,
      model: "outside-week",
      outcome: "completed",
      output_tokens: 1,
      source: "copilot",
    })

    setSystemTime(localDate(2026, 4, 12, 10))
    recordTokenUsageEvent({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      outcome: "completed",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 100,
    })
    recordTokenUsageEvent({
      cache_read_input_tokens: 4,
      endpoint: "responses",
      input_tokens: 20,
      model: "gpt-b",
      outcome: "completed",
      output_tokens: 5,
      source: "copilot",
      total_nano_aiu: 200,
    })

    setSystemTime(localDate(2026, 4, 14, 9))
    recordTokenUsageEvent({
      endpoint: "messages",
      input_tokens: 6,
      model: "gpt-a",
      outcome: "completed",
      output_tokens: 4,
      source: "copilot",
      total_nano_aiu: 300,
      total_tokens: 100,
    })

    setSystemTime(localDate(2026, 4, 15))
    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=week",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("week")
    expect(daily.days).toHaveLength(7)
    expect(daily.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      costs: [
        {
          amount: 0.000000006,
          currency: "USD",
          total_cost_nanos: 6,
        },
      ],
      input_tokens: 36,
      output_tokens: 12,
      request_count: 3,
      total_nano_aiu: 600,
      total_tokens: 145,
    })
    expect(daily.byModel.map((model) => model.model)).toEqual([
      "gpt-a",
      "gpt-b",
    ])
    expect(daily.byModel[0]?.total_tokens).toBe(116)
    expect(daily.byModel[0]?.total_nano_aiu).toBe(400)

    const firstDay = daily.days[0]
    expect(firstDay?.date).toBe(localDateLabel(localDate(2026, 4, 9)))
    expect(firstDay?.totals.total_tokens).toBe(0)

    const may12 = daily.days.find(
      (day) => day.date === localDateLabel(localDate(2026, 4, 12)),
    )
    expect(may12?.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      costs: [
        {
          amount: 0.000000003,
          currency: "USD",
          total_cost_nanos: 3,
        },
      ],
      input_tokens: 30,
      output_tokens: 8,
      request_count: 2,
      total_nano_aiu: 300,
      total_tokens: 45,
    })
    expect(may12?.byModel.map((model) => model.model)).toEqual([
      "gpt-b",
      "gpt-a",
    ])

    const may14 = daily.days.find(
      (day) => day.date === localDateLabel(localDate(2026, 4, 14)),
    )
    expect(may14?.totals.total_tokens).toBe(100)
    expect(may14?.byModel[0]?.model).toBe("gpt-a")
    expect(may14?.byModel[0]?.total_tokens).toBe(100)
  })

  test("returns empty daily buckets and falls back invalid period to day", async () => {
    setSystemTime(localDate(2026, 4, 15))
    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=invalid",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("day")
    expect(daily.days).toHaveLength(1)
    expect(daily.days[0]?.date).toBe(localDateLabel(localDate(2026, 4, 15)))
    expect(daily.days[0]?.totals.total_tokens).toBe(0)
    expect(daily.byModel).toEqual([])
    expect(daily.totals.request_count).toBe(0)
  })
})
