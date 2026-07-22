import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type {
  ProviderAuthType,
  ResolvedProviderConfig,
} from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let configuredAuthType: ProviderAuthType | undefined
let modelMappings: Record<string, string> = {}

const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getRawProviderConfig: () => ({ authType: configuredAuthType }),
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { completionRoutes } = await import(
  "../src/routes/chat-completions/route"
)

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
  app.route("/v1/chat/completions", completionRoutes)
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
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
        },
        temperature: 0.2,
        topK: 50,
        topP: 0.8,
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level chat completions route", () => {
  test("keeps provider HTTP fetch cancellable after response headers", async () => {
    const controller = new AbortController()
    const response = await createApp().request(
      new Request("http://localhost/v1/chat/completions", {
        body: JSON.stringify({
          messages: [{ content: "hello", role: "user" }],
          model: "dash/qwen-plus",
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      }),
    )

    expect(response.status).toBe(200)
    const upstreamSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal
    expect(upstreamSignal?.aborted).toBe(false)

    controller.abort(new Error("client disconnected"))
    expect(upstreamSignal?.aborted).toBe(true)
  })

  test("routes mapped models to provider chat completions before rate limiting", async () => {
    modelMappings = {
      "gpt-provider": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "gpt-provider",
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
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("strips provider prefix and applies provider model defaults", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
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

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody).toMatchObject({
      enable_thinking: true,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.2,
      top_k: 50,
      top_p: 0.8,
    })
  })

  test("keeps request fields over provider defaults and adds stream usage option", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        enable_thinking: false,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
        stream_options: {
          include_usage: false,
        },
        temperature: 0.4,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody.temperature).toBe(0.4)
    expect(upstreamBody.enable_thinking).toBe(false)
    expect(upstreamBody.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("rejects providers without chat completions support", async () => {
    providerConfig = {
      ...(providerConfig as ResolvedProviderConfig),
      type: "openai-responses",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'dash' does not support the /v1/chat/completions endpoint",
        type: "invalid_request_error",
      },
    })
  })

  test("routes a model-level chat protocol override through the chat adapter", async () => {
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

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
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

  test("defaults auth from the model-level protocol when auth is omitted", async () => {
    configuredAuthType = undefined
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

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })
  })

  test("emits an error when a provider stream ends without finish_reason", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-partial","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"content":"partial"')
    expect(body).toContain("event: error")
    expect(body).toContain("Provider chat stream ended without finish_reason")
  })

  test("translates streaming finish_reason error into an SSE error", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-error","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("Provider upstream ended with finish_reason=error")
  })

  test("emits an SSE error when a provider chat stream throws", async () => {
    const encoder = new TextEncoder()
    let pullCount = 0
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1
          controller.enqueue(
            encoder.encode(
              'data: {"id":"chatcmpl-partial","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            ),
          )
          return
        }
        controller.error(new Error("provider chat socket reset"))
      },
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(upstreamBody, {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("provider chat socket reset")
  })
})

describe("context cache on provider chat completions route", () => {
  test("applies context cache for dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            enable_thinking: true,
            preserve_thinking: true,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }

    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })

    const userMessage = body.messages[1]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("detects dashscope via aliyuncs.com in baseUrl", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://bailian.aliyuncs.com/api/v1",
      name: "my-bailian",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "my-bailian/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const userMessage = body.messages[0]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })

  test("applies context cache for non-dashscope providers when explicitly enabled", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {
          contextCache: true,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("disables context cache for dashscope when contextCache is false", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          contextCache: false,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })
})

describe("dashscope preserve_thinking default on chat completions route", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            preserve_thinking: false,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("keeps explicit preserve_thinking false from request", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
        preserve_thinking: false,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})
