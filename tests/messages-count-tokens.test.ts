import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import type { Model } from "../src/services/copilot/get-models"
import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import {
  compactSummaryPromptStart,
  compactTextOnlyGuard,
} from "../src/lib/compact"
import {
  estimateResponsesInputTokens,
  ResponsesTokenEstimateLimitError,
} from "../src/routes/messages/count-tokens-handler"
import { preparedMessagesCountDependencies } from "../src/routes/messages/prepared-messages/count"
import { preparedMessagesCoreDependencies } from "../src/routes/messages/prepared-messages/core"
import { messageRoutes } from "../src/routes/messages/route"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import { translateAnthropicMessagesToResponsesPayload } from "../src/routes/messages/responses-translation"
import { countMessagesTokens } from "../src/services/copilot/create-messages"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  models: state.models,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalCountDependencies = { ...preparedMessagesCountDependencies }
const originalCoreDependencies = { ...preparedMessagesCoreDependencies }

const claudeModel = {
  id: "claude-opus-4-8",
  supported_endpoints: ["/v1/messages"],
  capabilities: {
    limits: { max_prompt_tokens: 200_000 },
    supports: {
      adaptive_thinking: true,
      max_thinking_budget: 32_000,
      reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
    },
    tokenizer: "o200k_base",
  },
} as Model

const gptModel = {
  id: "gpt-5.6-sol",
  supported_endpoints: ["/responses"],
  capabilities: {
    limits: { max_prompt_tokens: 372_000 },
    supports: {
      reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
    },
    tokenizer: "o200k_base",
  },
} as Model

const chatModel = {
  ...gptModel,
  id: "gpt-chat",
  supported_endpoints: ["/chat/completions"],
} as Model

const fetchMock = mock((_input: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(JSON.stringify({ input_tokens: 123 }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  return app
}

beforeEach(() => {
  state.accountType = "individual"
  state.copilotApiUrl = "https://copilot.example"
  state.copilotToken = "copilot-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [claudeModel],
  } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = (model) =>
    model === claudeModel.id ? claudeModel : undefined
  preparedMessagesCountDependencies.getTokenCount = (payload) =>
    Promise.resolve({
      input: payload.tools?.length ? 20 : 10,
      output: 0,
    })
  preparedMessagesCoreDependencies.isMessagesApiEnabled = () => true
  process.env.ANTHROPIC_API_KEY = "must-not-be-used"
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.macMachineId = originalState.macMachineId
  state.models = originalState.models
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  Object.assign(preparedMessagesCountDependencies, originalCountDependencies)
  Object.assign(preparedMessagesCoreDependencies, originalCoreDependencies)
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

test("Claude count_tokens forwards the final native Messages request to Copilot", async () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  }
  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled", budget_tokens: 31_999 },
      temperature: 0.7,
      output_config: {
        format: { type: "json_schema", schema },
      },
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code in the IDE",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
    headers: {
      "anthropic-beta": "context-management-2025-06-27",
      "content-type": "application/json",
    },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 123 })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe("https://copilot.example/v1/messages/count_tokens")
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer copilot-token",
  )
  expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
    "context-management-2025-06-27",
  )
  expect(JSON.parse(init?.body as string)).toMatchObject({
    model: "claude-opus-4-8",
    max_tokens: 32_000,
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "adaptive", display: "summarized" },
    temperature: 0.7,
    output_config: {
      effort: "max",
      format: { type: "json_schema", schema },
    },
    tools: [
      {
        name: "mcp__ide__executeCode",
        description: "Execute code in the IDE",
        input_schema: { type: "object", properties: {} },
      },
    ],
  })
})

test("Claude count_tokens preserves the official count endpoint's accounting", async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ input_tokens: 59, accounting: "upstream" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
    ),
  )

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  // The official count endpoint includes request construction overhead. It is
  // not expected to equal generation usage.input_tokens for the visible text.
  expect(await response.json()).toEqual({
    input_tokens: 59,
    accounting: "upstream",
  })
})

