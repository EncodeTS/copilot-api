import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { usageRoute } from "~/routes/usage/route"
import {
  copilotUsageFetchDependencies,
  resetCopilotUsageCacheForTests,
} from "~/services/github/get-copilot-usage"

const originalDependencies = { ...copilotUsageFetchDependencies }
const originalGithubToken = state.githubToken
const originalUserName = state.userName

function createUsageResponse(): Response {
  return Response.json({
    access_type_sku: "copilot_enterprise_seat",
    analytics_tracking_id: "tracking-id",
    assigned_date: "2026-07-01",
    can_signup_for_limited: false,
    chat_enabled: true,
    copilot_plan: "enterprise",
    endpoints: {
      api: "https://api.enterprise.githubcopilot.com",
      telemetry: "https://telemetry.example.invalid",
    },
    login: "account-a",
    organization_list: [],
    organization_login_list: [],
    quota_reset_date: "2026-08-01",
    quota_snapshots: {
      chat: {},
      completions: {},
      premium_interactions: {},
    },
    token_based_billing: true,
  })
}

function createUsageApp(): Hono {
  const app = new Hono()
  app.route("/usage", usageRoute)
  return app
}

beforeEach(() => {
  Object.assign(copilotUsageFetchDependencies, originalDependencies)
  resetCopilotUsageCacheForTests()
  state.githubToken = "credential-a"
  state.userName = "account-a"
})

afterEach(() => {
  Object.assign(copilotUsageFetchDependencies, originalDependencies)
  resetCopilotUsageCacheForTests()
  state.githubToken = originalGithubToken
  state.userName = originalUserName
})

describe("usage route", () => {
  test("keeps the legacy null response when no GitHub token is configured", async () => {
    state.githubToken = undefined

    const response = await createUsageApp().request("/usage")

    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
  })

  test("keeps raw usage fields at the top level and adds namespaced refresh metadata", async () => {
    copilotUsageFetchDependencies.now = () => 1_000
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(createUsageResponse())

    const response = await createUsageApp().request("/usage")
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.login).toBe("account-a")
    expect(body.copilot_plan).toBe("enterprise")
    expect(body).not.toHaveProperty("usage")
    expect(body._copilot_api).toEqual({
      error_code: null,
      freshness: "fresh",
      last_attempt_at_ms: 1_000,
      last_success_at_ms: 1_000,
      stale_since_at_ms: null,
    })
  })

  test("returns a stale snapshot without advancing the last success timestamp", async () => {
    let now = 1_000
    let shouldFail = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.now = () => now
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        shouldFail ?
          new Response(null, { status: 503 })
        : createUsageResponse(),
      )
    const app = createUsageApp()

    await app.request("/usage")
    now = 1_500
    shouldFail = true
    const response = await app.request("/usage")
    const body = (await response.json()) as {
      _copilot_api?: Record<string, unknown>
      login?: string
    }

    expect(response.status).toBe(200)
    expect(body.login).toBe("account-a")
    expect(body._copilot_api).toEqual({
      error_code: "upstream_error",
      freshness: "stale",
      last_attempt_at_ms: 1_500,
      last_success_at_ms: 1_000,
      stale_since_at_ms: 1_500,
    })
  })

  test("returns only a safe code and status for an authorization failure", async () => {
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        new Response('{"private":"do not forward"}', { status: 401 }),
      )

    const response = await createUsageApp().request("/usage")
    const responseText = await response.text()

    expect(response.status).toBe(401)
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "unauthorized",
        message: "Failed to fetch Copilot usage",
      },
    })
    expect(responseText).not.toContain("do not forward")
  })

  test("maps forbidden, rate-limited, and transient upstream failures safely", async () => {
    const cases = [
      { expectedStatus: 403, status: 403 },
      { expectedStatus: 429, status: 429 },
      { expectedStatus: 502, status: 503 },
    ]
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.maxRetryAfterMs = 1_000

    for (const testCase of cases) {
      resetCopilotUsageCacheForTests()
      state.githubToken = `credential-${testCase.status}`
      copilotUsageFetchDependencies.fetch = () =>
        Promise.resolve(
          new Response(null, {
            headers:
              testCase.status === 429 ? { "retry-after": "120" } : undefined,
            status: testCase.status,
          }),
        )

      const response = await createUsageApp().request("/usage")
      expect(response.status).toBe(testCase.expectedStatus)
      if (testCase.status === 429) {
        expect(response.headers.get("retry-after")).toBe("1")
      }
    }
  })

  test("maps upstream timeout and caller abort without exposing internal errors", async () => {
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.requestTimeoutMs = 5
    copilotUsageFetchDependencies.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("upstream fetch aborted")),
          { once: true },
        )
      })

    const timeoutResponse = await createUsageApp().request("/usage")
    expect(timeoutResponse.status).toBe(504)

    resetCopilotUsageCacheForTests()
    const controller = new AbortController()
    controller.abort()
    const abortResponse = await createUsageApp().request(
      new Request("http://localhost/usage", { signal: controller.signal }),
    )
    expect(abortResponse.status).toBe(408)
  })

  test("rejects a 200 error envelope without exposing or caching it", async () => {
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        Response.json({ error: { message: "private quota service detail" } }),
      )

    const response = await createUsageApp().request("/usage")
    const responseText = await response.text()

    expect(response.status).toBe(502)
    expect(responseText).toContain("invalid_response")
    expect(responseText).not.toContain("private quota service detail")
  })

  test("rejects a valid 200 usage payload for another known account", async () => {
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        Response.json({
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            telemetry: "https://telemetry.example.invalid",
          },
          login: "account-b",
        }),
      )

    const response = await createUsageApp().request("/usage")

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_response",
        message: "Failed to fetch Copilot usage",
      },
    })
  })
})
