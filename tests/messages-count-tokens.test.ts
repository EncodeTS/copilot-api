import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"
import type { Model } from "../src/services/copilot/get-models"
import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import {
  countTokensHandlerDependencies,
  estimateResponsesInputTokens,
} from "../src/routes/messages/count-tokens-handler"
import { messageRoutes } from "../src/routes/messages/route"

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
const originalDependencies = { ...countTokensHandlerDependencies }

const claudeModel = {
  id: "claude-opus-4.8",
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
  countTokensHandlerDependencies.findEndpointModel = (model) =>
    model === claudeModel.id ? claudeModel : undefined
  countTokensHandlerDependencies.getTokenCount = (payload) =>
    Promise.resolve({
      input: payload.tools?.length ? 20 : 10,
      output: 0,
    })
  countTokensHandlerDependencies.isMessagesApiEnabled = () => true
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
  Object.assign(countTokensHandlerDependencies, originalDependencies)
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
      model: "claude-opus-4.8",
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
    model: "claude-opus-4.8",
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
      model: "claude-opus-4.8",
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

test("Claude count_tokens falls back only when Copilot has no count endpoint", async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(new Response("not found", { status: 404 })),
  )

  const app = createApp()
  const withToolResponse = await app.request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "claude-opus-4.8",
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
      model: "claude-opus-4.8",
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
  countTokensHandlerDependencies.findEndpointModel = (model) =>
    model === gptModel.id ? gptModel : undefined
  const estimateResponses = mock((_payload: ResponsesPayload, _model: Model) =>
    Promise.resolve(321),
  )
  countTokensHandlerDependencies.estimateResponsesInputTokens =
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

test("GPT Responses estimator stays conservative on official usage fixtures", async () => {
  const basePayload: ResponsesPayload = {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content:
          "Reply with exactly SIMPLE_ENGLISH_20260713T141029768Z_OK and nothing else.",
      },
    ],
    instructions: null,
    tools: null,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "none", summary: "detailed" },
    context_management: [{ type: "compaction", compact_threshold: 829_800 }],
  }
  const toolPayload: ResponsesPayload = {
    ...basePayload,
    input: [
      {
        type: "message",
        role: "user",
        content:
          "Reply with exactly ONE_TOOL_20260713T141029768Z_OK and nothing else.",
      },
    ],
    tool_choice: "none",
    tools: [
      {
        type: "function",
        name: "protocol_lookup",
        description:
          "Look up one protocol record by an exact query and return metadata.",
        strict: false,
        parameters: {
          type: "object",
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
      },
    ],
  }
  const fixtures = [
    { payload: basePayload, actualInputTokens: 26, maxRatio: 4 },
    { payload: toolPayload, actualInputTokens: 112, maxRatio: 2 },
  ]

  for (const fixture of fixtures) {
    const estimate = await estimateResponsesInputTokens(
      fixture.payload,
      gptModel,
    )
    expect(estimate).toBeGreaterThanOrEqual(fixture.actualInputTokens)
    expect(estimate).toBeLessThanOrEqual(
      fixture.actualInputTokens * fixture.maxRatio,
    )
  }
})

test("unknown models use the explicitly labeled local fallback estimator", async () => {
  countTokensHandlerDependencies.findEndpointModel = () => undefined

  const response = await createApp().request("/v1/messages/count_tokens", {
    body: JSON.stringify({
      model: "unknown-model",
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
})
