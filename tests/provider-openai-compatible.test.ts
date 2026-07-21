import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null

const providerUsageRecorder = mock((_usage: Record<string, unknown>) => {})

const createNoopProviderTokenUsageRecorder = () => providerUsageRecorder

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: createNoopProviderTokenUsageRecorder,
}))

const { providerMessageRoutes } = await import(
  "../src/routes/provider/messages/route"
)

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              reasoning_content: "thinking text",
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
          prompt_tokens_details: {
            cache_creation_input_tokens: 2,
            cached_tokens: 1,
          },
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
  app.route("/:provider/v1/messages", providerMessageRoutes)
  return app
}

const createResponsesResult = () => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-resp",
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: {
    input_tokens: 12,
    input_tokens_details: {
      cached_tokens: 2,
    },
    output_tokens: 4,
    total_tokens: 16,
  },
})

const createOpenResponsesSseTransport = (
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
      headers: {
        "content-type": "text/event-stream",
      },
    }),
  }
}

const configureOpenAIResponsesProvider = (): void => {
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://responses.example",
    models: {
      "gpt-resp": {},
    },
    name: "dash",
    type: "openai-responses",
  }
}

const requestStreamingResponsesProviderMessages = (
  signal?: AbortSignal,
): Promise<Response> =>
  Promise.resolve(
    createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-resp",
        stream: true,
      }),
      signal,
    }),
  )

const normalizedResponsesUsage = {
  cache_read_input_tokens: 2,
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 16,
}

