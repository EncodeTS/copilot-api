import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  CopilotUsageFetchError,
  copilotUsageFetchDependencies,
  getCopilotUsageSnapshot,
  resetCopilotUsageCacheForTests,
} from "~/services/github/get-copilot-usage"

const originalDependencies = { ...copilotUsageFetchDependencies }

function createUsage(login: string) {
  return {
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
    login,
    organization_list: [],
    organization_login_list: [],
    quota_reset_date: "2026-08-01",
    quota_snapshots: {
      chat: createQuota("chat"),
      completions: createQuota("completions"),
      premium_interactions: createQuota("premium_interactions"),
    },
    token_based_billing: true,
  }
}

function createQuota(quotaId: string) {
  return {
    entitlement: 100,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: 75,
    quota_id: quotaId,
    quota_remaining: 75,
    remaining: 75,
    unlimited: false,
  }
}

function usageResponse(login: string): Response {
  return Response.json(createUsage(login))
}

async function expectUsageError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ code })
}

beforeEach(() => {
  Object.assign(copilotUsageFetchDependencies, originalDependencies)
  resetCopilotUsageCacheForTests()
})

afterEach(() => {
  Object.assign(copilotUsageFetchDependencies, originalDependencies)
  resetCopilotUsageCacheForTests()
})

