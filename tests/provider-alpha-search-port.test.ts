import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { state } from "../src/lib/state"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import { getAlphaSearchFetchBody } from "../src/services/codex/alpha-search"
import {
  createProviderAlphaSearchPort,
  resolveProviderAlphaSearchUrl,
  type ProviderAlphaSearchPort,
} from "../src/services/providers/provider-alpha-search-port"

const originalFetch = globalThis.fetch
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

const genericConfig: ResolvedProviderConfig = {
  apiKey: "generic-provider-secret",
  authType: "x-api-key",
  baseUrl: "https://search.example/api",
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
  createPort: () => ProviderAlphaSearchPort
  expectedAccountId: string | null
  expectedAuthorization: string | null
  expectedCookie: string | null
  expectedProviderApiKey: string | null
  expectedUrl: string
  name: string
}

const exactQuery = "?q=a%2Fb&q=%2f&space=+&empty=&flag&unicode=%E4%B8%AD"

const fixtures: ReadonlyArray<AdapterFixture> = [
  {
    createPort: () => createProviderAlphaSearchPort(genericConfig),
    expectedAccountId: null,
    expectedAuthorization: null,
    expectedCookie: null,
    expectedProviderApiKey: "generic-provider-secret",
    expectedUrl: `https://search.example/api/v1/alpha/search${exactQuery}`,
    name: "generic HTTP adapter",
  },
  {
    createPort: () => createProviderAlphaSearchPort(codexConfig),
    expectedAccountId: "codex-account",
    expectedAuthorization: "Bearer codex-token",
    expectedCookie: "session=caller-cookie",
    expectedProviderApiKey: null,
    expectedUrl: `https://codex.example/backend-api/codex/alpha/search${exactQuery}`,
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
  responseFactory = () => Response.json({ results: [] })
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
})

test("does not duplicate adapter endpoint suffixes", () => {
  expect(
    resolveProviderAlphaSearchUrl(
      { ...genericConfig, baseUrl: "https://search.example/api/v1" },
      `http://localhost/generic/v1/alpha/search${exactQuery}`,
    ),
  ).toBe(`https://search.example/api/v1/alpha/search${exactQuery}`)
  expect(
    resolveProviderAlphaSearchUrl(
      { ...codexConfig, baseUrl: "https://codex.example/backend-api/codex" },
      `http://localhost/codex/v1/alpha/search${exactQuery}`,
    ),
  ).toBe(`https://codex.example/backend-api/codex/alpha/search${exactQuery}`)
})

test("keeps ordinary request bytes zero-copy at the cross-runtime fetch seam", () => {
  const body = new Uint8Array(new ArrayBuffer(3))
  body.set([1, 2, 3])

  expect(getAlphaSearchFetchBody(body)).toBe(body)
})

