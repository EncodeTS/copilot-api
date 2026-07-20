import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { inspect } from "node:util"

import {
  AuthRequestError,
  createAuthRequestError,
  fetchAuthJson,
  isRetryableAuthError,
  type AuthFetch,
} from "../src/lib/auth-request"
import { forwardError } from "../src/lib/error"
import { getCopilotToken } from "../src/services/github/get-copilot-token"

describe("auth HTTP requests", () => {
  test("aborts a request after its finite timeout", async () => {
    let receivedSignal: AbortSignal | undefined
    const fetcher: AuthFetch = (_input, init) => {
      receivedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        )
      })
    }

    const request = fetchAuthJson(
      "https://auth.example/token",
      {},
      {
        action: "Test token request",
        fetch: fetcher,
        timeoutMs: 5,
      },
    )

    const error: unknown = await request.catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      kind: "timeout",
      message: "Test token request timed out after 5ms",
    })
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("propagates caller cancellation into the active fetch", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const fetcher: AuthFetch = (_input, init) => {
      receivedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        )
      })
    }

    const request = fetchAuthJson(
      "https://auth.example/token",
      {},
      {
        action: "Test token request",
        fetch: fetcher,
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    )
    controller.abort()

    const error: unknown = await request.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: "aborted" })
    expect(receivedSignal?.aborted).toBe(true)
  })

  test("classifies retryable and permanent HTTP failures without retaining secrets", async () => {
    const secret = "copilot-secret-token"
    const retryable = await getCopilotToken({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ token: secret }), {
            status: 503,
            statusText: "Unavailable",
          }),
        ),
    }).catch((error: unknown) => error)

    expect(retryable).toBeInstanceOf(AuthRequestError)
    expect(isRetryableAuthError(retryable)).toBe(true)
    expect(String(retryable)).not.toContain(secret)

    const permanentResponse = new Response(JSON.stringify({ token: secret }), {
      headers: {
        authorization: "Bearer header-secret",
        "retry-after": "5",
      },
      status: 401,
      statusText: "Unauthorized",
    })
    const permanent = await getCopilotToken({
      fetch: () => Promise.resolve(permanentResponse),
    }).catch((error: unknown) => error)

    expect(permanent).toBeInstanceOf(AuthRequestError)
    expect(isRetryableAuthError(permanent)).toBe(false)
    expect(String(permanent)).not.toContain(secret)
    expect(permanent).toMatchObject({ headers: { "retry-after": "5" } })
    expect(permanent instanceof Error && "response" in permanent).toBe(false)
    expect(inspect(permanent, { depth: 5, showHidden: true })).not.toContain(
      secret,
    )
    expect(inspect(permanent, { depth: 5, showHidden: true })).not.toContain(
      "header-secret",
    )
    expect(permanentResponse.bodyUsed).toBe(true)
  })

  test("timeout remains active while a successful response body stalls", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"token":'))
        },
      }),
      { status: 200 },
    )

    const result: unknown = await Promise.race([
      getCopilotToken({
        fetch: () => Promise.resolve(response),
        timeoutMs: 5,
      }).catch((caught: unknown) => caught),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("body-read-hung"), 100),
      ),
    ])

    expect(result).toMatchObject({ kind: "timeout" })
    expect(cancelled).toBe(true)
  })

  test("caller abort remains active while a response body stalls", async () => {
    const controller = new AbortController()
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('{"token":'))
        },
      }),
      { status: 200 },
    )
    const request = getCopilotToken({
      fetch: () => Promise.resolve(response),
      signal: controller.signal,
      timeoutMs: 60_000,
    })
    setTimeout(() => controller.abort(), 1)

    const result: unknown = await Promise.race([
      request.catch((caught: unknown) => caught),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("body-read-hung"), 100),
      ),
    ])

    expect(result).toMatchObject({ kind: "aborted" })
    expect(cancelled).toBe(true)
  })

  test("cancels an auth body that exceeds the bounded read limit", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"token":"too-large"}'))
        },
      }),
      { status: 200 },
    )

    const error: unknown = await fetchAuthJson(
      "https://auth.example/token",
      {},
      {
        action: "Bounded token request",
        fetch: () => Promise.resolve(response),
        maxBodyBytes: 8,
      },
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      message: "Bounded token request response exceeded the safe body limit",
      retryDisposition: "permanent",
    })
    expect(cancelled).toBe(true)
  })

  test("oversized auth bodies reuse the HTTP retryability classifier", async () => {
    for (const [status, retryDisposition] of [
      [400, "permanent"],
      [408, "retryable"],
      [425, "retryable"],
      [429, "retryable"],
      [503, "retryable"],
    ] as const) {
      const error: unknown = await fetchAuthJson(
        "https://auth.example/token",
        {},
        {
          action: "Bounded token request",
          fetch: () =>
            Promise.resolve(new Response('{"token":"too-large"}', { status })),
          maxBodyBytes: 8,
        },
      ).catch((caught: unknown) => caught)

      expect(error).toMatchObject({ retryDisposition })
    }
  })

  test("redacts an auth response body when forwarding an error", async () => {
    const secret = "upstream-secret-token"
    const upstreamError: unknown = await getCopilotToken({
      fetch: () =>
        Promise.resolve(
          Response.json({ access_token: secret }, { status: 401 }),
        ),
    }).catch((error: unknown) => error)
    const app = new Hono()
    app.onError((error, context) => forwardError(context, error))
    app.get("/", () => {
      throw upstreamError
    })

    const response = await app.request("/")
    const body = await response.text()

    expect(response.status).toBe(401)
    expect(body).toContain("GitHub Copilot token request failed (401)")
    expect(body).not.toContain(secret)
  })

  test("maps HTTP 200 OAuth failures to explicit downstream error statuses", async () => {
    const retryable = createAuthRequestError({
      action: "OAuth refresh",
      oauthCode: "server_error",
      status: 200,
    })
    const permanent = createAuthRequestError({
      action: "OAuth refresh",
      oauthCode: "invalid_grant",
      status: 200,
    })

    expect(retryable).toMatchObject({
      downstreamStatus: 502,
      kind: "retryable",
      upstreamStatus: 200,
    })
    expect(permanent).toMatchObject({
      downstreamStatus: 401,
      kind: "permanent",
      upstreamStatus: 200,
    })

    const app = new Hono()
    app.onError((error, context) => forwardError(context, error))
    app.get("/", () => {
      throw retryable
    })
    expect((await app.request("/")).status).toBe(502)
  })
})
