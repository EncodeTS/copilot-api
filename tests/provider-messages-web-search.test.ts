import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { events } from "fetch-event-stream"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { createProviderResolver } from "../src/lib/provider-resolver"
import { fetchWithUpstreamLifecycle } from "../src/lib/upstream-lifecycle"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "../src/routes/messages/anthropic-types"
import { createMessagesHandler } from "../src/routes/messages/handler"
import { createMessageRoutes } from "../src/routes/messages/route"
import { createWebSearchFlow } from "../src/routes/messages/web-search/fulfill"
import { getResponsesTransportForModel } from "../src/routes/responses/utils"
import { createProviderMessagesHandler } from "../src/routes/provider/messages/handler"
import { createProviderMessageRoutes } from "../src/routes/provider/messages/route"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
} from "../src/services/copilot/create-responses"
import type { Model } from "../src/services/copilot/get-models"
import type { CodexProviderCatalogSnapshot } from "../src/services/codex/get-models"
import type { TokenUsageRecorder } from "../src/lib/token-usage"

let providerConfigs: Record<string, ResolvedProviderConfig> = {}
let messageApiWebSearchModel: string | undefined

const recordProviderUsage: TokenUsageRecorder = () => "accepted"
const providerUsageRecorder = mock(recordProviderUsage)
const createProviderUsageRecorder = () => providerUsageRecorder
const findEndpointModel = mock(
  (model: string): Model => ({
    capabilities: {
      family: model,
      limits: {},
      object: "model_capabilities",
      supports: {},
      type: "chat",
    },
    id: model,
    model_picker_enabled: true,
    name: model,
    object: "model",
    supported_endpoints: ["/v1/messages"],
    vendor: "test",
    version: "test",
  }),
)

const codexCatalogSnapshot: CodexProviderCatalogSnapshot = {
  catalog: {
    data: [
      {
        capabilities: {
          family: "gpt-search",
          limits: { max_prompt_tokens: 372_000 },
          object: "model_capabilities",
          supports: {
            reasoning_effort: ["low", "max", "ultra"],
            streaming: true,
            tool_calls: true,
          },
          type: "chat",
        },
        id: "gpt-search",
        model_picker_enabled: true,
        name: "GPT Search",
        object: "model",
        vendor: "openai",
        version: "codex-official",
      },
    ],
    object: "list",
  },
  diagnostics: [],
  fetchedAt: 1,
  freshness: "fresh",
  source: "official",
}
const loadCodexProviderModels = mock((_signal?: AbortSignal) =>
  Promise.resolve(codexCatalogSnapshot),
)

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

const makePlainResponsesResult = (): ResponsesResult =>
  makeResponsesResult({
    id: "resp_provider_message",
    output: [
      {
        id: "msg-provider-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from Codex.",
            annotations: [],
          },
        ],
      },
    ],
    output_text: "Hello from Codex.",
  })

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