beforeEach(() => {
  providerConfig = {
    name: "dashscope",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    apiKey: "provider-key",
    authType: "authorization",
    models: {
      "qwen-plus": {
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
          temperature: 0.9,
        },
        temperature: 0.2,
        toolContentSupportType: [],
        topK: 50,
        topP: 0.8,
      },
    },
  }
  fetchMock.mockClear()
  providerUsageRecorder.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("openai-compatible provider messages", () => {
  test("merges message-level system prompts before OpenAI-compatible translation", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          contextCache: false,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "follow the repo style" },
          { role: "assistant", content: "working on it" },
          { role: "system", content: "keep answers short" },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }

    expect(body.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: "working on it",
      },
    ])
  })

  test("translates Anthropic messages to OpenAI chat completions", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        enable_thinking: false,
        temperature: 0.4,
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const body = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      enable_thinking: false,
      max_tokens: 128,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.4,
      top_k: 50,
      top_p: 0.8,
    })
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: {
              type: "ephemeral",
            },
          },
        ],
      },
    ])
    expect(body).not.toHaveProperty("stream_options")

    const json = (await response.json()) as Record<string, unknown>
    expect(json).toMatchObject({
      model: "qwen-plus",
      role: "assistant",
      stop_reason: "end_turn",
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        input_tokens: 5,
        output_tokens: 2,
      },
    })
    expect(json.content).toEqual([
      {
        type: "thinking",
        thinking: "thinking text",
        signature: "",
      },
      {
        type: "text",
        text: "answer text",
      },
    ])
  })

  test("suppresses provider reasoning when thinking is disabled", async () => {
    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "disabled",
        },
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      content: Array<Record<string, unknown>>
    }
    expect(json.content).toEqual([{ type: "text", text: "answer text" }])
  })

  test("returns an error when provider finish_reason is error", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl-error",
          object: "chat.completion",
          created: 0,
          model: "qwen-plus",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
              },
              finish_reason: "error",
              logprobs: null,
            },
          ],
        }),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Provider upstream ended with finish_reason=error",
      },
    })
  })

  test("adds stream_options include_usage for OpenAI-compatible streams", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("preserves final usage after provider metadata-only chunks", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-metadata","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}',
            'data: {"id":"chatcmpl-metadata","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[]}',
            'data: {"id":"chatcmpl-metadata","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[],"usage":{"prompt_tokens":8544,"completion_tokens":174,"total_tokens":8718}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"input_tokens":8544,"output_tokens":174')
    expect(body.match(/event: message_delta/gu)).toHaveLength(1)
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
  })

  test("flushes provider metadata-delayed completion at EOF", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-metadata-eof","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}',
            'data: {"id":"chatcmpl-metadata-eof","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[]}',
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":0}}',
    )
    expect(body.match(/event: message_delta/gu)).toHaveLength(1)
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
    expect(body).not.toContain("event: error")
  })

  test("does not stop before a provider error after metadata", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-metadata-error","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}',
            'data: {"id":"chatcmpl-metadata-error","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[]}',
            'event: error\ndata: {"message":"metadata stream failed","type":"api_error"}',
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"message":"metadata stream failed"')
    expect(body).not.toContain("event: message_stop")
  })

  test("translates OpenAI-compatible stream errors to Anthropic error events", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          'event: error\ndata: {"error":{"message":"upstream failed","type":"invalid_request_error"}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"message":"upstream failed"')
    expect(body).toContain('"type":"invalid_request_error"')
  })

  test("translates streaming finish_reason error to Anthropic error", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-error","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain(
      '"message":"Provider upstream ended with finish_reason=error"',
    )
    expect(body).not.toContain("event: message_stop")
  })

  test("emits an Anthropic error when an OpenAI stream ends without finish_reason", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          'data: {"id":"chatcmpl-partial","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"text":"partial"')
    expect(body).toContain("event: error")
    expect(body).toContain(
      "Provider OpenAI-compatible stream ended without finish_reason",
    )
    expect(body).not.toContain("event: message_stop")
  })

  test("emits an Anthropic error when an OpenAI-compatible stream throws", async () => {
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
        controller.error(new Error("provider compatible socket reset"))
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

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("provider compatible socket reset")
  })

  test("translates plain-text OpenAI-compatible stream error events", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response("event: error\ndata: upstream failed\n\n", {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"message":"upstream failed"')
    expect(body).toContain('"type":"api_error"')
  })

  test("translates empty OpenAI-compatible stream error events", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response("event: error\n\n", {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain(
      '"message":"Upstream provider stream returned an error event."',
    )
  })

  test("translates string-valued OpenAI-compatible stream errors", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response('data: {"error":"quota hit"}\n\n', {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain('"message":"quota hit"')
    expect(body).toContain('"type":"api_error"')
  })

  test("records usage collected before OpenAI-compatible stream errors", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"qwen-plus","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11,"prompt_tokens_details":{"cache_creation_input_tokens":2,"cached_tokens":1}}}',
            'event: error\ndata: {"message":"quota hit","type":"rate_limit_error"}',
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"message":"quota hit"')
    expect(body).toContain('"type":"rate_limit_error"')
    expect(providerUsageRecorder).toHaveBeenCalledWith({
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 1,
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 11,
    })
  })

  test("allows extraBody to disable parallel tool calls", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          extraBody: {
            parallel_tool_calls: false,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.parallel_tool_calls).toBe(false)
  })

  test("maps Anthropic thinking budget to OpenAI-compatible thinking_budget", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(4096)
    expect(body).not.toHaveProperty("thinking")
  })

  test("forces thinking_budget from extraBody over request thinking budget", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          extraBody: {
            thinking_budget: 8192,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })
})

