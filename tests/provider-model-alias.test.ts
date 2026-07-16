import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type {
  ProviderAuthType,
  ResolvedProviderConfig,
} from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualTokenUsageModule = await import("../src/lib/token-usage")
const actualTokenizerModule = await import("../src/lib/tokenizer")

let providerConfig: ResolvedProviderConfig | null = null
let configuredAuthType: ProviderAuthType | undefined
let modelMappings: Record<string, string> = {}

interface TokenCountPayload {
  model: string
}

interface TokenCountModel {
  capabilities: {
    tokenizer: string
  }
  id: string
}

const getTokenCount = mock(
  (_payload: TokenCountPayload, _model: TokenCountModel) =>
    Promise.resolve({ input: 40, output: 2 }),
)
const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getRawProviderConfig: () => ({ authType: configuredAuthType }),
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/tokenizer", () => ({
  ...actualTokenizerModule,
  getTokenCount,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { messageRoutes } = await import("../src/routes/messages/route")

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            message: {
              content: "answer text",
              role: "assistant",
            },
          },
        ],
        created: 0,
        id: "chatcmpl-test",
        model: "qwen-plus",
        object: "chat.completion",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 8,
          total_tokens: 10,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  return app
}

beforeEach(() => {
  configuredAuthType = "authorization"
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        temperature: 0.2,
        toolContentSupportType: [],
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  fetchMock.mockClear()
  getTokenCount.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level messages routes", () => {
  test("routes mapped /v1/messages models to the provider before rate limiting", async () => {
    modelMappings = {
      "claude-opus-4-7": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("routes /v1/messages to the provider and strips the provider prefix", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")

    const json = (await response.json()) as { model: string }
    expect(json.model).toBe("qwen-plus")
  })

  test("uses the effective model protocol and explicit auth for a provider override", async () => {
    configuredAuthType = "x-api-key"
    providerConfig = {
      ...(providerConfig as ResolvedProviderConfig),
      authType: "x-api-key",
      models: {
        "qwen-plus": {
          type: "openai-compatible",
        },
      },
      type: "anthropic",
    }

    const response = await createApp().request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
    })
  })

  test("routes /v1/messages/count_tokens to provider token counting with the stripped model", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input_tokens: 42,
    })
    expect(getTokenCount).toHaveBeenCalledTimes(1)

    const [openAIPayload, selectedModel] = getTokenCount.mock.calls[0] as [
      TokenCountPayload,
      TokenCountModel,
    ]
    expect(openAIPayload.model).toBe("qwen-plus")
    expect(selectedModel.id).toBe("qwen-plus")
    expect(selectedModel.capabilities.tokenizer).toBe("o200k_base")
  })

  test("routes mapped /v1/messages/count_tokens models to provider token counting", async () => {
    modelMappings = {
      "claude-opus-4-7": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input_tokens: 42,
    })
    expect(getTokenCount).toHaveBeenCalledTimes(1)

    const [openAIPayload, selectedModel] = getTokenCount.mock.calls[0] as [
      TokenCountPayload,
      TokenCountModel,
    ]
    expect(openAIPayload.model).toBe("qwen-plus")
    expect(selectedModel.id).toBe("qwen-plus")
    expect(selectedModel.capabilities.tokenizer).toBe("o200k_base")
  })

  test("does not return a fake count when provider token counting fails", async () => {
    getTokenCount.mockImplementationOnce(
      (_payload: TokenCountPayload, _model: TokenCountModel) =>
        Promise.reject(new Error("tokenizer failed")),
    )

    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        message: "tokenizer failed",
        type: "error",
      },
    })
  })
})