const makeResponsesStreamResponse = (body: ResponsesResult) => {
  let sequenceNumber = 1
  const chunks = [
    "event: response.created",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
        usage: null,
      },
      sequence_number: sequenceNumber,
      type: "response.created",
    })}`,
    "",
  ]

  body.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      item.content?.forEach((content, contentIndex) => {
        if (content.type !== "output_text") {
          return
        }

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.delta",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            delta: content.text,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            type: "response.output_text.delta",
          })}`,
          "",
        )

        sequenceNumber += 1
        chunks.push(
          "event: response.output_text.done",
          `data: ${JSON.stringify({
            content_index: contentIndex,
            item_id: item.id,
            output_index: outputIndex,
            sequence_number: sequenceNumber,
            text: content.text,
            type: "response.output_text.done",
          })}`,
          "",
        )
      })
    }

    sequenceNumber += 1
    chunks.push(
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        item,
        output_index: outputIndex,
        sequence_number: sequenceNumber,
        type: "response.output_item.done",
      })}`,
      "",
    )
  })

  sequenceNumber += 1
  chunks.push(
    "event: response.completed",
    `data: ${JSON.stringify({
      response: {
        ...body,
        output: [],
        output_text: "",
      },
      sequence_number: sequenceNumber,
      type: "response.completed",
    })}`,
    "",
    "data: [DONE]",
    "",
  )

  return new Response(chunks.join("\n"), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

const makeOpenResponsesStreamResponse = (
  responseEvents: Array<Record<string, unknown>>,
): { cancelCount: () => number; response: Response } => {
  const encoder = new TextEncoder()
  let cancelCount = 0
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `${responseEvents
            .map(
              (event) =>
                `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`,
            )
            .join("\n\n")}\n\n`,
        ),
      )
    },
    cancel() {
      cancelCount += 1
    },
  })

  return {
    cancelCount: () => cancelCount,
    response: new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
  }
}

const originalFetch = globalThis.fetch
let responsesResultOverride: ResponsesResult | undefined
let responsesStreamFactory:
  | ((body: ResponsesResult, init?: RequestInit) => Response)
  | undefined

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const urlString =
    typeof url === "string" ? url
    : url instanceof URL ? url.href
    : url.url
  const requestPayload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as {
        stream?: boolean
        tools?: Array<{ type?: unknown }>
      })
    : {}

  if (urlString.endsWith("/v1/chat/completions")) {
    return Promise.resolve(
      new Response(JSON.stringify(makeChatCompletionResponse()), {
        headers: { "content-type": "application/json" },
      }),
    )
  }

  const hasWebSearchTool = requestPayload.tools?.some(
    (tool) => tool.type === "web_search",
  )
  const body =
    responsesResultOverride
    ?? (hasWebSearchTool ? makeResponsesResult() : makePlainResponsesResult())

  if (
    (urlString.endsWith("/v1/responses")
      || urlString.endsWith("/codex/responses"))
    && requestPayload.stream === true
  ) {
    return Promise.resolve(
      responsesStreamFactory?.(body, init) ?? makeResponsesStreamResponse(body),
    )
  }

  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  )
})

const forwardCodexResponses = async (
  payload: ResponsesPayload,
  _requestHeaders: Headers,
  baseUrl = "https://codex.example/backend-api",
  options: {
    signal?: AbortSignal
    transport?: ResponsesTransport
  } = {},
): Promise<CreateResponsesReturn> => {
  const normalizedPayload = { ...payload, store: false }
  delete normalizedPayload.temperature
  delete normalizedPayload.top_p
  delete normalizedPayload.max_output_tokens
  delete normalizedPayload.metadata

  const response = await fetchWithUpstreamLifecycle(
    `${baseUrl}/codex/responses`,
    {
      body: JSON.stringify(normalizedPayload),
      headers: {
        accept:
          normalizedPayload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    },
    { signal: options.signal },
  )
  if (normalizedPayload.stream) {
    return events(response)
  }
  return (await response.json()) as ResponsesResult
}

const createApp = () => {
  const providerConfigSnapshot = structuredClone(providerConfigs)
  const providerResolver = createProviderResolver({
    getCodexAccessToken: () => "codex-token",
    getProviderConfig: (name) => providerConfigSnapshot[name] ?? null,
    getRawProviderConfig: (name) => providerConfigSnapshot[name] ?? null,
    setupCodexToken: async () => {},
  })
  const providerMessages = createProviderMessagesHandler({
    createProviderTokenUsageRecorder: createProviderUsageRecorder,
    forwardCodexResponses,
    getModelResponsesApiCompactThreshold: () => undefined,
    isContextManagementEnabledForMessages: () => true,
    loadCodexProviderModels,
    providerResolver,
    resolveCodexResponsesTransport: () => "http",
  })
  const searchFlow = createWebSearchFlow({
    findEndpointModel,
    getMessageApiWebSearchModel: () => messageApiWebSearchModel,
    getResponsesTransportForModel: (selectedModel, options) =>
      getResponsesTransportForModel(selectedModel, {
        ...options,
        useWebSocket: false,
      }),
    isResponsesApiWebSearchEnabled: () => true,
  })
  const messages = createMessagesHandler({
    providerMessages,
    webSearchFlow: searchFlow,
  })
  const app = new Hono()
  app.route("/v1/messages", createMessageRoutes({ messages }))
  app.route(
    "/:provider/v1/messages",
    createProviderMessageRoutes({ messages: providerMessages }),
  )
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

const configureCodexProvider = (): void => {
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
}

const createCodexMessagesPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "gpt-search",
  ...overrides,
})

const requestStreamingCodexProviderMessages = (
  signal?: AbortSignal,
): Promise<Response> =>
  Promise.resolve(
    createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload({ stream: true })),
      signal,
    }),
  )

const normalizedCodexResponsesUsage = {
  cache_read_input_tokens: 0,
  input_tokens: 12,
  output_tokens: 7,
  total_tokens: 19,
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
  messageApiWebSearchModel = undefined
  responsesResultOverride = undefined
  responsesStreamFactory = undefined
  findEndpointModel.mockClear()
  loadCodexProviderModels.mockClear()
  fetchMock.mockClear()
  providerUsageRecorder.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfigs = {}
  messageApiWebSearchModel = undefined
  responsesResultOverride = undefined
  responsesStreamFactory = undefined
})

describe("provider messages web_search", () => {
  test("does not add context management when an unknown provider uses Responses API", async () => {
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
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://provider.example/v1/responses")

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      context_management?: unknown
      model: string
    }
    expect(upstreamBody.model).toBe("gpt-search")
    expect(upstreamBody.context_management).toBeUndefined()
  })

  test("adds context management when a Responses provider explicitly opts in", async () => {
    providerConfigs.search = {
      ...providerConfigs.search,
      capabilities: {
        responsesContextManagement: true,
      },
    }

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
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      context_management?: unknown
    }
    expect(upstreamBody.context_management).toEqual([
      {
        compact_threshold: 168000,
        type: "compaction",
      },
    ])
  })

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
    expect(JSON.stringify(json)).not.toContain("encrypted_content")
    expect(response.headers.get("x-copilot-api-web-search-carrier")).toBe(
      "synthetic-without-encrypted-content",
    )
  })

  test("rejects mixed top-level fallback tools before any upstream dispatch", async () => {
    messageApiWebSearchModel = "gpt-search"

    const response = await createApp().request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "search and call" }],
        model: "claude-sonnet-4.5",
        tools: [
          webSearchTool,
          { name: "get_weather", input_schema: { type: "object" } },
        ],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("runs pure Anthropic web_search through an openai-responses provider", async () => {
    responsesResultOverride = makeResponsesResult({
      output: [
        {
          type: "web_search_call",
          action: { queries: ["node current", "node lts"] },
        },
        { type: "web_search_call", action: {} },
        makeResponsesResult().output[1],
      ] as never,
      usage: {
        input_tokens: 12,
        input_tokens_details: {
          cached_tokens: 3,
          cache_write_tokens: 2,
        } as never,
        output_tokens: 7,
        total_tokens: 19,
      },
    })
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
      input_tokens: 7,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 7,
      server_tool_use: {
        web_search_requests: 2,
      },
    })
  })

  test("returns max_tokens for provider Web Search max_tokens incomplete", async () => {
    responsesResultOverride = makeResponsesResult({
      status: "incomplete",
      incomplete_details: { reason: "max_tokens" } as never,
    })

    const response = await createApp().request("/search/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as AnthropicResponse).stop_reason).toBe(
      "max_tokens",
    )
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder.mock.calls[0]?.[1]).toEqual({
      errorCode: "max_output_tokens",
      outcome: "incomplete",
      terminal: "response.incomplete",
    })
  })

  test("fails closed and records once for unknown provider incomplete reasons", async () => {
    responsesResultOverride = makeResponsesResult({
      status: "incomplete",
      incomplete_details: { reason: "tool_limit" } as never,
      copilot_usage: { total_nano_aiu: 800 },
    })

    const response = await createApp().request("/search/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain(
      "no Anthropic stop-reason equivalent",
    )
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder.mock.calls[0]?.[0]).toMatchObject({
      total_nano_aiu: 800,
    })
    expect(providerUsageRecorder.mock.calls[0]?.[1]).toEqual({
      errorCode: "invalid_response",
      outcome: "failed",
      terminal: "response.incomplete",
    })
  })

  test("rejects explicit search effort when no model descriptor is available", async () => {
    const response = await createApp().request("/search/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search" }],
        model: "gpt-search",
        output_config: { effort: "high" },
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(
      "Cannot validate explicit reasoning effort",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("marks dynamic web_search provider requests as direct fallback", async () => {
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
        tools: [
          {
            type: "web_search_20260318",
            name: "web_search",
            max_uses: 2,
            response_inclusion: "excluded",
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-copilot-api-web-search-mode")).toBe(
      "direct-fallback",
    )
    expect(response.headers.get("x-copilot-api-web-search-downgrade")).toBe(
      "dynamic-filtering,response-inclusion",
    )

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      max_tool_calls?: number
    }
    expect(upstreamBody.max_tool_calls).toBe(2)
  })

  test("rejects invalid max_uses on the top-level Copilot fallback", async () => {
    messageApiWebSearchModel = "gpt-5-mini"
    const app = createApp()
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search now" }],
        model: "claude-opus-4-8",
        tools: [
          {
            type: "web_search_20260318",
            name: "web_search",
            max_uses: 0,
            allowed_callers: ["direct"],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "web_search max_uses must be a positive integer",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects invalid max_uses on openai-responses providers", async () => {
    const app = createApp()
    const response = await app.request("/search/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search now" }],
        model: "gpt-search",
        tools: [
          {
            type: "web_search_20260318",
            name: "web_search",
            max_uses: -1,
            allowed_callers: ["direct"],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "web_search max_uses must be a positive integer",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("loads the official Codex catalog and preserves omitted effort", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-copilot-api-codex-catalog-source")).toBe(
      "official",
    )
    expect(loadCodexProviderModels).toHaveBeenCalledTimes(1)
    expect(loadCodexProviderModels.mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    )
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning).toBeDefined()
    expect(upstreamBody.reasoning).not.toHaveProperty("effort")
  })

  test("rejects explicit Codex effort outside the selected descriptor", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          output_config: { effort: "xhigh" },
        }),
      ),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Reasoning effort 'xhigh' is not supported by Codex model 'gpt-search'",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects disabled thinking when descriptor does not allow none", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({ thinking: { type: "disabled" } }),
      ),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Reasoning effort 'none' is not supported by Codex model 'gpt-search'",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards none only when the selected descriptor allows it", async () => {
    configureCodexProvider()
    const supportsNone = structuredClone(codexCatalogSnapshot)
    supportsNone.catalog.data[0].capabilities.supports.reasoning_effort = [
      "none",
      "low",
    ]
    loadCodexProviderModels.mockResolvedValueOnce(supportsNone)

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({ thinking: { type: "disabled" } }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning?.effort).toBe("none")
  })

  test("rejects unknown runtime Codex effort values", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-search",
        output_config: { effort: "future-hyper" },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid Codex reasoning effort",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards explicit Codex ultra effort allowed by the descriptor", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          output_config: { effort: "ultra" },
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning?.effort).toBe("ultra")
  })

  test("runs codex web_search through streaming Responses", async () => {
    configureCodexProvider()

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
      reasoning?: { effort?: string }
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.reasoning).not.toHaveProperty("effort")

    const upstreamHeaders = new Headers((init as RequestInit).headers)
    expect(upstreamHeaders.get("accept")).toBe("text/event-stream")

    const json = (await response.json()) as AnthropicResponse
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  test("forwards descriptor-approved explicit effort for Codex web_search", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search deeply" }],
        model: "gpt-search",
        output_config: { effort: "ultra" },
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      reasoning?: { effort?: string }
    }
    expect(upstreamBody.reasoning?.effort).toBe("ultra")
  })

  test("records buffered Codex web_search failure usage before the protocol error", async () => {
    configureCodexProvider()
    const failed = makeResponsesResult({
      error: {
        code: "server_error",
        message: "private provider web search failure",
      },
      id: "resp-private-search-failure",
      output: [],
      output_text: "",
      status: "failed",
    })
    responsesStreamFactory = () =>
      new Response(
        `data: ${JSON.stringify({
          copilot_usage: { total_nano_aiu: 1_200 },
          response: failed,
          sequence_number: 1,
          type: "response.failed",
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search privately" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain("Responses upstream reported an error")
    expect(body).not.toContain("private provider")
    expect(body).not.toContain("resp-private")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      {
        ...normalizedCodexResponsesUsage,
        total_nano_aiu: 1_200,
      },
      {
        errorCode: "upstream_error",
        outcome: "failed",
        terminal: "response.failed",
      },
    )
  })

  test("marks direct provider web_search JSON failures in the usage ledger", async () => {
    const failed = makeResponsesResult({
      error: { code: "server_error", message: "direct provider failure" },
      output: [],
      output_text: "",
      status: "failed",
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify(failed), {
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    const response = await createApp().request("/search/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "Search" }],
        model: "gpt-search",
        tools: [webSearchTool],
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain("direct provider failure")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedCodexResponsesUsage,
      {
        errorCode: "response_failed",
        outcome: "failed",
        terminal: "response.failed",
      },
    )
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

  test("rejects mixed web_search and normal tools before Responses dispatch", async () => {
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

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Mixed web_search and client tools are not supported by the Responses fallback",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("passes mixed web_search and client tools unchanged to native Anthropic", async () => {
    providerConfigs.native = {
      name: "native",
      type: "anthropic",
      baseUrl: "https://native.example",
      apiKey: "native-key",
      authType: "x-api-key",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-native",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "native" }],
            model: "claude-native",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    )

    const response = await createApp().request("/native/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "search and call" }],
        model: "claude-native",
        tools: [
          webSearchTool,
          { name: "get_weather", input_schema: { type: "object" } },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.tools).toEqual([
      webSearchTool,
      { name: "get_weather", input_schema: { type: "object" } },
    ])
  })

  test("prioritizes an explicit native provider alias over the global Web Search fallback", async () => {
    messageApiWebSearchModel = "gpt-search"
    providerConfigs.native = {
      name: "native",
      type: "anthropic",
      baseUrl: "https://native.example",
      apiKey: "native-key",
      authType: "x-api-key",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg-native-top-level",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "native" }],
            model: "claude-native",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    )

    const response = await createApp().request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "search and call" }],
        model: "native/claude-native",
        tools: [
          webSearchTool,
          { name: "get_weather", input_schema: { type: "object" } },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://native.example/v1/messages")
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model?: string
      tools?: Array<Record<string, unknown>>
    }
    expect(upstreamBody.model).toBe("claude-native")
    expect(upstreamBody.tools).toEqual([
      webSearchTool,
      { name: "get_weather", input_schema: { type: "object" } },
    ])
  })

  test("rejects Anthropic web_search before OpenAI-compatible dispatch", async () => {
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

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Web Search is not supported by the selected provider adapter",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("collects a Codex stream into JSON when stream is omitted", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(new Headers((init as RequestInit).headers).get("accept")).toBe(
      "text/event-stream",
    )

    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([{ type: "text", text: "Hello from Codex." }])
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 })
  })

  test("collects a Codex stream into JSON when stream is false", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({ stream: false, tools: [] }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect((await response.json()) as AnthropicResponse).toMatchObject({
      content: [{ type: "text", text: "Hello from Codex." }],
      stop_reason: "end_turn",
    })
  })

  test("collects a non-stream Codex tool call into Anthropic JSON", async () => {
    configureCodexProvider()
    responsesResultOverride = makeResponsesResult({
      id: "resp_provider_tool_call",
      output: [
        {
          id: "fc-provider-weather",
          type: "function_call",
          call_id: "call-provider-weather",
          name: "get_weather",
          arguments: '{"city":"Shanghai"}',
          status: "completed",
        },
      ],
      output_text: "",
    })

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          tools: [
            {
              name: "get_weather",
              description: "Get the current weather",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)

    const json = (await response.json()) as AnthropicResponse
    expect(json.content).toEqual([
      {
        type: "tool_use",
        id: "call-provider-weather",
        name: "get_weather",
        input: { city: "Shanghai" },
      },
    ])
    expect(json.stop_reason).toBe("tool_use")
  })

  test("forces streaming for a Codex follow-up containing tool_result", async () => {
    configureCodexProvider()

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        createCodexMessagesPayload({
          messages: [
            { role: "user", content: "What is the weather?" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "call-provider-weather",
                  name: "get_weather",
                  input: { city: "Shanghai" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-provider-weather",
                  content: "Sunny, 30C",
                },
              ],
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      input?: Array<Record<string, unknown>>
      stream?: boolean
    }
    expect(upstreamBody.stream).toBe(true)
    expect(upstreamBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-provider-weather",
      output: "Sunny, 30C",
      status: "completed",
    })
    expect((await response.json()) as AnthropicResponse).toMatchObject({
      content: [{ type: "text", text: "Hello from Codex." }],
      stop_reason: "end_turn",
    })
  })

  test("keeps requested Codex streaming as Anthropic SSE", async () => {
    configureCodexProvider()

    const response = await requestStreamingCodexProviderMessages()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("Hello from Codex.")
    expect(text).toContain("event: message_stop")
  })

  test("releases Codex HTTP after a completed provider Messages terminal", async () => {
    configureCodexProvider()
    const completedResponse = makePlainResponsesResult()
    const transport = makeOpenResponsesStreamResponse([
      {
        response: completedResponse,
        sequence_number: 1,
        type: "response.completed",
      },
    ])
    let upstreamSignal: AbortSignal | null = null
    responsesStreamFactory = (_body, init) => {
      upstreamSignal = init?.signal ?? null
      return transport.response
    }

    const response = await requestStreamingCodexProviderMessages()

    const body = await response.text()
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
    expect(body).not.toContain("event: error")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedCodexResponsesUsage,
    )
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(transport.cancelCount()).toBe(1)
  })

  test("releases Codex HTTP after an incomplete provider Messages terminal", async () => {
    configureCodexProvider()
    const incompleteResponse = {
      ...makePlainResponsesResult(),
      incomplete_details: { reason: "max_output_tokens" },
      status: "incomplete",
    }
    const transport = makeOpenResponsesStreamResponse([
      {
        response: incompleteResponse,
        sequence_number: 1,
        type: "response.incomplete",
      },
    ])
    responsesStreamFactory = () => transport.response

    const response = await requestStreamingCodexProviderMessages()

    const body = await response.text()
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
    expect(body).toContain('"stop_reason":"max_tokens"')
    expect(body).not.toContain("event: error")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedCodexResponsesUsage,
    )
    expect(transport.cancelCount()).toBe(1)
  })

  test("releases Codex HTTP after a failed provider Messages terminal", async () => {
    configureCodexProvider()
    const failedResponse = {
      ...makePlainResponsesResult(),
      error: {
        code: "server_error",
        message: "Codex provider failed after usage",
      },
      status: "failed",
    }
    const transport = makeOpenResponsesStreamResponse([
      {
        response: failedResponse,
        sequence_number: 1,
        type: "response.failed",
      },
    ])
    responsesStreamFactory = () => transport.response

    const response = await requestStreamingCodexProviderMessages()

    const body = await response.text()
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("Codex provider failed after usage")
    expect(body).not.toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedCodexResponsesUsage,
    )
    expect(transport.cancelCount()).toBe(1)
  })

  test("releases Codex HTTP after a provider Messages error event", async () => {
    configureCodexProvider()
    const transport = makeOpenResponsesStreamResponse([
      {
        code: "upstream_error",
        message: "Codex provider stream error",
        param: null,
        sequence_number: 1,
        type: "error",
      },
    ])
    responsesStreamFactory = () => transport.response

    const response = await requestStreamingCodexProviderMessages()

    const body = await response.text()
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("Codex provider stream error")
    expect(body).not.toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith({})
    expect(transport.cancelCount()).toBe(1)
  })

  test("forwards caller abort reason through Codex provider HTTP", async () => {
    configureCodexProvider()
    const transport = makeOpenResponsesStreamResponse([
      {
        response: {
          ...makePlainResponsesResult(),
          output: [],
          output_text: "",
          usage: null,
        },
        sequence_number: 0,
        type: "response.created",
      },
      {
        content_index: 0,
        delta: "partial",
        item_id: "msg-provider-message",
        output_index: 0,
        sequence_number: 1,
        type: "response.output_text.delta",
      },
    ])
    let upstreamSignal: AbortSignal | null = null
    responsesStreamFactory = (_body, init) => {
      upstreamSignal = init?.signal ?? null
      return transport.response
    }
    const controller = new AbortController()
    const abortReason = new Error("caller stopped Codex HTTP after partial")

    const response = await requestStreamingCodexProviderMessages(
      controller.signal,
    )
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let body = ""
    while (!body.includes('"text":"partial"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value as Uint8Array, { stream: true })
    }
    controller.abort(abortReason)
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        body += decoder.decode(chunk.value as Uint8Array, { stream: true })
      }
    } catch {
      // The caller intentionally closed the downstream response.
    }

    expect(body).toContain('"text":"partial"')
    expect(body).not.toContain("event: error")
    expect(body).not.toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith({})
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
    expect((upstreamSignal as unknown as AbortSignal).reason).toBe(abortReason)
    expect(transport.cancelCount()).toBe(1)
  })

  test("fails non-stream Codex requests when the upstream stream errors", async () => {
    configureCodexProvider()
    responsesStreamFactory = () =>
      new Response(
        [
          `data: ${JSON.stringify({
            code: "upstream_error",
            copilot_usage: { total_nano_aiu: 800 },
            message: "private Codex stream failure detail",
            param: null,
            sequence_number: 1,
            type: "error",
            usage: {
              input_tokens: 12,
              output_tokens: 7,
              total_tokens: 19,
            },
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      )

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain("Responses upstream reported an error")
    expect(body).not.toContain("private Codex")
    expect(body).not.toContain('"type":"message"')
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      {
        ...normalizedCodexResponsesUsage,
        total_nano_aiu: 800,
      },
      {
        errorCode: "upstream_error",
        outcome: "failed",
        terminal: "error",
      },
    )
  })

  test("fails non-stream Codex requests when a terminal response reports failure", async () => {
    configureCodexProvider()
    const failedResponse = makePlainResponsesResult()
    responsesStreamFactory = () =>
      new Response(
        [
          `data: ${JSON.stringify({
            response: {
              ...failedResponse,
              error: {
                code: "upstream_error",
                message: "Codex response failed",
              },
              output: [],
              output_text: "",
              status: "failed",
            },
            sequence_number: 1,
            type: "response.failed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      )

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain("Responses upstream reported an error")
    expect(body).not.toContain("Codex response failed")
    expect(body).not.toContain('"type":"message"')
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedCodexResponsesUsage,
      {
        errorCode: "upstream_error",
        outcome: "failed",
        terminal: "response.failed",
      },
    )
  })

  test("fails non-stream Codex requests without a terminal event", async () => {
    configureCodexProvider()
    responsesStreamFactory = () =>
      new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })

    const response = await createApp().request("/codex/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCodexMessagesPayload()),
    })

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('"type":"message"')
  })
})