test("Claude count_tokens preserves Copilot validation errors", async () => {
  const upstreamError = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "invalid tool schema",
    },
  }
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(
      new Response(JSON.stringify(upstreamError), {
        headers: { "content-type": "application/json" },
        status: 400,
      }),
    ),
  )

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual(upstreamError)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Claude count_tokens applies the upstream HTTP lifecycle", async () => {
  fetchMock.mockImplementationOnce(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error("missing request signal"))
          return
        }
        const rejectFromSignal = () =>
          reject(
            signal.reason instanceof Error ?
              signal.reason
            : new Error("request aborted"),
          )
        if (signal.aborted) {
          rejectFromSignal()
          return
        }
        signal.addEventListener("abort", rejectFromSignal, { once: true })
      }),
  )

  let thrown: unknown
  try {
    await countMessagesTokens(
      {
        model: claudeModel.id,
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
      undefined,
      {
        requestId: "request-1",
        timeouts: { httpHeadersMs: 5 },
      },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(UpstreamLifecycleTimeoutError)
  expect((thrown as UpstreamLifecycleTimeoutError).phase).toBe("HTTP headers")
})

test("Claude count_tokens falls back only when Copilot has no count endpoint", async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(new Response("not found", { status: 404 })),
  )

  const app = createApp()
  const withToolResponse = await app.request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code in the IDE",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
          },
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(new Response("not found", { status: 404 })),
  )
  const withoutToolResponse = await app.request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(withToolResponse.status).toBe(200)
  expect(withToolResponse.headers.get("x-copilot-api-token-count-mode")).toBe(
    "estimate",
  )
  const withTool = (await withToolResponse.json()) as { input_tokens: number }
  const withoutTool = (await withoutToolResponse.json()) as {
    input_tokens: number
  }
  expect(withTool.input_tokens).toBeGreaterThan(withoutTool.input_tokens)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("GPT count_tokens estimates the final Responses payload without calling Messages count", async () => {
  state.models = {
    object: "list",
    data: [gptModel],
  } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = (model) =>
    model === gptModel.id ? gptModel : undefined
  const estimateResponses = mock((_payload: ResponsesPayload, _model: Model) =>
    Promise.resolve(321),
  )
  preparedMessagesCountDependencies.estimateResponsesInputTokens =
    estimateResponses

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      max_tokens: 100,
      messages: [{ role: "user", content: "return structured output" }],
      temperature: 0.7,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "max",
        format: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
      tools: [],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ input_tokens: 321 })
  expect(response.headers.get("x-copilot-api-token-count-mode")).toBe(
    "estimate",
  )
  expect(fetchMock).not.toHaveBeenCalled()
  expect(estimateResponses).toHaveBeenCalledTimes(1)
  expect(estimateResponses.mock.calls[0][0]).toMatchObject({
    model: "gpt-5.6-sol",
    max_output_tokens: 100,
    temperature: 0.7,
    parallel_tool_calls: false,
    reasoning: {
      effort: "max",
      summary: "auto",
      context: "all_turns",
    },
    text: {
      format: {
        type: "json_schema",
        name: "anthropic_output",
        strict: true,
        schema: { type: "object" },
      },
    },
    tools: [],
  })
  expect(estimateResponses.mock.calls[0][0]).not.toHaveProperty("tool_choice")
})

test("Count Tokens rejects assistant prefill for a Responses-only model", async () => {
  state.models = {
    object: "list",
    data: [gptModel],
  } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = (model) =>
    model === gptModel.id ? gptModel : undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: gptModel.id,
      max_tokens: 100,
      messages: [
        { role: "user", content: "Return JSON" },
        { role: "assistant", content: '{"value":' },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Assistant prefill is not supported by the Responses API bridge.",
    },
  })
})

test("Count Tokens rejects forced executeCode for a Chat-only model", async () => {
  state.models = {
    object: "list",
    data: [chatModel],
  } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = (model) =>
    model === chatModel.id ? chatModel : undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: chatModel.id,
      max_tokens: 100,
      messages: [{ role: "user", content: "run code" }],
      tool_choice: {
        type: "tool",
        name: "mcp__ide__executeCode",
      },
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "mcp__ide__executeCode is not supported by the Chat Completions fallback.",
    },
  })
})

