import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { runResponsesStreamSession } from "../src/lib/responses-stream-session"
import { state } from "../src/lib/state"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import {
  createProviderResponsesPort,
  type ProviderResponsesPort,
} from "../src/services/providers/provider-responses-port"
import { resolveProviderResponsesUrl } from "../src/services/providers/provider-proxy"

const originalFetch = globalThis.fetch
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

const genericConfig: ResolvedProviderConfig = {
  apiKey: "provider-secret",
  authType: "authorization",
  baseUrl: "https://responses.example/api",
  name: "generic",
  type: "openai-responses",
}

const codexConfig: ResolvedProviderConfig = {
  apiKey: "unused-config-secret",
  authType: "oauth2",
  baseUrl: "https://codex.example/backend-api",
  name: "codex",
  type: "openai-responses",
}

interface AdapterFixture {
  createPort: () => ProviderResponsesPort
  expectedAccountId: string | null
  expectedAuthorization: string
  expectedUrl: string
  name: string
}

const fixtures: ReadonlyArray<AdapterFixture> = [
  {
    createPort: () => createProviderResponsesPort(genericConfig),
    expectedAccountId: null,
    expectedAuthorization: "Bearer provider-secret",
    expectedUrl: "https://responses.example/api/v1/responses",
    name: "generic HTTP adapter",
  },
  {
    createPort: () => createProviderResponsesPort(codexConfig),
    expectedAccountId: "codex-account",
    expectedAuthorization: "Bearer codex-token",
    expectedUrl: "https://codex.example/backend-api/codex/responses",
    name: "Codex HTTP adapter",
  },
]

let capturedInit: RequestInit | undefined
let capturedUrl: string | undefined
let responseFactory: () => Response

const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  capturedInit = init
  capturedUrl =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  return Promise.resolve(responseFactory())
})

beforeEach(() => {
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  capturedInit = undefined
  capturedUrl = undefined
  fetchMock.mockClear()
  responseFactory = () => Response.json({})
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
})

describe("generic HTTP exact request forwarding", () => {
  test("preserves query ordering and raw JSON request bytes", async () => {
    const rawBody = new TextEncoder().encode(
      '{\n  "model": "gpt-port",\n  "input": "hello",\n  "duplicate": 1,\n  "duplicate": 2,\n  "unknown_large_integer": 9007199254740993\n}\n',
    )
    responseFactory = () =>
      Response.json({
        id: "resp-exact-request",
        object: "response",
        output: [],
        status: "completed",
      })

    await createProviderResponsesPort(genericConfig).dispatch({
      payload: {
        input: "hello",
        model: "gpt-port",
      },
      rawBody,
      requestHeaders: new Headers({
        "content-type": "application/json; charset=utf-8",
        "x-api-key": "caller-secret",
      }),
      requestUrl:
        "http://localhost/generic/v1/responses?mode=exact%2Fwire&repeat=1&repeat=2",
    })

    expect(capturedUrl).toBe(
      "https://responses.example/api/v1/responses?mode=exact%2Fwire&repeat=1&repeat=2",
    )
    expect(capturedInit?.body).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(capturedInit?.body as Uint8Array)).toBe(
      new TextDecoder().decode(rawBody),
    )
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get("authorization")).toBe("Bearer provider-secret")
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(headers.get("x-api-key")).toBeNull()
  })

  test("does not duplicate an existing Responses endpoint suffix", () => {
    const requestUrl = "http://localhost/generic/v1/responses?mode=exact&empty="
    expect(
      resolveProviderResponsesUrl(
        "https://responses.example/api/v1",
        requestUrl,
      ),
    ).toBe("https://responses.example/api/v1/responses?mode=exact&empty=")
    expect(
      resolveProviderResponsesUrl(
        "https://responses.example/api/v1/responses/",
        requestUrl,
      ),
    ).toBe("https://responses.example/api/v1/responses?mode=exact&empty=")
  })

  test("uses JSON content type when the gateway synthesizes the request body", async () => {
    responseFactory = () =>
      Response.json({
        id: "resp-synthesized-request",
        object: "response",
        output: [],
        status: "completed",
      })

    await createProviderResponsesPort(genericConfig).dispatch({
      payload: { input: "hello", model: "gpt-port" },
      requestHeaders: new Headers({
        "content-type": "application/anthropic+json",
      }),
    })

    expect(typeof capturedInit?.body).toBe("string")
    expect(new Headers(capturedInit?.headers).get("content-type")).toBe(
      "application/json",
    )
  })
})

