import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { AnthropicResponse } from "../src/routes/messages/anthropic-types"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

const actualConfigModule = await import("../src/lib/config")
const actualModelsModule = await import("../src/lib/models")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualStateModule = await import("../src/lib/state")
const actualTokenModule = await import("../src/lib/token")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
let messageApiWebSearchModel: string | undefined

const noopTokenUsageRecorder = () => {}
const checkRateLimit = mock(async () => {})
const findEndpointModel = mock((model: string) => ({
  id: model,
  supported_endpoints: ["/v1/messages"],
}))

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getMessageApiWebSearchModel: () => messageApiWebSearchModel,
  getProviderConfig: (name: string) => providerConfigs[name] ?? null,
  isResponsesApiWebSearchEnabled: () => true,
  isResponsesApiWebSocketEnabled: () => false,
  resolveMappedModel: (model: string) => model,
}))

await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))

await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit,
}))

await mock.module("~/lib/state", () => ({
  ...actualStateModule,
  state: {
    ...actualStateModule.state,
    manualApprove: false,
    tokenBasedBilling: true,
    verbose: false,
  },
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { providerMessageRoutes } = await import(
  "../src/routes/provider/messages/route"
)
const { messageRoutes } = await import("../src/routes/messages/route")
const { state } = await import("../src/lib/state")

const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

const makeResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult =>
  ({
    id: "resp_provider_search",
    object: "response",
    created_at: 0,
    model: "gpt-search",
    output: [
      { type: "web_search_call", action: { query: "node lts version" } },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Node.js 24 is the latest LTS.",
            annotations: [
              {
                type: "url_citation",
                url: "https://nodejs.org",
                title: "Node.js",
              },
            ],
          },
        ],
      },
    ],
    output_text: "",
    status: "completed",
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: null,
    tools: [],
    top_p: null,
    ...overrides,
  }) as unknown as ResponsesResult

const makeChatCompletionResponse = () => ({
  id: "chatcmpl-web-search-stripped",
  object: "chat.completion",
  created: 0,
  model: "qwen-plus",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "answer text",
      },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
  },
})

const makeResponsesStreamResponse = (body: ResponsesResult) =>
  new Response(
    [
      "event: response.created",
      `data: ${JSON.stringify({
        response: {
          ...body,
          output: [],
          output_text: "",
          usage: null,
        },
        sequence_number: 1,
        type: "response.created",
      })}`,
      "",
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item: body.output[0],
        output_index: 0,
        sequence_number: 2,
        type: "response.output_item.done",
      })}`,
      "",
      "event: response.output_item.added",
      `data: ${JSON.stringify({
        item: {
          id: "msg-1",
          role: "assistant",
          status: "in_progress",
          type: "message",
        },
        output_index: 1,
        sequence_number: 3,
        type: "response.output_item.added",
      })}`,
      "",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({
        content_index: 0,
        delta: "Node.js 24 is the latest LTS.",
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 4,
        type: "response.output_text.delta",
      })}`,
      "",
      "event: response.output_text.annotation.added",
      `data: ${JSON.stringify({
        annotation: {
          title: "Node.js",
          type: "url_citation",
          url: "https://nodejs.org",
        },
        annotation_index: 0,
        content_index: 0,
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 5,
        type: "response.output_text.annotation.added",
      })}`,
      "",
      "event: response.output_text.done",
      `data: ${JSON.stringify({
        content_index: 0,
        item_id: "msg-1",
        output_index: 1,
        sequence_number: 6,
        text: "Node.js 24 is the latest LTS.",
        type: "response.output_text.done",
      })}`,
      "",
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item: body.output[1],
        output_index: 1,
        sequence_number: 7,
        type: "response.output_item.done",
      })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({
        response: {
          ...body,
          output: [],
          output_text: "",
        },
        sequence_number: 8,
        type: "response.completed",
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  )

const originalFetch = globalThis.fetch

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const urlString =
    typeof url === "string" ? url
    : url instanceof URL ? url.href
    : url.url
  const requestPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as { stream?: boolean })
    : {}

  if (urlString.endsWith("/v1/chat/completions")) {
    return Promise.resolve(
      new Response(JSON.stringify(makeChatCompletionResponse()), {
        headers: { "content-type": "application/json" },
      }),
    )
  }

  const body = makeResponsesResult()

  if (
    (urlString.endsWith("/v1/responses")
      || urlString.endsWith("/codex/responses"))
    && requestPayload.stream === true
  ) {
    return Promise.resolve(makeResponsesStreamResponse(body))
  }

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  )
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
  allowed_domains: ["nodejs.org"],
  user_location: {
    type: "approximate",
    country: "US",
  },
}

beforeEach(() => {
  providerConfigs = {
    search: {
      name: "search",
      type: "openai-responses",
      baseUrl: "https://provider.example",
      apiKey: "provider-key",
      authType: "authorization",
      models: {
        "gpt-search": {
          toolContentSupportType: [],
        },
      },
    },
  }
  state.codexAccessToken = "codex-token"
  state.codexAccountId = "codex-account"
  messageApiWebSearchModel = undefined
  checkRateLimit.mockClear()
  findEndpointModel.mockClear()
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  providerConfigs = {}
  messageApiWebSearchModel = undefined
})

describe("provider messages web_search", () => {
  test("routes top-level Copilot messages web_search to provider/model", async () => {
    messageApiWebSearchModel = "search/gpt-search"

    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "claude-sonnet-4.5",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(checkRateLimit).toHaveBeenCalledTimes(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      stream?: boolean
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("runs pure Anthropic web_search through an openai-responses provider", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
      stream?: boolean
      tool_choice?: unknown
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.tool_choice).toBeUndefined()
    expect(upstreamBody.tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["nodejs.org"],
        },
        user_location: {
          type: "approximate",
          country: "US",
        },
      },
    ])

    const json = (await response.json()) as AnthropicResponse
    expect(json.model).toBe("gpt-search")
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(json.usage).toMatchObject({
      input_tokens: 12,
      output_tokens: 7,
      server_tool_use: {
        web_search_requests: 1,
      },
    })
  })

  test("runs codex web_search through streaming Responses", async () => {
    providerConfigs.codex = {
      name: "codex",
      type: "openai-responses",
      baseUrl: "https://codex.example/backend-api",
      apiKey: "unused",
      authType: "authorization",
      models: {
        "gpt-search": {
          toolContentSupportType: [],
        },
      },
    }

    const app = createApp()
    const response = await app.request("/codex/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://codex.example/backend-api/codex/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const upstreamHeaders = new Headers((init as RequestInit).headers)
    expect(upstreamHeaders.get("accept")).toBe("text/event-stream")

    const json = (await response.json()) as AnthropicResponse
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("streams synthetic Anthropic events after parsing upstream Responses stream", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "What is the Node.js LTS?" }],
        model: "gpt-search",
        stream: true,
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_start")
    expect(text).toContain("server_tool_use")
    expect(text).toContain("web_search_tool_result")
    expect(text).toContain("Node.js 24 is the latest LTS.")
    expect(text).toContain("event: message_stop")
  })

  test("strips Anthropic web_search when mixed with normal tools", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
        tools: [
          webSearchTool,
          {
            name: "get_weather",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
  })

  test("strips Anthropic web_search before OpenAI-compatible translation", async () => {
    providerConfigs.search = {
      ...providerConfigs.search,
      type: "openai-compatible",
      baseUrl: "https://provider.example/compatible-mode",
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://provider.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([])
  })
})
