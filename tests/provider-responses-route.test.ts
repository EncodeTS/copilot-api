import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import {
  getConfig,
  type AppConfig,
  type ResolvedProviderConfig,
} from "../src/lib/config"
import { createProviderResolver } from "../src/lib/provider-resolver"
import { createAuthMiddleware } from "../src/lib/request-auth"
import type { TokenUsageRecorder } from "../src/lib/token-usage"
import { handleResponses } from "../src/routes/responses/handler"
import { createResponsesRoutes } from "../src/routes/responses/route"
import { createProviderModelRouter } from "../src/routes/provider/model-router"
import { createProviderResponsesHandler } from "../src/routes/provider/responses/handler"
import { createProviderResponsesRoutes } from "../src/routes/provider/responses/route"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
const recordTokenUsage: TokenUsageRecorder = () => "accepted"
const recordUsage = mock(recordTokenUsage)

const originalFetch = globalThis.fetch
const config = getConfig()
const isolatedConfigKeys = [
  "auth",
  "contextManagement",
  "modelMappings",
  "modelResponsesApiCompactThresholds",
  "providers",
  "useResponsesApiWebSearch",
] as const satisfies ReadonlyArray<keyof AppConfig>
const originalConfigFields = isolatedConfigKeys.map((key) => ({
  hadOwnProperty: Object.hasOwn(config, key),
  key,
  value: config[key],
}))

const restoreConfigFields = (): void => {
  for (const { hadOwnProperty, key, value } of originalConfigFields) {
    if (hadOwnProperty) {
      Object.assign(config, { [key]: value })
    } else {
      Reflect.deleteProperty(config, key)
    }
  }
}

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 1_784_000_000,
  error: null,
  id: "resp-provider-route",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "provider answer",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const createPrefetchedTerminalStreamBody = (
  terminal: Record<string, unknown>,
): string =>
  [`event: ${String(terminal.type)}\ndata: ${JSON.stringify(terminal)}`].join(
    "\n\n",
  ) + "\n\n"

const parseJsonRequestBody = (body: unknown): unknown => {
  const serialized =
    typeof body === "string" ? body
    : body instanceof Uint8Array ? new TextDecoder().decode(body)
    : body instanceof ArrayBuffer ? new TextDecoder().decode(body)
    : undefined
  if (serialized === undefined) {
    throw new TypeError("Expected a JSON string request body")
  }
  return JSON.parse(serialized) as unknown
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const payload = parseJsonRequestBody(init?.body) as { model: string }
  return Promise.resolve(
    new Response(JSON.stringify(createResponsesResult(payload.model)), {
      headers: {
        "content-type": "application/json",
        "set-cookie": "upstream_session=private",
        "x-upstream": "responses-provider",
      },
      status: 201,
    }),
  )
})

const requestProviderResponses = (
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  createApp().request(path, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-api-key": "gateway-key",
      ...headers,
    },
    method: "POST",
  })

const createApp = (): Hono => {
  const providerResolver = createProviderResolver({
    getProviderConfig: (provider) => providerConfigs[provider] ?? null,
    getRawProviderConfig: (provider) => providerConfigs[provider] ?? null,
  })
  const providerResponses = createProviderResponsesHandler({
    createProviderTokenUsageRecorder: () => recordUsage,
    resolveProviderModel: providerResolver.resolveModel,
  })
  const providerModelRouter = createProviderModelRouter({
    handleProviderResponsesForProvider: providerResponses.handleForProvider,
  })
  const app = new Hono()
  app.use("*", createAuthMiddleware())
  app.route(
    "/v1/responses",
    createResponsesRoutes({
      responses: (c) => handleResponses(c, { providerModelRouter }),
    }),
  )
  app.route(
    "/:provider/v1/responses",
    createProviderResponsesRoutes({ responses: providerResponses }),
  )
  return app
}

beforeEach(() => {
  providerConfigs = {
    openai: {
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://responses.example",
      models: {
        "gpt-test": {},
      },
      name: "openai",
      type: "openai-responses",
    },
  }
  Object.assign(config, {
    auth: { apiKeys: ["gateway-key"] },
    contextManagement: { messages: false, responses: false },
    modelMappings: {},
    modelResponsesApiCompactThresholds: {},
    providers: providerConfigs,
    useResponsesApiWebSearch: true,
  })
  fetchMock.mockClear()
  recordUsage.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  restoreConfigFields()
  providerConfigs = {}
})

