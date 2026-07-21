import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import {
  getConfig,
  type AppConfig,
  type ResolvedProviderConfig,
} from "../src/lib/config"
import { createProviderResolver } from "../src/lib/provider-resolver"
import { createAuthMiddleware } from "../src/lib/request-auth"
import { handleResponses } from "../src/routes/responses/handler"
import { createResponsesRoutes } from "../src/routes/responses/route"
import { createProviderModelRouter } from "../src/routes/provider/model-router"
import { createProviderResponsesHandler } from "../src/routes/provider/responses/handler"
import { createProviderResponsesRoutes } from "../src/routes/provider/responses/route"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
const recordUsage = mock(() => "accepted" as const)

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

const parseJsonRequestBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    throw new TypeError("Expected a JSON string request body")
  }
  return JSON.parse(body) as unknown
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const payload = parseJsonRequestBody(init?.body) as { model: string }
  return Promise.resolve(
    new Response(JSON.stringify(createResponsesResult(payload.model)), {
      headers: {
        "content-type": "application/json",
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

  test("streams provider Responses events through the public route", async () => {
    const completed = createResponsesResult("gpt-test")
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":0,"delta":"hello"}',
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: completed })}`,
            "",
          ].join("\n\n"),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    )

    const response = await requestProviderResponses(
      "/openai/v1/responses",
      { input: "hello", model: "gpt-test", stream: true },
      { accept: "text/event-stream" },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith(
      "text/event-stream",
    )
    const body = await response.text()
    expect(body).toContain("event: response.output_text.delta")
    expect(body).toContain('"delta":"hello"')
    expect(body).toContain("event: response.completed")
    expect(body).not.toContain("event: error")
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
              headers: { "retry-after": "4" },
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
      { outcome: "failed", terminal: "error" },
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
      { outcome: "failed", terminal: "response.failed" },
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