describe("openai-responses provider messages", () => {
  test("keeps Anthropic SSE when a streaming provider returns buffered JSON", async () => {
    configureOpenAIResponsesProvider()
    let upstreamSignal: AbortSignal | null = null
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(
        Response.json({
          ...createResponsesResult(),
          output: [
            {
              id: "msg-buffered-fallback",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "buffered fallback",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "buffered fallback",
        }),
      )
    })

    const response = await requestStreamingResponsesProviderMessages()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith(
      "text/event-stream",
    )
    const body = await response.text()
    expect(body).toContain("event: message_start")
    expect(body).toContain("event: content_block_start")
    expect(body).toContain('"text":"buffered fallback"')
    expect(body).toContain("event: message_delta")
    expect(body).toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(
      normalizedResponsesUsage,
      undefined,
    )
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
  })

  test("releases the provider HTTP transport after a non-stream error body", async () => {
    configureOpenAIResponsesProvider()
    let upstreamSignal: AbortSignal | null = null
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "rate_limit_exceeded",
              message: "slow down",
              type: "requests",
            },
          },
          {
            headers: { "retry-after": "3" },
            status: 429,
          },
        ),
      )
    })

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-resp",
      }),
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("3")
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "slow down",
        type: "requests",
      },
    })
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
  })

  test("releases the real provider HTTP transport after a typed terminal", async () => {
    configureOpenAIResponsesProvider()

    let upstreamSignal: AbortSignal | null = null
    const transport = createOpenResponsesSseTransport([
      {
        response: createResponsesResult(),
        sequence_number: 0,
        type: "response.created",
      },
      {
        response: createResponsesResult(),
        sequence_number: 1,
        type: "response.completed",
      },
    ])
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(transport.response)
    })

    const response = await requestStreamingResponsesProviderMessages()

    const body = await response.text()
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
    expect(body).not.toContain("event: error")
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
    expect(transport.cancelCount()).toBe(1)
  })

  test("forwards caller abort to the provider HTTP transport after partial output", async () => {
    configureOpenAIResponsesProvider()

    const decoder = new TextDecoder()
    let upstreamSignal: AbortSignal | null = null
    const transport = createOpenResponsesSseTransport([
      {
        response: createResponsesResult(),
        sequence_number: 0,
        type: "response.created",
      },
      {
        content_index: 0,
        delta: "partial",
        item_id: "msg-test",
        output_index: 0,
        sequence_number: 1,
        type: "response.output_text.delta",
      },
    ])
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(transport.response)
    })

    const controller = new AbortController()
    const abortReason = new Error("client disconnected after partial output")
    const response = await requestStreamingResponsesProviderMessages(
      controller.signal,
    )

    const reader = response.body!.getReader()
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
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
    expect((upstreamSignal as unknown as AbortSignal).reason).toBe(abortReason)
    expect(transport.cancelCount()).toBe(1)
  })

  test("records usage from Responses provider streams", async () => {
    configureOpenAIResponsesProvider()

    const encoder = new TextEncoder()
    let emittedUsage = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emittedUsage) {
          controller.close()
          return
        }
        emittedUsage = true
        controller.enqueue(
          encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({
              response: createResponsesResult(),
              sequence_number: 1,
              type: "response.completed",
            })}\n\n`,
          ),
        )
      },
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const response = await requestStreamingResponsesProviderMessages()

    expect(response.status).toBe(200)
    await response.text()
    expect(providerUsageRecorder).toHaveBeenCalledWith(normalizedResponsesUsage)
  })

  test("turns a partial Responses provider failure into one Anthropic stream error", async () => {
    configureOpenAIResponsesProvider()

    const encoder = new TextEncoder()
    let pullCount = 0
    let upstreamSignal: AbortSignal | null = null
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1
          controller.enqueue(
            encoder.encode(
              `event: response.output_text.delta\ndata: ${JSON.stringify({
                content_index: 0,
                delta: "partial",
                item_id: "msg-test",
                output_index: 0,
                sequence_number: 1,
                type: "response.output_text.delta",
              })}\n\n`,
            ),
          )
          return
        }
        controller.error(new Error("provider socket reset"))
      },
    })
    fetchMock.mockImplementationOnce((_url, init) => {
      upstreamSignal = init?.signal ?? null
      return Promise.resolve(
        new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      )
    })

    const response = await requestStreamingResponsesProviderMessages()

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"text":"partial"')
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("provider socket reset")
    expect(body).not.toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith({})
    expect(upstreamSignal).not.toBeNull()
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true)
  })

  test("maps a failed provider terminal to one error and records its usage", async () => {
    configureOpenAIResponsesProvider()
    const failedResponse = {
      ...createResponsesResult(),
      error: {
        code: "server_error",
        message: "provider failed after usage",
      },
      status: "failed",
    }
    const transport = createOpenResponsesSseTransport([
      {
        response: failedResponse,
        sequence_number: 1,
        type: "response.failed",
      },
    ])
    fetchMock.mockImplementationOnce(() => Promise.resolve(transport.response))

    const response = await requestStreamingResponsesProviderMessages()

    const body = await response.text()
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("provider failed after usage")
    expect(body).not.toContain("event: message_stop")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(normalizedResponsesUsage)
    expect(transport.cancelCount()).toBe(1)
  })

  test("maps an incomplete provider terminal to max_tokens and records its usage", async () => {
    configureOpenAIResponsesProvider()
    const incompleteResponse = {
      ...createResponsesResult(),
      incomplete_details: {
        reason: "max_output_tokens",
      },
      status: "incomplete",
    }
    const transport = createOpenResponsesSseTransport([
      {
        response: incompleteResponse,
        sequence_number: 1,
        type: "response.incomplete",
      },
    ])
    fetchMock.mockImplementationOnce(() => Promise.resolve(transport.response))

    const response = await requestStreamingResponsesProviderMessages()

    const body = await response.text()
    expect(body.match(/event: message_stop/gu)).toHaveLength(1)
    expect(body).toContain('"stop_reason":"max_tokens"')
    expect(body).not.toContain("event: error")
    expect(providerUsageRecorder).toHaveBeenCalledTimes(1)
    expect(providerUsageRecorder).toHaveBeenCalledWith(normalizedResponsesUsage)
    expect(transport.cancelCount()).toBe(1)
  })

  test("rejects assistant prefill before calling a Responses provider", async () => {
    configureOpenAIResponsesProvider()

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          { role: "user", content: "Return JSON" },
          { role: "assistant", content: '{"value":' },
        ],
        model: "gpt-resp",
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("maps disabled thinking and failed Responses provider results", async () => {
    configureOpenAIResponsesProvider()
    fetchMock.mockImplementationOnce((_url, init) => {
      const requestBody = JSON.parse(init?.body as string) as {
        reasoning?: { effort?: string }
      }
      expect(requestBody.reasoning?.effort).toBe("none")
      return Promise.resolve(
        Response.json({
          ...createResponsesResult(),
          status: "failed",
          error: {
            code: "server_error",
            message: "provider failed",
          },
        }),
      )
    })

    const response = await createApp().request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-resp",
        thinking: {
          type: "disabled",
        },
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "provider failed",
      },
    })
  })
})

describe("anthropic provider messages", () => {
  test("treats a native Anthropic error event as the terminal", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: {
        "claude-test": {},
      },
      name: "anthropic",
      type: "anthropic",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response("event: error\ndata: upstream failed\n\n", {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const response = await createApp().request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "claude-test",
        stream: true,
      }),
    })

    const body = await response.text()
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("upstream failed")
  })

  test("emits an error when a native Anthropic stream ends without message_stop", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: {
        "claude-test": {},
      },
      name: "anthropic",
      type: "anthropic",
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-partial","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "claude-test",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"text":"partial"')
    expect(body).toContain("event: error")
    expect(body).toContain(
      "Provider Anthropic stream ended without message_stop",
    )
  })

  test("emits an error when a native Anthropic stream throws", async () => {
    providerConfig = {
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://anthropic.example",
      models: {
        "claude-test": {},
      },
      name: "anthropic",
      type: "anthropic",
    }
    const encoder = new TextEncoder()
    let pullCount = 0
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1
          controller.enqueue(
            encoder.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-partial","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
            ),
          )
          return
        }
        controller.error(new Error("provider messages socket reset"))
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

    const response = await createApp().request("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "claude-test",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("provider messages socket reset")
  })
})

describe("openai-compatible provider context cache", () => {
  test("marks first system and last non-system message for OpenAI-compatible context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second" },
          { role: "assistant", content: "second answer" },
          { role: "user", content: "latest" },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const markedMessages = body.messages.filter(
      (message) =>
        Array.isArray(message.content)
        && message.content.some(
          (part) =>
            typeof part === "object"
            && part !== null
            && "cache_control" in part,
        ),
    )

    expect(markedMessages).toHaveLength(2)
    expect(body.messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "first",
    })
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "first answer",
    })
    expect(body.messages[3]).toEqual({
      role: "user",
      content: "second",
    })
    expect(body.messages[4]).toEqual({
      role: "assistant",
      content: "second answer",
    })
    expect(body.messages[5]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "latest",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("allows disabling OpenAI-compatible context cache per model", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          contextCache: false,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages).toEqual([
      {
        role: "system",
        content: "system prompt",
      },
      {
        role: "user",
        content: "hello",
      },
    ])
  })
})

describe("openai-compatible provider message content", () => {
  test("sends assistant thinking history as reasoning_content", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: "first",
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "empty signature thinking",
                signature: "",
              },
              {
                type: "text",
                text: "previous answer",
              },
            ],
          },
          {
            role: "user",
            content: "continue",
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[1]).toMatchObject({
      content: [
        {
          type: "text",
          text: "previous answer",
        },
      ],
      reasoning_content: "empty signature thinking",
      role: "assistant",
    })
    expect(body.messages[1]).not.toHaveProperty("reasoning_text")
    expect(body.messages[1]).not.toHaveProperty("reasoning_opaque")
  })
})

describe("openai-compatible provider tool array content", () => {
  test("marks string tool result content for context cache", async () => {
    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: "plain tool result",
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "plain tool result",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("marks tool result array content when array tool content is enabled", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          toolContentSupportType: ["array"],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_text",
                content: [
                  {
                    type: "text",
                    text: "first line",
                  },
                  {
                    type: "text",
                    text: "second line",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_text",
      content: [
        {
          type: "text",
          text: "first line",
        },
        {
          type: "text",
          text: "second line",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("openai-compatible provider PDF message content", () => {
  test("sends PDF tool results as file parts when PDF tool content is enabled", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          supportPdf: true,
          toolContentSupportType: ["pdf"],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: "pdf-data",
                    },
                    title: "report.pdf",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: [
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("moves PDF file parts to user messages when tool PDF support is missing", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          supportPdf: true,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_pdf",
                content: [
                  {
                    type: "text",
                    text: "PDF file read: report.pdf",
                  },
                  {
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: "application/pdf",
                      data: "pdf-data",
                    },
                    title: "report.pdf",
                  },
                ],
              },
            ],
          },
        ],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tool_pdf",
      content: "PDF file read: report.pdf",
    })
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "Tool result for tool_pdf:",
        },
        {
          type: "text",
          text: "PDF file read: report.pdf",
        },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,pdf-data",
            filename: "report.pdf",
          },
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })
})

describe("non-dashscope openai-compatible provider restrictions", () => {
  test("strips request-derived thinking_budget for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("thinking_budget")
  })

  test("keeps extraBody thinking_budget for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "qwen-plus": {
          extraBody: {
            thinking_budget: 8192,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(8192)
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
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
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "qwen-plus": {
          contextCache: true,
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
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

  test("detects dashscope via aliyuncs.com in baseUrl", async () => {
    providerConfig = {
      ...providerConfig,
      name: "my-bailian",
      baseUrl: "https://bailian.aliyuncs.com/api/v1",
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/my-bailian/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.thinking_budget).toBe(4096)
  })
})

describe("dashscope preserve_thinking default", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    providerConfig = {
      ...providerConfig,
      models: {
        "qwen-plus": {
          extraBody: {
            preserve_thinking: false,
          },
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      name: "custom",
      baseUrl: "https://api.example.com/v1",
      models: {
        "qwen-plus": {
          toolContentSupportType: [],
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/custom/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        model: "qwen-plus",
      }),
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})