describe("versioned provider Responses route", () => {
  test("requires the gateway API key before forwarding", async () => {
    const response = await createApp().request("/openai/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards a non-streaming request to the named Responses provider", async () => {
    const payload = {
      input: "hello",
      max_output_tokens: 128,
      model: "gpt-test",
    }
    const response = await requestProviderResponses(
      "/openai/v1/responses",
      payload,
      { "user-agent": "provider-route-test" },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("x-upstream")).toBe("responses-provider")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.json()).toEqual(createResponsesResult("gpt-test"))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://responses.example/v1/responses")
    expect(parseJsonRequestBody((init as RequestInit).body)).toEqual(payload)
    expect(new Headers((init as RequestInit).headers)).toEqual(
      new Headers({
        accept: "application/json",
        authorization: "Bearer provider-key",
        "content-type": "application/json",
        "user-agent": "provider-route-test",
      }),
    )
  })

  test("records a non-streaming incomplete provider response as incomplete", async () => {
    const incomplete = {
      ...createResponsesResult("gpt-test"),
      incomplete_details: { reason: "max_output_tokens" as const },
      status: "incomplete",
      usage: {
        input_tokens: 9,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        total_tokens: 12,
      },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(incomplete)),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(200)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      {
        cache_read_input_tokens: 2,
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 12,
      },
      {
        errorCode: "max_output_tokens",
        outcome: "incomplete",
        terminal: "response.incomplete",
      },
    )
  })

  test("records a non-streaming cancelled provider response as aborted", async () => {
    const cancelled = {
      ...createResponsesResult("gpt-test"),
      status: "cancelled",
      usage: {
        input_tokens: 4,
        output_tokens: 1,
        total_tokens: 5,
      },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(cancelled)),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(200)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      {
        cache_read_input_tokens: 0,
        input_tokens: 4,
        output_tokens: 1,
        total_tokens: 5,
      },
      {
        errorCode: "aborted",
        outcome: "aborted",
        terminal: "aborted",
      },
    )
  })

  test("sanitizes a failed non-stream provider response error code", async () => {
    const failed = {
      ...createResponsesResult("gpt-test"),
      error: {
        code: "private-provider-account-code",
        message: "private provider detail",
      },
      status: "failed",
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(failed)),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(200)
    expect(recordUsage.mock.calls[0]?.[1]).toEqual({
      errorCode: "response_failed",
      outcome: "failed",
      terminal: "response.failed",
    })
    expect(JSON.stringify(recordUsage.mock.calls)).not.toContain(
      "private-provider-account-code",
    )
  })

  test("does not resolve prototype keys as provider error-code aliases", async () => {
    const failed = {
      ...createResponsesResult("gpt-test"),
      error: { code: "constructor", message: "upstream failed" },
      status: "failed",
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(failed)),
    )

    await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(recordUsage.mock.calls[0]?.[1]).toEqual({
      errorCode: "response_failed",
      outcome: "failed",
      terminal: "response.failed",
    })
  })

  test("rejects an unknown non-stream provider status in usage metadata", async () => {
    const inProgress = {
      ...createResponsesResult("gpt-test"),
      status: "in_progress",
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json(inProgress)),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(200)
    expect(recordUsage.mock.calls[0]?.[1]).toEqual({
      errorCode: "invalid_response",
      outcome: "failed",
      terminal: "unknown_terminal",
    })
  })

  test("preserves direct provider query ordering and raw JSON request bytes", async () => {
    providerConfigs.openai = {
      ...providerConfigs.openai,
      capabilities: { responsesContextManagement: true },
    } as ResolvedProviderConfig
    const rawBody =
      '{\n  "model": "gpt-test",\n  "input": "hello",\n  "duplicate": 1,\n  "duplicate": 2,\n  "unknown_large_integer": 9007199254740993\n}\n'
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json(createResponsesResult("gpt-test"), { status: 201 }),
      ),
    )

    const response = await createApp().request(
      "/openai/v1/responses?mode=exact%2Fwire&repeat=1&repeat=2",
      {
        body: rawBody,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-api-key": "gateway-key",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(201)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://responses.example/v1/responses?mode=exact%2Fwire&repeat=1&repeat=2",
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.body).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(rawBody)
    const upstreamHeaders = new Headers(init.headers)
    expect(upstreamHeaders.get("authorization")).toBe("Bearer provider-key")
    expect(upstreamHeaders.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )
    expect(upstreamHeaders.get("x-api-key")).toBeNull()
  })

  test("preserves exact successful JSON bytes, large integers, and status text", async () => {
    const rawBody = `${JSON.stringify(
      createResponsesResult("gpt-test"),
    ).replace(
      '"usage":null}',
      '"usage":null,"unknown_large_integer":9007199254740993}',
    )}\n`
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(rawBody, {
          headers: {
            "content-type": "application/json; profile=provider-exact",
            "x-request-id": "request-exact-result",
          },
          status: 201,
          statusText: "Created Exactly",
        }),
      ),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(201)
    expect(response.statusText).toBe("Created Exactly")
    expect(response.headers.get("content-type")).toBe(
      "application/json; profile=provider-exact",
    )
    expect(response.headers.get("x-request-id")).toBe("request-exact-result")
    expect(await response.text()).toBe(rawBody)
  })

  test("streams provider Responses events through the public route", async () => {
    const encoder = new TextEncoder()
    let upstreamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined
    const completed = createResponsesResult("gpt-test")
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller
              controller.enqueue(
                encoder.encode(
                  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":0,"delta":"hello"}\n\n',
                ),
              )
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "set-cookie": "stream_private=1",
              "x-ratelimit-remaining": "41",
              "x-request-id": "request-stream-live",
            },
            status: 202,
            statusText: "Accepted Exactly",
          },
        ),
      ),
    )

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(202)
    expect(response.statusText).toBe("Accepted Exactly")
    expect(response.headers.get("content-type")).toStartWith(
      "text/event-stream",
    )
    expect(response.headers.get("x-request-id")).toBe("request-stream-live")
    expect(response.headers.get("x-ratelimit-remaining")).toBe("41")
    expect(response.headers.get("set-cookie")).toBeNull()
    if (!upstreamController) {
      throw new Error("Missing upstream stream controller")
    }
    upstreamController.enqueue(
      encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: completed })}\n\n`,
      ),
    )
    upstreamController.close()
    const body = await response.text()
    expect(body).toContain("event: response.output_text.delta")
    expect(body).toContain('"delta":"hello"')
    expect(body).toContain("event: response.completed")
    expect(body).not.toContain("event: error")
  })

  test("preserves a JSON success when a requested stream falls back to a result", async () => {
    fetchMock.mockImplementationOnce((_url, init) => {
      const payload = parseJsonRequestBody(init?.body) as { model: string }
      return Promise.resolve(
        new Response(JSON.stringify(createResponsesResult(payload.model)), {
          headers: {
            "content-type": "application/json",
            "x-upstream-mode": "buffered",
          },
          status: 202,
        }),
      )
    })

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(202)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-upstream-mode")).toBe("buffered")
    expect(await response.json()).toEqual(createResponsesResult("gpt-test"))
  })

  test("releases the provider transport after a typed stream terminal", async () => {
    const encoder = new TextEncoder()
    let upstreamSignal: AbortSignal | null = null
    let cancelCount = 0
    const completed = {
      ...createResponsesResult("gpt-test"),
      usage: {
        input_tokens: 8,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        total_tokens: 11,
      },
    }
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  createPrefetchedTerminalStreamBody({
                    copilot_usage: { total_nano_aiu: 77 },
                    response: completed,
                    sequence_number: 1,
                    type: "response.completed",
                  }),
                ),
              )
            },
            cancel() {
              cancelCount += 1
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream; upstream=ignored",
              "x-request-id": "request-stream-prefetched",
              "x-upstream-safe": "prefetched",
            },
            status: 201,
          },
        ),
      )
    })

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toStartWith(
      "text/event-stream",
    )
    expect(response.headers.get("content-type")).not.toContain(
      "upstream=ignored",
    )
    expect(response.headers.get("x-request-id")).toBe(
      "request-stream-prefetched",
    )
    expect(response.headers.get("x-upstream-safe")).toBe("prefetched")
    expect(recordUsage).not.toHaveBeenCalled()
    expect(await response.text()).toContain("event: response.completed")
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      {
        cache_read_input_tokens: 2,
        input_tokens: 6,
        output_tokens: 3,
        total_nano_aiu: 77,
        total_tokens: 11,
      },
      { outcome: "completed", terminal: "response.completed" },
    )
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(cancelCount).toBe(1)
  })

  test("records settled prefetch cancellation as a delivery failure", async () => {
    const completed = {
      ...createResponsesResult("gpt-test"),
      usage: {
        input_tokens: 8,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        total_tokens: 11,
      },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          createPrefetchedTerminalStreamBody({
            copilot_usage: { total_nano_aiu: 78 },
            response: completed,
            sequence_number: 1,
            type: "response.completed",
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )
    const recorded = Promise.withResolvers<{
      metadata: Parameters<TokenUsageRecorder>[1]
      usage: Parameters<TokenUsageRecorder>[0]
    }>()
    recordUsage.mockImplementationOnce((usage, metadata) => {
      recorded.resolve({ metadata, usage })
      return "accepted"
    })

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(recordUsage).not.toHaveBeenCalled()
    await response.body?.cancel(new Error("synthetic downstream cancellation"))
    expect(await recorded.promise).toEqual({
      metadata: {
        errorCode: "connection_error",
        outcome: "transport_error",
        terminal: "response.completed",
      },
      usage: {
        cache_read_input_tokens: 2,
        input_tokens: 6,
        output_tokens: 3,
        total_nano_aiu: 78,
        total_tokens: 11,
      },
    })
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })

  test("projects a first-frame provider error only after session usage and cancellation", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            `event: error\ndata: ${JSON.stringify({
              code: "rate_limit_exceeded",
              copilot_usage: { total_nano_aiu: 77 },
              error: {
                code: "rate_limit_exceeded",
                message: "slow down",
                type: "requests",
              },
              headers: {
                "retry-after": "4",
                "set-cookie": "terminal_private=1",
                "x-terminal-safe": "preserved",
              },
              message: "slow down",
              sequence_number: 1,
              status_code: 429,
              type: "error",
              usage: {
                input_tokens: 8,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens: 2,
                total_tokens: 10,
              },
            })}`,
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("4")
    expect(response.headers.get("x-terminal-safe")).toBe("preserved")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "slow down",
        type: "requests",
      },
    })
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      {
        cache_read_input_tokens: 3,
        input_tokens: 5,
        output_tokens: 2,
        total_nano_aiu: 77,
        total_tokens: 10,
      },
      {
        errorCode: "rate_limited",
        outcome: "failed",
        terminal: "error",
      },
    )
  })

  test("records a first-frame failed terminal once before relaying it", async () => {
    const failed = {
      ...createResponsesResult("gpt-test"),
      error: { code: "upstream_error", message: "generation failed" },
      status: "failed",
      usage: {
        input_tokens: 6,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens: 2,
        total_tokens: 8,
      },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          `event: response.failed\ndata: ${JSON.stringify({
            copilot_usage: { total_nano_aiu: 45 },
            response: failed,
            sequence_number: 1,
            type: "response.failed",
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    )

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("event: response.failed")
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      {
        cache_read_input_tokens: 1,
        input_tokens: 5,
        output_tokens: 2,
        total_nano_aiu: 45,
        total_tokens: 8,
      },
      {
        errorCode: "upstream_error",
        outcome: "failed",
        terminal: "response.failed",
      },
    )
  })

  test("rejects an unknown provider without contacting an upstream", async () => {
    const response = await requestProviderResponses("/missing/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'missing' does not support the /v1/responses endpoint",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects providers whose protocol type is not OpenAI Responses", async () => {
    providerConfigs.openai = {
      ...providerConfigs.openai,
      type: "openai-compatible",
    }

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'openai' does not support the /v1/responses endpoint",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards structured upstream errors and retry metadata", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "slow down",
              type: "requests",
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "retry-after": "3",
              "x-request-id": "provider-request",
            },
            status: 429,
          },
        ),
      ),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("3")
    expect(response.headers.get("x-request-id")).toBe("provider-request")
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "slow down",
        type: "requests",
      },
    })
  })

  test("preserves non-JSON upstream errors and only their safe headers", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response("provider teapot", {
          headers: {
            "content-type": "text/plain",
            "set-cookie": "private=1",
            "x-unknown-safe": "preserved",
          },
          status: 418,
        }),
      ),
    )

    const response = await requestProviderResponses("/openai/v1/responses", {
      input: "hello",
      model: "gpt-test",
    })

    expect(response.status).toBe(418)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(response.headers.get("x-unknown-safe")).toBe("preserved")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.text()).toBe("provider teapot")
  })

  test("keeps the root Responses route ahead of the provider route", async () => {
    const response = await requestProviderResponses("/v1/responses", {
      input: "hello",
      model: "openai/gpt-test",
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(createResponsesResult("gpt-test"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not add provider-scoped legacy, alpha-search, or image routes", async () => {
    const paths = [
      "/openai/responses",
      "/openai/v1/alpha/search",
      "/openai/v1/images/generations",
    ]

    for (const path of paths) {
      const response = await requestProviderResponses(path, {
        model: "gpt-test",
      })
      expect(response.status).toBe(404)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