for (const fixture of fixtures) {
  describe(fixture.name, () => {
    test("preserves exact query and JSON bytes while replacing caller auth", async () => {
      const exactRequestBody =
        '{\n  "model": "gpt-search", "duplicate": 1, "duplicate": 2,\n  "large": 9007199254740993\n}\n'
      const exactResponseBody =
        '{"results":[{"title":"exact"}],"large":9007199254740993}\n'
      responseFactory = () =>
        new Response(exactResponseBody, {
          headers: {
            connection: "keep-alive",
            "content-length": "999",
            "content-type": "application/json",
            "retry-after": "9",
            "set-cookie": "upstream-private=1",
            "x-request-id": "alpha-request",
          },
          status: 207,
          statusText: "Multi-Status upstream",
        })

      const dispatched = await fixture.createPort().dispatch({
        body: new TextEncoder().encode(exactRequestBody),
        requestHeaders: new Headers({
          accept: "application/search+json",
          authorization: "Bearer caller-secret",
          cookie: "session=caller-cookie",
          "content-type": "application/json; charset=utf-8",
          "user-agent": "alpha-search-test",
          "x-api-key": "caller-api-key",
          "x-client-header": "codex-only-forwarded",
        }),
        requestUrl: `http://localhost/generic/v1/alpha/search${exactQuery}`,
      })

      expect(capturedUrl).toBe(fixture.expectedUrl)
      expect(capturedInit?.method).toBe("POST")
      expect(new TextDecoder().decode(capturedInit?.body as Uint8Array)).toBe(
        exactRequestBody,
      )
      const upstreamHeaders = new Headers(capturedInit?.headers)
      expect(upstreamHeaders.get("authorization")).toBe(
        fixture.expectedAuthorization,
      )
      expect(upstreamHeaders.get("chatgpt-account-id")).toBe(
        fixture.expectedAccountId,
      )
      expect(upstreamHeaders.get("x-api-key")).toBe(
        fixture.expectedProviderApiKey,
      )
      expect(upstreamHeaders.get("cookie")).toBe(fixture.expectedCookie)
      expect(upstreamHeaders.get("accept")).toBe("application/search+json")
      expect(upstreamHeaders.get("content-type")).toBe(
        "application/json; charset=utf-8",
      )

      expect(dispatched.adapter).toBe(
        fixture.name.startsWith("Codex") ? "codex" : "http",
      )
      expect(dispatched.status).toBe(207)
      expect(dispatched.statusText).toBe("Multi-Status upstream")
      expect(dispatched.headers).toMatchObject({
        "content-type": "application/json",
        "retry-after": "9",
        "x-request-id": "alpha-request",
      })
      expect(dispatched.headers).not.toHaveProperty("connection")
      expect(dispatched.headers).not.toHaveProperty("content-length")
      expect(dispatched.headers).not.toHaveProperty("set-cookie")
      expect(Object.isFrozen(dispatched.headers)).toBe(true)
      expect(await dispatched.response.text()).toBe(exactResponseBody)
    })

    test("preserves 4xx and 5xx bodies, statuses, and safe headers", async () => {
      for (const status of [429, 503]) {
        const exactErrorBody = `provider-${status}-body\n`
        responseFactory = () =>
          new Response(exactErrorBody, {
            headers: {
              "content-type": "text/plain",
              "retry-after": "11",
              "set-cookie": "private=1",
              "x-upstream-status": String(status),
            },
            status,
          })

        const dispatched = await fixture.createPort().dispatch({
          body: new TextEncoder().encode("{}"),
          requestHeaders: new Headers(),
          requestUrl: "http://localhost/provider/v1/alpha/search",
        })

        expect(dispatched.status).toBe(status)
        expect(dispatched.response.status).toBe(status)
        expect(dispatched.response.headers.get("retry-after")).toBe("11")
        expect(dispatched.response.headers.get("set-cookie")).toBeNull()
        expect(await dispatched.response.text()).toBe(exactErrorBody)
      }
    })

    test("propagates caller abort to the active upstream request", async () => {
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            capturedInit = init
            const signal = init?.signal
            const rejectFromSignal = () =>
              reject(
                signal?.reason instanceof Error ?
                  signal.reason
                : new Error("Upstream alpha search aborted"),
              )
            if (signal?.aborted) {
              rejectFromSignal()
              return
            }
            signal?.addEventListener("abort", rejectFromSignal, { once: true })
          }),
      )
      const controller = new AbortController()
      const abortReason = new Error("caller stopped alpha search")

      const pending = fixture.createPort().dispatch({
        body: new TextEncoder().encode("{}"),
        requestHeaders: new Headers(),
        requestUrl: "http://localhost/provider/v1/alpha/search",
        signal: controller.signal,
      })
      controller.abort(abortReason)

      expect(pending).rejects.toBe(abortReason)
      await pending.catch(() => {})
      expect((capturedInit?.signal as AbortSignal).aborted).toBe(true)
      expect((capturedInit?.signal as AbortSignal).reason).toBe(abortReason)
    })

    test("cancels an upstream body when the caller aborts after headers", async () => {
      let bodyCancelReason: unknown
      responseFactory = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => {}),
            cancel: (reason) => {
              bodyCancelReason = reason
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      const controller = new AbortController()
      const abortReason = new Error("caller disconnected after headers")
      const dispatched = await fixture.createPort().dispatch({
        body: new TextEncoder().encode("{}"),
        requestHeaders: new Headers(),
        requestUrl: "http://localhost/provider/v1/alpha/search",
        signal: controller.signal,
      })

      const pendingBody = dispatched.response.text()
      controller.abort(abortReason)

      let bodyError: unknown
      try {
        await pendingBody
      } catch (error) {
        bodyError = error
      }
      expect(bodyError).toBe(abortReason)
      expect(bodyCancelReason).toBe(abortReason)
    })

    test("applies the shared HTTP headers timeout", async () => {
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            const rejectFromSignal = () =>
              reject(
                signal?.reason instanceof Error ?
                  signal.reason
                : new Error("Upstream alpha search aborted"),
              )
            if (signal?.aborted) {
              rejectFromSignal()
              return
            }
            signal?.addEventListener("abort", rejectFromSignal, { once: true })
          }),
      )

      let caught: unknown
      try {
        await fixture.createPort().dispatch({
          body: new TextEncoder().encode("{}"),
          requestHeaders: new Headers(),
          requestUrl: "http://localhost/provider/v1/alpha/search",
          timeouts: { httpHeadersMs: 5 },
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(UpstreamLifecycleTimeoutError)
      expect((caught as UpstreamLifecycleTimeoutError).phase).toBe(
        "HTTP headers",
      )
    })
  })
}