test("Count Tokens uses Chat estimation for compact requests on ws-only models", async () => {
  const wsOnlyModel = {
    ...gptModel,
    id: "gpt-ws-only",
    supported_endpoints: ["ws:/responses"],
  } as Model
  state.models = {
    object: "list",
    data: [wsOnlyModel],
  } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = (model) =>
    model === wsOnlyModel.id ? wsOnlyModel : undefined
  const estimateResponses = mock(() => Promise.resolve(321))
  preparedMessagesCountDependencies.estimateResponsesInputTokens =
    estimateResponses

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: wsOnlyModel.id,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `${compactTextOnlyGuard}\n\n${compactSummaryPromptStart}\n\nPending Tasks:\n- one`,
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-copilot-api-token-count-mode")).toBe(
    "estimate",
  )
  expect(estimateResponses).not.toHaveBeenCalled()
})

test("GPT Responses estimator stays within the conservative live-usage band", async () => {
  const nonce = "20260715T000000000Z"
  const shortText = (id: string) =>
    `Reply with exactly ${id}_${nonce}_OK and nothing else.`
  const toolSchema = (name: string, description: string) => ({
    name,
    description,
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The exact query to execute without rewriting.",
        },
        options: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            include_metadata: { type: "boolean" },
            tags: {
              type: "array",
              items: { type: "string" },
              maxItems: 12,
            },
          },
          required: ["limit"],
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  })
  const cases: Array<{
    actualInputTokens: number
    id: string
    payload: AnthropicMessagesPayload
  }> = [
    {
      id: "simple",
      actualInputTokens: 26,
      payload: {
        model: gptModel.id,
        messages: [{ role: "user", content: shortText("SIMPLE_ENGLISH") }],
        max_tokens: 64,
        thinking: { type: "disabled" },
        stream: true,
      },
    },
    {
      id: "system_multiturn",
      actualInputTokens: 484,
      payload: {
        model: gptModel.id,
        system:
          "You are a precise protocol-audit assistant. Preserve literals.",
        messages: [
          {
            role: "user",
            content: `Remember the literal alpha-${nonce}.`,
          },
          {
            role: "assistant",
            content: `I will remember alpha-${nonce}.`,
          },
          { role: "user", content: shortText("SYSTEM_MULTITURN") },
        ],
        max_tokens: 64,
        thinking: { type: "disabled" },
        stream: true,
      },
    },
    {
      id: "chinese_code",
      actualInputTokens: 516,
      payload: {
        model: gptModel.id,
        system: [
          {
            type: "text",
            text: "严格保留代码中的标点、Unicode 字符和换行。",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `这是一次 token 计数校验，标记为 ${nonce}。`,
                  "```ts",
                  "export const greet = (name: string) => `你好，${name}！`",
                  "const rows = [1, 2, 3].map((value) => value ** 2)",
                  "```",
                  shortText("CHINESE_CODE"),
                ].join("\n"),
              },
            ],
          },
        ],
        max_tokens: 64,
        thinking: { type: "disabled" },
        stream: true,
      },
    },
    {
      id: "one_tool",
      actualInputTokens: 112,
      payload: {
        model: gptModel.id,
        messages: [{ role: "user", content: shortText("ONE_TOOL") }],
        tools: [
          toolSchema(
            "protocol_lookup",
            "Look up one protocol record by an exact query and return metadata.",
          ),
        ],
        tool_choice: { type: "none" },
        max_tokens: 64,
        thinking: { type: "disabled" },
        stream: true,
      },
    },
    {
      id: "large_tool_bundle",
      actualInputTokens: 373,
      payload: {
        model: gptModel.id,
        messages: [{ role: "user", content: shortText("LARGE_TOOL_BUNDLE") }],
        tools: [
          toolSchema(
            "search_repository",
            "Search repository paths, filenames, symbols, documentation, and code comments. Use an exact query and preserve case-sensitive identifiers.",
          ),
          toolSchema(
            "read_document",
            "Read a selected document and return its complete structured content, including headings, code blocks, tables, and source metadata.",
          ),
          toolSchema(
            "inspect_runtime",
            "Inspect a named runtime component without mutating it. Return status, version, resource limits, and recent non-sensitive diagnostics.",
          ),
          toolSchema(
            "compare_payloads",
            "Compare two protocol payloads field by field. Distinguish missing, null, rewritten, reordered, and semantically incompatible values.",
          ),
        ],
        tool_choice: { type: "none" },
        max_tokens: 64,
        thinking: { type: "disabled" },
        stream: true,
      },
    },
  ]

  for (const fixture of cases) {
    const payload = translateAnthropicMessagesToResponsesPayload(
      fixture.payload,
    )
    const estimate = await estimateResponsesInputTokens(payload, gptModel)
    expect(estimate).toBeGreaterThanOrEqual(
      Math.ceil(fixture.actualInputTokens * 1.04),
    )
    expect(estimate).toBeLessThanOrEqual(
      Math.ceil(fixture.actualInputTokens * 1.15),
    )
  }
})