describe("Copilot usage refresh", () => {
  test("twenty concurrent calls in one credential scope share one upstream request", async () => {
    let requestCount = 0
    let releaseRequest: (() => void) | undefined
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    copilotUsageFetchDependencies.fetch = async () => {
      requestCount += 1
      await requestGate
      return usageResponse("account-a")
    }

    const requests = Array.from({ length: 20 }, () =>
      getCopilotUsageSnapshot("credential-a"),
    )
    await Promise.resolve()

    expect(requestCount).toBe(1)
    releaseRequest?.()
    const snapshots = await Promise.all(requests)

    expect(
      snapshots.every((snapshot) => snapshot?.usage.login === "account-a"),
    ).toBe(true)
    expect(
      snapshots.every((snapshot) => snapshot?.status.freshness === "fresh"),
    ).toBe(true)
  })

  test("different timeout, attempt, or expected-login contracts do not share one refresh", async () => {
    let requestCount = 0
    let releaseRequests: (() => void) | undefined
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve
    })
    copilotUsageFetchDependencies.fetch = async () => {
      requestCount += 1
      await requestGate
      return usageResponse("account-a")
    }

    const startupRequest = getCopilotUsageSnapshot("credential-a", {
      expectedLogin: "account-a",
      maxAttempts: 1,
      requestTimeoutMs: 750,
    })
    const routeRequest = getCopilotUsageSnapshot("credential-a", {
      expectedLogin: "account-a",
      maxAttempts: 2,
      requestTimeoutMs: 5_000,
    })
    const otherIdentityRequest = getCopilotUsageSnapshot("credential-a", {
      expectedLogin: "account-b",
      maxAttempts: 2,
      requestTimeoutMs: 5_000,
    })
    const otherIdentityAssertion = expectUsageError(
      otherIdentityRequest,
      "invalid_response",
    )
    await Promise.resolve()

    expect(requestCount).toBe(3)
    releaseRequests?.()
    expect((await startupRequest)?.usage.login).toBe("account-a")
    expect((await routeRequest)?.usage.login).toBe("account-a")
    await otherIdentityAssertion
  })

  test("an older policy failure cannot erase a newer policy success in either start order", async () => {
    for (const olderPolicy of ["normal", "startup"] as const) {
      resetCopilotUsageCacheForTests()
      let requestCount = 0
      let releaseOlder: (() => void) | undefined
      const olderGate = new Promise<void>((resolve) => {
        releaseOlder = resolve
      })
      copilotUsageFetchDependencies.fetch = async () => {
        requestCount += 1
        if (requestCount === 1) {
          await olderGate
          return new Response(null, { status: 503 })
        }
        if (requestCount === 2) {
          return usageResponse("account-a")
        }
        return new Response(null, { status: 503 })
      }
      const normalPolicy = {
        expectedLogin: "account-a",
        maxAttempts: 1,
        requestTimeoutMs: 5_000,
      }
      const startupPolicy = {
        expectedLogin: "account-a",
        maxAttempts: 1,
        requestTimeoutMs: 750,
      }
      const firstPolicy =
        olderPolicy === "normal" ? normalPolicy : startupPolicy
      const secondPolicy =
        olderPolicy === "normal" ? startupPolicy : normalPolicy

      const olderRequest = getCopilotUsageSnapshot("credential-a", firstPolicy)
      await Promise.resolve()
      const newerSnapshot = await getCopilotUsageSnapshot(
        "credential-a",
        secondPolicy,
      )
      expect(newerSnapshot?.status.freshness).toBe("fresh")

      releaseOlder?.()
      const olderSnapshot = await olderRequest
      expect(olderSnapshot?.usage.login).toBe("account-a")
      expect(olderSnapshot?.status.freshness).toBe("stale")

      const probe = await getCopilotUsageSnapshot("credential-a", firstPolicy)
      expect(probe?.usage.login).toBe("account-a")
      expect(probe?.status.freshness).toBe("stale")
      expect(requestCount).toBe(3)
    }
  })

  test("429 retry waits for the capped Retry-After before one bounded retry", async () => {
    const sleepDurations: Array<number> = []
    let requestCount = 0
    copilotUsageFetchDependencies.maxAttempts = 2
    copilotUsageFetchDependencies.maxRetryAfterMs = 250
    copilotUsageFetchDependencies.sleep = (milliseconds) => {
      sleepDurations.push(milliseconds)
      return Promise.resolve()
    }
    copilotUsageFetchDependencies.fetch = () => {
      requestCount += 1
      if (requestCount === 1) {
        return Promise.resolve(
          new Response(null, {
            headers: { "retry-after": "120" },
            status: 429,
          }),
        )
      }
      return Promise.resolve(usageResponse("account-a"))
    }

    const snapshot = await getCopilotUsageSnapshot("credential-a")

    expect(snapshot?.usage.login).toBe("account-a")
    expect(requestCount).toBe(2)
    expect(sleepDurations).toEqual([250])
  })

  test("a permanently pending upstream attempt ends at the configured timeout", async () => {
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.requestTimeoutMs = 10
    copilotUsageFetchDependencies.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("usage fetch aborted"),
            ),
          { once: true },
        )
      })

    await expectUsageError(getCopilotUsageSnapshot("credential-a"), "timeout")
  })

  test("a transient network failure receives only the configured bounded retry", async () => {
    let requestCount = 0
    copilotUsageFetchDependencies.maxAttempts = 2
    copilotUsageFetchDependencies.sleep = () => Promise.resolve()
    copilotUsageFetchDependencies.fetch = () => {
      requestCount += 1
      if (requestCount === 1) {
        return Promise.reject(new Error("private upstream detail"))
      }
      return Promise.resolve(usageResponse("account-a"))
    }

    const snapshot = await getCopilotUsageSnapshot("credential-a")

    expect(snapshot?.usage.login).toBe("account-a")
    expect(requestCount).toBe(2)
  })

  test("one caller can abort without cancelling a same-scope shared refresh", async () => {
    const controller = new AbortController()
    let requestCount = 0
    let releaseRequest: (() => void) | undefined
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    copilotUsageFetchDependencies.fetch = async () => {
      requestCount += 1
      await requestGate
      return usageResponse("account-a")
    }

    const abortedRequest = getCopilotUsageSnapshot("credential-a", {
      signal: controller.signal,
    })
    const sharedRequest = getCopilotUsageSnapshot("credential-a")
    controller.abort()

    await expectUsageError(abortedRequest, "aborted")
    releaseRequest?.()
    expect((await sharedRequest)?.usage.login).toBe("account-a")
    expect(requestCount).toBe(1)
  })

  test("the shared upstream refresh aborts when its final waiter leaves", async () => {
    const first = new AbortController()
    const second = new AbortController()
    let upstreamAborted = false
    let signalReady: (() => void) | undefined
    const upstreamStarted = new Promise<void>((resolve) => {
      signalReady = resolve
    })
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.requestTimeoutMs = 50
    copilotUsageFetchDependencies.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signalReady?.()
        init?.signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true
            reject(new Error("shared refresh aborted"))
          },
          { once: true },
        )
      })

    const firstRequest = getCopilotUsageSnapshot("credential-a", {
      signal: first.signal,
    })
    const secondRequest = getCopilotUsageSnapshot("credential-a", {
      signal: second.signal,
    })
    await upstreamStarted

    first.abort()
    await expectUsageError(firstRequest, "aborted")
    expect(upstreamAborted).toBe(false)

    second.abort()
    await expectUsageError(secondRequest, "aborted")
    await Promise.resolve()
    expect(upstreamAborted).toBe(true)
  })

  test("the final waiter abort also cancels a pending retry delay", async () => {
    const controller = new AbortController()
    let requestCount = 0
    let retrySleepAborted = false
    let retrySleepStarted: (() => void) | undefined
    const retryStarted = new Promise<void>((resolve) => {
      retrySleepStarted = resolve
    })
    copilotUsageFetchDependencies.maxAttempts = 2
    copilotUsageFetchDependencies.fetch = () => {
      requestCount += 1
      return Promise.resolve(new Response(null, { status: 503 }))
    }
    copilotUsageFetchDependencies.sleep = (_milliseconds, signal) =>
      new Promise<void>((resolve, reject) => {
        retrySleepStarted?.()
        const timeout = setTimeout(resolve, 50)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout)
            retrySleepAborted = true
            reject(new CopilotUsageFetchError({ code: "aborted" }))
          },
          { once: true },
        )
      })

    const request = getCopilotUsageSnapshot("credential-a", {
      signal: controller.signal,
    })
    await retryStarted
    controller.abort()

    await expectUsageError(request, "aborted")
    await Promise.resolve()
    expect(retrySleepAborted).toBe(true)
    expect(requestCount).toBe(1)
  })

  test("a transient failure returns only same-scope last-known-good within TTL", async () => {
    let now = 1_000
    let shouldFail = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.now = () => now
    copilotUsageFetchDependencies.staleTtlMs = 1_000
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        shouldFail ?
          new Response(null, { status: 503 })
        : usageResponse("account-a"),
      )

    const fresh = await getCopilotUsageSnapshot("credential-a")
    shouldFail = true
    now = 1_500
    const stale = await getCopilotUsageSnapshot("credential-a")

    expect(fresh?.status).toEqual({
      error_code: null,
      freshness: "fresh",
      last_attempt_at_ms: 1_000,
      last_success_at_ms: 1_000,
      stale_since_at_ms: null,
    })
    expect(stale?.usage.login).toBe("account-a")
    expect(stale?.status).toEqual({
      error_code: "upstream_error",
      freshness: "stale",
      last_attempt_at_ms: 1_500,
      last_success_at_ms: 1_000,
      stale_since_at_ms: 1_500,
    })
  })

  test("401 never crosses credential scopes and invalidates that scope's stale data", async () => {
    const responses = [
      usageResponse("account-a"),
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
      new Response(null, { status: 503 }),
    ]
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 503 }))

    await getCopilotUsageSnapshot("credential-a")
    await expectUsageError(
      getCopilotUsageSnapshot("credential-b"),
      "unauthorized",
    )
    await expectUsageError(
      getCopilotUsageSnapshot("credential-a"),
      "unauthorized",
    )
    await expectUsageError(
      getCopilotUsageSnapshot("credential-a"),
      "upstream_error",
    )
  })

  test("last-known-good is unavailable after its TTL", async () => {
    let now = 10_000
    let shouldFail = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.now = () => now
    copilotUsageFetchDependencies.staleTtlMs = 500
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        shouldFail ?
          new Response(null, { status: 503 })
        : usageResponse("account-a"),
      )

    await getCopilotUsageSnapshot("credential-a")
    now = 10_501
    shouldFail = true

    await expectUsageError(
      getCopilotUsageSnapshot("credential-a"),
      "upstream_error",
    )
  })

  test("clock rollback cannot extend the last-known-good TTL", async () => {
    let now = 10_000
    let shouldFail = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.now = () => now
    copilotUsageFetchDependencies.staleTtlMs = 1_000
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        shouldFail ?
          new Response(null, { status: 503 })
        : usageResponse("account-a"),
      )

    await getCopilotUsageSnapshot("credential-a", {
      expectedLogin: "account-a",
    })
    shouldFail = true
    now = 9_999

    await expectUsageError(
      getCopilotUsageSnapshot("credential-a", {
        expectedLogin: "account-a",
      }),
      "upstream_error",
    )
  })

  test("last-known-good must match the current expected login", async () => {
    let shouldFail = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        shouldFail ?
          new Response(null, { status: 503 })
        : usageResponse("account-b"),
      )

    await getCopilotUsageSnapshot("credential-a")
    shouldFail = true

    await expectUsageError(
      getCopilotUsageSnapshot("credential-a", {
        expectedLogin: "account-a",
      }),
      "upstream_error",
    )
  })

  test("last-known-good storage evicts the least-recent credential scope at its bound", async () => {
    const responses = [
      usageResponse("account-a"),
      usageResponse("account-b"),
      usageResponse("account-c"),
      new Response(null, { status: 503 }),
    ]
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.maxScopes = 2
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 503 }))

    await getCopilotUsageSnapshot("credential-a")
    await getCopilotUsageSnapshot("credential-b")
    await getCopilotUsageSnapshot("credential-c")

    await expectUsageError(
      getCopilotUsageSnapshot("credential-a"),
      "upstream_error",
    )
  })

  test("rejects malformed 200 payloads without advancing last-known-good", async () => {
    const invalidPayloads: Array<unknown> = [
      null,
      [],
      {},
      { error: { message: "private upstream envelope" } },
      {
        endpoints: {
          api: "not-a-url",
          telemetry: "https://telemetry.example.invalid",
        },
        login: "account-a",
      },
      {
        endpoints: {
          api: "https://api.githubcopilot.com",
          telemetry: "https://telemetry.example.invalid",
        },
        login: "account-a",
        token_based_billing: "yes",
      },
      {
        endpoints: {
          api: "https://api.githubcopilot.com",
          telemetry: "https://telemetry.example.invalid",
        },
        login: "account-a",
        quota_snapshots: { chat: { entitlement: "100" } },
      },
    ]
    copilotUsageFetchDependencies.maxAttempts = 1

    for (const invalidPayload of invalidPayloads) {
      resetCopilotUsageCacheForTests()
      copilotUsageFetchDependencies.fetch = () =>
        Promise.resolve(Response.json(invalidPayload))

      await expectUsageError(
        getCopilotUsageSnapshot("credential-a"),
        "invalid_response",
      )
    }
  })

  test("a malformed 200 response can use a validated same-scope LKG as stale", async () => {
    let now = 1_000
    let valid = true
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.now = () => now
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        valid ? usageResponse("account-a") : Response.json({ error: {} }),
      )

    await getCopilotUsageSnapshot("credential-a")
    valid = false
    now = 1_500
    const stale = await getCopilotUsageSnapshot("credential-a")

    expect(stale?.usage.login).toBe("account-a")
    expect(stale?.status).toEqual({
      error_code: "invalid_response",
      freshness: "stale",
      last_attempt_at_ms: 1_500,
      last_success_at_ms: 1_000,
      stale_since_at_ms: 1_500,
    })
  })

  test("a non-transient invalid HTTP response does not reuse LKG", async () => {
    let invalidHttpResponse = false
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        invalidHttpResponse ?
          new Response(null, { status: 400 })
        : usageResponse("account-a"),
      )

    await getCopilotUsageSnapshot("credential-a")
    invalidHttpResponse = true

    await expectUsageError(
      getCopilotUsageSnapshot("credential-a"),
      "invalid_response",
    )
  })
})
