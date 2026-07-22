import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { state } from "../src/lib/state"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import { createAlphaSearchRoutes } from "../src/routes/alpha-search/route"
import { server } from "../src/server"

const originalFetch = globalThis.fetch
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

const genericConfig: ResolvedProviderConfig = {
  apiKey: "provider-key",
  authType: "authorization",
  baseUrl: "https://search.example/api",
  name: "generic",
  type: "openai-responses",
}

const codexConfig: ResolvedProviderConfig = {
  apiKey: "unused-config-key",
  authType: "oauth2",
  baseUrl: "https://codex.example/backend-api",
  name: "codex",
  type: "openai-responses",
}

const wrongTypeConfig: ResolvedProviderConfig = {
  apiKey: "provider-key",
  authType: "x-api-key",
  baseUrl: "https://anthropic.example/api",
  name: "wrong-type",
  type: "anthropic",
}

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
let responseFactory: () => Response

const fetchMock = mock(
  (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(responseFactory()),
)
const diagnosticMock = mock(
  (
    _logger: unknown,
    _level: "debug" | "error" | "info" | "warn",
    _event: string,
    _fields?: Record<string, boolean | null | number | string | undefined>,
  ) => {},
)

const createApp = (): Hono => {
  const routes = createAlphaSearchRoutes({
    logDiagnosticEvent: diagnosticMock,
    resolveProviderConfig: (provider) =>
      Promise.resolve(providerConfigs[provider] ?? null),
  })
  const app = new Hono()
  app.route("/alpha/search", routes)
  app.route("/v1/alpha/search", routes)
  app.route("/:provider/v1/alpha/search", routes)
  return app
}

beforeEach(() => {
  providerConfigs = {
    codex: codexConfig,
    generic: genericConfig,
    "wrong-type": wrongTypeConfig,
  }
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  responseFactory = () =>
    new Response('{"results":[]}\n', {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  fetchMock.mockClear()
  diagnosticMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
})

describe("provider alpha search routing", () => {
  test("registers the provider route only under v1", () => {
    const postPaths = new Set(
      server.routes
        .filter((route) => route.method === "POST")
        .map((route) => route.path),
    )

    expect(postPaths.has("/:provider/v1/alpha/search")).toBe(true)
    expect(postPaths.has("/:provider/alpha/search")).toBe(false)
  })

  test("exposes only the versioned provider POST route", async () => {
    const versioned = await createApp().request(
      "/generic/v1/alpha/search?q=typescript",
      {
        body: '{ "model": "gpt-search" }',
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )
    expect(versioned.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://search.example/api/v1/alpha/search?q=typescript",
    )

    fetchMock.mockClear()
    const unversioned = await createApp().request(
      "/generic/alpha/search?q=typescript",
      { body: "{}", method: "POST" },
    )
    expect(unversioned.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()

    const get = await createApp().request(
      "/generic/v1/alpha/search?q=typescript",
    )
    expect(get.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("keeps the existing Codex aliases as compatibility routes", async () => {
    for (const path of ["/alpha/search?q=legacy", "/v1/alpha/search?q=v1"]) {
      fetchMock.mockClear()
      const response = await createApp().request(path, {
        body: "{}",
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const query = new URL(`http://localhost${path}`).search
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `https://codex.example/backend-api/codex/alpha/search${query}`,
      )
    }
  })

  test("rejects unknown, disabled, and wrong-type providers before dispatch", async () => {
    for (const provider of ["unknown", "disabled"]) {
      const response = await createApp().request(
        `/${provider}/v1/alpha/search`,
        { body: "{}", method: "POST" },
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      })
    }

    const wrongType = await createApp().request("/wrong-type/v1/alpha/search", {
      body: "{}",
      method: "POST",
    })
    expect(wrongType.status).toBe(400)
    expect(await wrongType.json()).toEqual({
      error: {
        message:
          "Provider 'wrong-type' does not support the /v1/alpha/search endpoint",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves upstream failures without forwarding unsafe headers", async () => {
    const exactBody = "private upstream search explanation\n"
    responseFactory = () =>
      new Response(exactBody, {
        headers: {
          "content-type": "text/plain",
          "retry-after": "17",
          "set-cookie": "private=1",
          "x-request-id": "search-failure",
        },
        status: 503,
        statusText: "Search unavailable",
      })

    const response = await createApp().request(
      "/generic/v1/alpha/search?q=private-query",
      { body: '{"private":"request-body"}', method: "POST" },
    )

    expect(response.status).toBe(503)
    expect(response.statusText).toBe("Search unavailable")
    expect(response.headers.get("retry-after")).toBe("17")
    expect(response.headers.get("x-request-id")).toBe("search-failure")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.text()).toBe(exactBody)

    const serializedDiagnostics = JSON.stringify(diagnosticMock.mock.calls)
    expect(serializedDiagnostics).not.toContain("private-query")
    expect(serializedDiagnostics).not.toContain("request-body")
    expect(serializedDiagnostics).not.toContain("upstream search explanation")
    expect(serializedDiagnostics).toContain("alpha_search.upstream_response")
  })

  test("maps transport failures to content-safe diagnostics", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.reject(
        new Error(
          "transport failed for q=private-query with private-request-body",
        ),
      ),
    )

    const response = await createApp().request(
      "/generic/v1/alpha/search?q=private-query",
      { body: '{"private":"request-body"}', method: "POST" },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        code: "upstream_request_failed",
        message: "Alpha search upstream request failed.",
        type: "upstream_error",
      },
    })
    const serializedDiagnostics = JSON.stringify(diagnosticMock.mock.calls)
    expect(serializedDiagnostics).not.toContain("private-query")
    expect(serializedDiagnostics).not.toContain("private-request-body")
    expect(serializedDiagnostics).toContain("alpha_search.upstream_error")
    expect(serializedDiagnostics).toContain("transport_error")
    expect(diagnosticMock.mock.calls.at(-1)?.[1]).toBe("error")
  })

  test("maps shared lifecycle timeouts without exposing the phase details", async () => {
    const timeoutRoutes = createAlphaSearchRoutes({
      createProviderAlphaSearchPort: () => ({
        adapter: "http",
        dispatch: () =>
          Promise.reject(
            new UpstreamLifecycleTimeoutError("private phase", 12_345),
          ),
      }),
      logDiagnosticEvent: diagnosticMock,
      resolveProviderConfig: (provider) =>
        Promise.resolve(providerConfigs[provider] ?? null),
    })
    const app = new Hono()
    app.route("/:provider/v1/alpha/search", timeoutRoutes)

    const response = await app.request("/generic/v1/alpha/search", {
      body: "{}",
      method: "POST",
    })

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: {
        code: "upstream_timeout",
        message: "Alpha search upstream timed out.",
        type: "upstream_error",
      },
    })
    expect(JSON.stringify(diagnosticMock.mock.calls)).not.toContain(
      "private phase",
    )
    expect(diagnosticMock.mock.calls.at(-1)?.[1]).toBe("warn")
  })

  test("records caller abort as debug instead of an upstream failure", async () => {
    const controller = new AbortController()
    const abortReason = new Error("caller disconnected")
    const abortedRoutes = createAlphaSearchRoutes({
      createProviderAlphaSearchPort: () => ({
        adapter: "http",
        dispatch: () => {
          controller.abort(abortReason)
          return Promise.reject(abortReason)
        },
      }),
      logDiagnosticEvent: diagnosticMock,
      resolveProviderConfig: (provider) =>
        Promise.resolve(providerConfigs[provider] ?? null),
    })
    const app = new Hono()
    app.route("/:provider/v1/alpha/search", abortedRoutes)

    await app.request(
      new Request("http://localhost/generic/v1/alpha/search", {
        body: "{}",
        method: "POST",
        signal: controller.signal,
      }),
    )

    expect(diagnosticMock.mock.calls.at(-1)?.[1]).toBe("debug")
    expect(diagnosticMock.mock.calls.at(-1)?.[2]).toBe(
      "alpha_search.upstream_error",
    )
    expect(diagnosticMock.mock.calls.at(-1)?.[3]).toMatchObject({
      failure: "caller_abort",
    })
  })
})