test("GPT Responses estimator rejects excessive input structure before tokenizing it", () => {
  const input = Array.from({ length: 10_001 }, () => ({
    content: "x",
    role: "user" as const,
    type: "message" as const,
  }))

  expect(
    estimateResponsesInputTokens({ input, model: gptModel.id }, gptModel),
  ).rejects.toBeInstanceOf(ResponsesTokenEstimateLimitError)
})

test("GPT Responses estimator observes caller cancellation during local work", () => {
  const controller = new AbortController()
  const reason = new Error("count request cancelled")
  controller.abort(reason)

  expect(
    estimateResponsesInputTokens(
      { input: "hello", model: gptModel.id },
      gptModel,
      { signal: controller.signal },
    ),
  ).rejects.toBe(reason)
})

test("GPT Responses estimator observes cancellation at an injected yield", async () => {
  const controller = new AbortController()
  const reason = new Error("cancel pathological tokenization")
  const yieldControl = mock(() => {
    controller.abort(reason)
    return Promise.resolve()
  })
  let thrown: unknown

  try {
    await estimateResponsesInputTokens(
      { input: "x".repeat(16_385), model: gptModel.id },
      gptModel,
      { signal: controller.signal, yieldControl },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBe(reason)
  expect(yieldControl).toHaveBeenCalledTimes(1)
})

test("GPT count_tokens returns a structured 400 for estimator safety limits", async () => {
  state.models = { object: "list", data: [gptModel] } as typeof state.models
  preparedMessagesCoreDependencies.findEndpointModel = () => gptModel
  preparedMessagesCountDependencies.estimateResponsesInputTokens = () =>
    Promise.reject(
      new ResponsesTokenEstimateLimitError(
        "Responses token estimate exceeds the maximum node count of 10000",
      ),
    )

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: gptModel.id,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Responses token estimate exceeds the maximum node count of 10000",
    },
  })
})

test("models absent from a loaded Copilot catalog fail instead of returning a fake count", async () => {
  preparedMessagesCoreDependencies.findEndpointModel = () => undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "unknown-model",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "The requested model is not supported by the current Copilot model catalog: unknown-model",
    },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

test("catalog rejection precedes prepared-flow validation", async () => {
  preparedMessagesCoreDependencies.findEndpointModel = () => undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "unknown-model",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "mcp__ide__executeCode",
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "The requested model is not supported by the current Copilot model catalog: unknown-model",
    },
  })
})

test("an unavailable Copilot catalog keeps the fallback explicitly labeled", async () => {
  state.models = undefined
  preparedMessagesCoreDependencies.findEndpointModel = () => undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "catalog-not-loaded-yet",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("x-copilot-api-token-count-mode")).toBe(
    "estimate",
  )
  expect(
    typeof ((await response.json()) as { input_tokens: number }).input_tokens,
  ).toBe("number")
  expect(fetchMock).not.toHaveBeenCalled()
})