for (const fixture of fixtures) {
  describe(fixture.name, () => {
    test("dispatches auth and returns unknown result fields with safe response metadata", async () => {
      const exactBody =
        '{"id":"resp-port","object":"response","output":[],"status":"completed","unknown_provider_field":{"preserved":true},"unknown_large_integer":9007199254740993}\n'
      responseFactory = () =>
        new Response(exactBody, {
          headers: {
            connection: "keep-alive",
            "content-length": "999",
            "content-type": "application/json",
            "set-cookie": "upstream_session=private",
            "x-request-id": "request-port",
            "x-unknown-safe": "preserved",
          },
          status: 201,
          statusText: "Created upstream",
        })

      const dispatched = await fixture.createPort().dispatch({
        payload: { input: "hello", model: "gpt-port" },
        requestHeaders: new Headers({
          "user-agent": "port-conformance",
          "x-api-key": "caller-secret",
        }),
        transport: "http",
      })

      expect(dispatched.kind).toBe("result")
      if (dispatched.kind !== "result") return
      expect(dispatched.result).toMatchObject({
        unknown_provider_field: { preserved: true },
      })
      expect(new TextDecoder().decode(dispatched.rawBody)).toBe(exactBody)
      expect(dispatched.status).toBe(201)
      expect(dispatched.statusText).toBe("Created upstream")
      expect(dispatched.headers).toMatchObject({
        "content-type": "application/json",
        "x-request-id": "request-port",
        "x-unknown-safe": "preserved",
      })
      expect(dispatched.headers).not.toHaveProperty("connection")
      expect(dispatched.headers).not.toHaveProperty("content-length")
      expect(dispatched.headers).not.toHaveProperty("set-cookie")
      expect(Object.isFrozen(dispatched.headers)).toBe(true)
      expect(dispatched.transport).toBe("http")

      expect(capturedUrl).toBe(fixture.expectedUrl)
      const headers = new Headers(capturedInit?.headers)
      expect(headers.get("authorization")).toBe(fixture.expectedAuthorization)
      expect(headers.get("chatgpt-account-id")).toBe(fixture.expectedAccountId)
      expect(headers.get("x-api-key")).toBeNull()
      expect((capturedInit?.signal as AbortSignal).aborted).toBe(false)
    })

    test("returns an SSE source and propagates port cancellation to the transport", async () => {
      let bodyCancelCount = 0
      const encoder = new TextEncoder()
      responseFactory = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: response.completed\ndata: ${JSON.stringify({
                    response: {
                      id: "resp-stream",
                      object: "response",
                      output: [],
                      status: "completed",
                      usage: null,
                    },
                    sequence_number: 1,
                    type: "response.completed",
                  })}\n\n`,
                ),
              )
            },
            cancel() {
              bodyCancelCount += 1
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "x-ratelimit-remaining": "27",
              "x-request-id": "request-stream-port",
            },
            status: 202,
          },
        )

      const dispatched = await fixture.createPort().dispatch({
        payload: { input: "hello", model: "gpt-port", stream: true },
        requestHeaders: new Headers(),
        transport: "http",
      })

      expect(dispatched.kind).toBe("stream")
      if (dispatched.kind !== "stream") return
      expect(dispatched.status).toBe(202)
      expect(dispatched.headers).toMatchObject({
        "x-ratelimit-remaining": "27",
        "x-request-id": "request-stream-port",
      })
      const outcome = await runResponsesStreamSession({
        onFrame: (frame) => {
          if (frame.kind === "event") dispatched.observer(frame.event)
          if (frame.kind === "unknown") dispatched.observer(frame.parsed)
        },
        signal: dispatched.signal,
        source: dispatched.source,
      })
      expect(outcome.kind).toBe("completed")

      const cancellationReason = new Error("route finished")
      await dispatched.cancel(cancellationReason)
      await dispatched.cancel(new Error("duplicate cancellation"))
      expect(dispatched.signal.aborted).toBe(true)
      expect(dispatched.signal.reason).toBe(cancellationReason)
      expect((capturedInit?.signal as AbortSignal).aborted).toBe(true)
      expect(bodyCancelCount).toBe(1)
    })

    test("keeps a requested stream when the provider omits content-type", async () => {
      responseFactory = () =>
        new Response(
          `event: response.completed\ndata: ${JSON.stringify({
            response: {
              id: "resp-stream-no-content-type",
              object: "response",
              output: [],
              status: "completed",
              usage: null,
            },
            sequence_number: 1,
            type: "response.completed",
          })}\n\n`,
        )

      const dispatched = await fixture.createPort().dispatch({
        payload: { input: "hello", model: "gpt-port", stream: true },
        requestHeaders: new Headers(),
        transport: "http",
      })

      expect(dispatched.kind).toBe("stream")
      if (dispatched.kind !== "stream") return
      const outcome = await runResponsesStreamSession({
        signal: dispatched.signal,
        source: dispatched.source,
      })
      expect(outcome.kind).toBe("completed")
      await dispatched.cancel(new Error("stream without content-type finished"))
    })

    test("preserves an upstream error body, status, and safe retry headers", async () => {
      responseFactory = () =>
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "slow down",
              provider_extension: { preserved: true },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "retry-after": "7",
              "set-cookie": "private=1",
              "x-request-id": "request-error",
            },
            status: 429,
          },
        )

      const dispatched = await fixture.createPort().dispatch({
        payload: { input: "hello", model: "gpt-port" },
        requestHeaders: new Headers(),
        transport: "http",
      })

      expect(dispatched.kind).toBe("error")
      if (dispatched.kind !== "error") return
      expect(dispatched.status).toBe(429)
      expect(dispatched.headers).toMatchObject({
        "content-type": "application/json",
        "retry-after": "7",
        "x-request-id": "request-error",
      })
      expect(dispatched.headers).not.toHaveProperty("set-cookie")
      expect(dispatched.response.headers.get("set-cookie")).toBeNull()
      expect(await dispatched.response.json()).toEqual({
        error: {
          code: "rate_limit_exceeded",
          message: "slow down",
          provider_extension: { preserved: true },
        },
      })
    })

    test("applies the same bounded HTTP headers timeout", async () => {
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            const rejectFromSignal = () => {
              const reason = (signal as { reason?: unknown } | undefined)
                ?.reason
              reject(
                reason instanceof Error ? reason : (
                  new Error("Upstream request aborted")
                ),
              )
            }
            if (signal?.aborted) {
              rejectFromSignal()
              return
            }
            signal?.addEventListener("abort", rejectFromSignal, { once: true })
          }),
      )

      let timeoutError: unknown
      try {
        await fixture.createPort().dispatch({
          payload: { input: "hello", model: "gpt-port" },
          requestHeaders: new Headers(),
          timeouts: { httpHeadersMs: 5 },
          transport: "http",
        })
      } catch (error) {
        timeoutError = error
      }
      expect(timeoutError).toBeInstanceOf(UpstreamLifecycleTimeoutError)
    })

    test("closes the transport signal when dispatch fails before a source exists", async () => {
      const transportError = new Error("provider socket failed before headers")
      fetchMock.mockImplementationOnce((_input, init) => {
        capturedInit = init
        return Promise.reject(transportError)
      })

      let caught: unknown
      try {
        await fixture.createPort().dispatch({
          payload: { input: "hello", model: "gpt-port" },
          requestHeaders: new Headers(),
          transport: "http",
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBe(transportError)
      expect((capturedInit?.signal as AbortSignal).aborted).toBe(true)
      expect((capturedInit?.signal as { reason?: unknown }).reason).toBe(
        transportError,
      )
    })
  })
}

test("Codex WebSocket dispatch keeps source cancellation and rate-limit observation behind the port", async () => {
  let returnCount = 0
  const observeRateLimit = mock((_event: unknown) => {})
  const chunks = [
    {
      data: JSON.stringify({
        plan_type: "pro",
        rate_limits: {
          allowed: true,
          primary: {
            reset_after_seconds: 60,
            reset_at: 1_784_000_000,
            used_percent: 25,
            window_minutes: 300,
          },
        },
        type: "codex.rate_limits",
      }),
      event: "codex.rate_limits",
    },
    {
      data: JSON.stringify({
        response: {
          id: "resp-websocket",
          object: "response",
          output: [],
          status: "completed",
          usage: null,
        },
        sequence_number: 1,
        type: "response.completed",
      }),
      event: "response.completed",
    },
  ]
  const source = {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: () =>
          Promise.resolve(
            index < chunks.length ?
              { done: false as const, value: chunks[index++] }
            : { done: true as const, value: undefined },
          ),
        return: () => {
          returnCount += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }
  const port = createProviderResponsesPort(codexConfig, {
    dispatchCodexResponses: () =>
      Promise.resolve({
        kind: "stream",
        source,
        transport: "websocket",
      }),
    observeCodexRateLimitsEvent: observeRateLimit,
  })

  const dispatched = await port.dispatch({
    payload: { input: "hello", model: "gpt-port", stream: true },
    requestHeaders: new Headers(),
    transport: "websocket",
  })

  expect(dispatched.kind).toBe("stream")
  if (dispatched.kind !== "stream") return
  expect(dispatched.transport).toBe("websocket")
  expect(dispatched.status).toBe(200)
  expect(dispatched.headers).toEqual({})
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind === "event") dispatched.observer(frame.event)
      if (frame.kind === "unknown") dispatched.observer(frame.parsed)
    },
    signal: dispatched.signal,
    source: dispatched.source,
  })
  expect(outcome.kind).toBe("completed")
  expect(observeRateLimit).toHaveBeenCalledTimes(2)
  expect(observeRateLimit.mock.calls[0]?.[0]).toMatchObject({
    type: "codex.rate_limits",
  })

  await dispatched.cancel(new Error("websocket consumer finished"))
  expect(dispatched.signal.aborted).toBe(true)
  expect(returnCount).toBe(1)
})
