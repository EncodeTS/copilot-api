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
  test("records usage from Responses provider streams", async () => {
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

    const app = createApp()
    const response = await app.request("/dash/v1/messages", {
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
    })

    expect(response.status).toBe(200)
    await response.text()
    expect(providerUsageRecorder).toHaveBeenCalledWith({
      cache_read_input_tokens: 2,
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 16,
    })
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
