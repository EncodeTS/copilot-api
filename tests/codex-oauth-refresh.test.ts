import { describe, expect, test } from "bun:test"

import {
  AuthProtocolError,
  AuthRequestError,
  isRetryableAuthError,
} from "../src/lib/auth-request"
import { loginCodex, refreshCodexCredentials } from "../src/lib/oauth/codex"

const credentials = {
  accessToken: "old-access-token",
  accountId: "old-account",
  expiresAt: 0,
  refreshToken: "old-refresh-token",
}

describe("Codex OAuth refresh", () => {
  test("caller abort cancels the fallback prompt wait", async () => {
    const controller = new AbortController()
    let promptStarted!: () => void
    const promptWasStarted = new Promise<void>((resolve) => {
      promptStarted = resolve
    })
    const login = loginCodex({
      callbackTimeoutMs: 1,
      onAuth: () => {},
      onPrompt: (_message, signal) => {
        expect(signal).toBe(controller.signal)
        promptStarted()
        return new Promise<string>(() => {})
      },
      signal: controller.signal,
    }).catch((caught: unknown) => caught)

    await promptWasStarted
    controller.abort()
    const error = await login

    expect(error).toMatchObject({ kind: "aborted" })
  })

  test("caller abort closes the callback listen-pending window", async () => {
    const controller = new AbortController()
    const error: unknown = await loginCodex({
      callbackTimeoutMs: 60_000,
      onAuth: () => {},
      onCallbackServerCreated(server) {
        server.listen = (() => {
          queueMicrotask(() => controller.abort())
          return server
        }) as typeof server.listen
      },
      onPrompt: () => Promise.resolve("unexpected-prompt"),
      signal: controller.signal,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: "aborted" })
  })

  test("bounds the callback wait and exchanges the prompted code with a signal", async () => {
    const jwtPayload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-from-jwt",
        },
      }),
    ).toString("base64url")
    let requestSignal: AbortSignal | null | undefined

    const result = await loginCodex({
      callbackTimeoutMs: 1,
      fetch: (_input, init) => {
        requestSignal = init?.signal
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: `header.${jwtPayload}.signature`,
              expires_in: 3_600,
              refresh_token: "new-refresh-token",
            }),
            { status: 200 },
          ),
        )
      },
      onAuth: () => {},
      onPrompt: () => Promise.resolve("authorization-code"),
    })

    expect(result).toMatchObject({
      accountId: "account-from-jwt",
      refreshToken: "new-refresh-token",
    })
    expect(requestSignal).toBeDefined()
  })

  test("does not include malformed token payloads in an error", async () => {
    const secret = "new-access-token-secret"
    const error = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: secret }), {
            status: 200,
          }),
        ),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthProtocolError)
    expect(String(error)).toBe(
      "AuthProtocolError: Codex token refresh response is missing required fields",
    )
    expect(String(error)).not.toContain(secret)
  })

  test("classifies invalid_grant as permanent without exposing the response body", async () => {
    const secret = "rotated-token-secret"
    const error = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "invalid_grant", access_token: secret }),
            { status: 400 },
          ),
        ),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(error).toMatchObject({
      kind: "permanent",
      oauthCode: "invalid_grant",
    })
    expect(isRetryableAuthError(error)).toBe(false)
    expect(String(error)).not.toContain(secret)
  })

  test("classifies transient server failures as retryable", async () => {
    const error = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          new Response("temporarily unavailable", { status: 503 }),
        ),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(isRetryableAuthError(error)).toBe(true)
  })

  test("classifies an HTTP 200 OAuth server_error payload as retryable", async () => {
    const error: unknown = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          Response.json({ error: "server_error" }, { status: 200 }),
        ),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(error).toMatchObject({
      kind: "retryable",
      oauthCode: "server_error",
    })
  })

  test("keeps the existing refresh token when a refresh response omits rotation", async () => {
    const refreshed = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            access_token: "new-access-token",
            expires_in: 3_600,
          }),
        ),
    })

    expect(refreshed).toMatchObject({
      accessToken: "new-access-token",
      refreshToken: credentials.refreshToken,
    })
  })

  test("preserves a rotated refresh token when the new access token cannot be decoded", async () => {
    const order: Array<string> = []
    const refreshed = await refreshCodexCredentials(credentials, {
      fetch: () =>
        Promise.resolve(
          Response.json({
            access_token: "opaque-new-access-token",
            expires_in: 3_600,
            refresh_token: "rotated-refresh-token",
          }),
        ),
      onRotatedCredentials: (rotated) => {
        order.push(`durable:${rotated.refreshToken}`)
      },
    })
    order.push("returned")

    expect(refreshed).toMatchObject({
      accessToken: "opaque-new-access-token",
      accountId: credentials.accountId,
      refreshToken: "rotated-refresh-token",
    })
    expect(order).toEqual(["durable:rotated-refresh-token", "returned"])
  })
})
