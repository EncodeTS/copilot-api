import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import { handleCopilotMessages } from "../src/routes/messages/translation-orchestrator"
import {
  countPreparedCopilotMessages,
  preparedMessagesCountDependencies,
} from "../src/routes/messages/prepared-messages/count"
import {
  prepareCopilotMessagesRequest,
  preparedMessagesCoreDependencies,
} from "../src/routes/messages/prepared-messages/core"
import {
  generatePreparedCopilotMessages,
  preparedMessagesGenerationDependencies,
} from "../src/routes/messages/prepared-messages/generate"
import { responsesUtilsDependencies } from "../src/routes/responses/utils"
import type { Model } from "../src/services/copilot/get-models"

const originalModels = state.models
const originalCountDependencies = { ...preparedMessagesCountDependencies }
const originalCoreDependencies = { ...preparedMessagesCoreDependencies }
const originalGenerationDependencies = {
  ...preparedMessagesGenerationDependencies,
}
const originalResponsesDependencies = { ...responsesUtilsDependencies }

const dualModel = {
  id: "gpt-dual",
  supported_endpoints: ["/responses", "/chat/completions"],
  capabilities: {
    limits: { max_prompt_tokens: 128_000 },
    supports: {},
    tokenizer: "o200k_base",
  },
} as Model

const responsesModel = {
  id: "gpt-responses",
  supported_endpoints: ["/responses"],
  capabilities: {
    limits: { max_prompt_tokens: 128_000 },
    supports: {},
    tokenizer: "o200k_base",
  },
} as Model

const messagesModel = {
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

beforeEach(() => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
})

afterEach(() => {
  state.models = originalModels
  Object.assign(preparedMessagesCountDependencies, originalCountDependencies)
  Object.assign(preparedMessagesCoreDependencies, originalCoreDependencies)
  Object.assign(
    preparedMessagesGenerationDependencies,
    originalGenerationDependencies,
  )
  Object.assign(responsesUtilsDependencies, originalResponsesDependencies)
})

test("prepared Messages request selects Chat for assistant prefill without mutating caller input", async () => {
  const payload: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: '{"value":' },
    ],
    model: dualModel.id,
    tools: [
      {
        name: "mcp__ide__executeCode",
        description: "Execute code",
        input_schema: { type: "object" },
      },
    ],
  }
  const original = structuredClone(payload)
  const getTokenCount = mock((_payload: unknown, _model: Model) =>
    Promise.resolve({ input: 10, output: 0 }),
  )
  preparedMessagesCountDependencies.getTokenCount = getTokenCount

  const prepared = prepareCopilotMessagesRequest(payload)
  const result = await countPreparedCopilotMessages(prepared)

  expect(result).toEqual({
    inputTokens: 10,
    mode: "estimate",
  })
  expect(getTokenCount.mock.calls[0][0]).toMatchObject({
    model: dualModel.id,
    tools: [],
  })
  expect(payload).toEqual(original)
})

test("prepared Responses request shares generation context management with token estimation", async () => {
  state.models = {
    object: "list",
    data: [responsesModel],
  } as typeof state.models
  const estimateResponsesInputTokens = mock(
    (_payload: unknown, _model: Model) => Promise.resolve(321),
  )
  preparedMessagesCountDependencies.estimateResponsesInputTokens =
    estimateResponsesInputTokens

  const prepared = prepareCopilotMessagesRequest({
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: responsesModel.id,
  })
  const result = await countPreparedCopilotMessages(prepared)

  expect(result).toEqual({
    inputTokens: 321,
    mode: "estimate",
  })
  expect(estimateResponsesInputTokens.mock.calls[0][0]).toMatchObject({
    context_management: [
      {
        compact_threshold: 96000,
        type: "compaction",
      },
    ],
    model: responsesModel.id,
  })
})

test("prepared native Messages request uses its final generation payload for authoritative count", async () => {
  state.models = {
    object: "list",
    data: [messagesModel],
  } as typeof state.models
  const countCopilotMessagesTokens = mock(
    (_payload: AnthropicMessagesPayload) =>
      Promise.resolve({ input_tokens: 123 }),
  )
  preparedMessagesCountDependencies.countCopilotMessagesTokens =
    countCopilotMessagesTokens

  const prepared = prepareCopilotMessagesRequest({
    max_tokens: 32_000,
    messages: [{ role: "user", content: "hello" }],
    model: messagesModel.id,
    thinking: { type: "enabled", budget_tokens: 31_999 },
  })
  const result = await countPreparedCopilotMessages(prepared, {
    requestId: "request-1",
  })

  expect(result).toEqual({
    mode: "authoritative",
    response: {
      input_tokens: 123,
    },
  })
  expect(countCopilotMessagesTokens.mock.calls[0][0]).toMatchObject({
    model: messagesModel.id,
    thinking: { display: "summarized", type: "adaptive" },
  })
})

test("prepared native Messages request falls back only from 404 or 501 to its post-preparation Chat estimate", async () => {
  state.models = {
    object: "list",
    data: [messagesModel],
  } as typeof state.models
  const getTokenCount = mock((_payload: unknown, _model: Model) =>
    Promise.resolve({ input: 10, output: 0 }),
  )
  preparedMessagesCountDependencies.getTokenCount = getTokenCount

  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: messagesModel.id,
    tools: [
      {
        name: "mcp__ide__executeCode",
        description: "Execute code",
        input_schema: { type: "object" },
      },
    ],
  }

  for (const status of [404, 501] as const) {
    preparedMessagesCountDependencies.countCopilotMessagesTokens = () =>
      Promise.reject(
        new HTTPError("missing", new Response("missing", { status })),
      )
    const result = await countPreparedCopilotMessages(
      prepareCopilotMessagesRequest(source),
      {
        requestId: "request-1",
      },
    )
    expect(result).toMatchObject({
      fallbackStatus: status,
      mode: "estimate",
    })
  }
  expect(getTokenCount).toHaveBeenCalledTimes(2)
  expect(getTokenCount.mock.calls[0][0]).toMatchObject({
    tools: [
      {
        function: {
          name: "mcp__ide__executeCode",
        },
        type: "function",
      },
    ],
  })
})

test("generation and Count Tokens consume the same final native Messages preparation", async () => {
  state.models = {
    object: "list",
    data: [messagesModel],
  } as typeof state.models
  const generatedPayloads: Array<AnthropicMessagesPayload> = []
  const countedPayloads: Array<AnthropicMessagesPayload> = []
  preparedMessagesGenerationDependencies.handleWithMessagesApi = (
    _c,
    payload,
  ) => {
    generatedPayloads.push(structuredClone(payload))
    return Promise.resolve(new Response("generated"))
  }
  preparedMessagesCountDependencies.countCopilotMessagesTokens = (payload) => {
    countedPayloads.push(structuredClone(payload))
    return Promise.resolve({ input_tokens: 20 })
  }
  const source: AnthropicMessagesPayload = {
    max_tokens: 32_000,
    messages: [{ role: "user", content: "hello" }],
    model: messagesModel.id,
    thinking: { type: "enabled", budget_tokens: 31_999 },
  }

  await generatePreparedCopilotMessages(
    createGenerationContext(),
    prepareCopilotMessagesRequest(source),
  )
  await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source))

  expect(generatedPayloads).toHaveLength(1)
  expect(countedPayloads).toEqual(generatedPayloads)
})

test("generation and Count Tokens consume the same estimate-bearing Responses preparation", async () => {
  state.models = {
    object: "list",
    data: [responsesModel],
  } as typeof state.models
  const generatedPayloads: Array<unknown> = []
  const countedPayloads: Array<unknown> = []
  preparedMessagesGenerationDependencies.handleWithResponsesApi = (
    _c,
    _source,
    _options,
    payload,
  ) => {
    generatedPayloads.push(structuredClone(payload))
    return Promise.resolve(new Response("generated"))
  }
  preparedMessagesCountDependencies.estimateResponsesInputTokens = (
    payload,
  ) => {
    countedPayloads.push(structuredClone(payload))
    return Promise.resolve(20)
  }
  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: responsesModel.id,
  }

  await generatePreparedCopilotMessages(
    createGenerationContext(),
    prepareCopilotMessagesRequest(source),
  )
  await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source))

  expect(generatedPayloads).toHaveLength(1)
  expect(countedPayloads).toEqual(generatedPayloads)
})

test("generation and Count Tokens consume the same estimate-bearing Chat preparation", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const generatedPayloads: Array<unknown> = []
  const countedPayloads: Array<unknown> = []
  preparedMessagesGenerationDependencies.handleWithChatCompletions = (
    _c,
    _source,
    _options,
    payload,
  ) => {
    generatedPayloads.push(structuredClone(payload))
    return Promise.resolve(new Response("generated"))
  }
  preparedMessagesCountDependencies.getTokenCount = (payload) => {
    countedPayloads.push(structuredClone(payload))
    return Promise.resolve({ input: 20, output: 0 })
  }
  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: '{"value":' },
    ],
    model: dualModel.id,
  }

  await generatePreparedCopilotMessages(
    createGenerationContext(),
    prepareCopilotMessagesRequest(source),
  )
  await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source))

  expect(generatedPayloads).toHaveLength(1)
  expect(countedPayloads).toEqual(generatedPayloads)
})

test("Chat estimation observes caller cancellation without invoking the tokenizer", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const getTokenCount = mock(() => Promise.resolve({ input: 20, output: 0 }))
  preparedMessagesCountDependencies.getTokenCount = getTokenCount
  const controller = new AbortController()
  const reason = new Error("cancelled")
  controller.abort(reason)

  let thrown: unknown
  try {
    await countPreparedCopilotMessages(
      prepareCopilotMessagesRequest({
        max_tokens: 128,
        messages: [
          { role: "user", content: "Return JSON" },
          { role: "assistant", content: '{"value":' },
        ],
        model: dualModel.id,
      }),
      { signal: controller.signal },
    )
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBe(reason)
  expect(getTokenCount).not.toHaveBeenCalled()
})

test("Chat estimation yields so in-flight cancellation interrupts warmed tokenization", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [
      { role: "user", content: "x".repeat(50_000) },
      { role: "assistant", content: '{"value":' },
    ],
    model: dualModel.id,
  }
  await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source))

  const controller = new AbortController()
  const reason = new Error("cancelled during count")
  const timer = setTimeout(() => controller.abort(reason), 1)
  let thrown: unknown
  try {
    await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source), {
      signal: controller.signal,
    })
  } catch (error) {
    thrown = error
  } finally {
    clearTimeout(timer)
  }

  expect(thrown).toBe(reason)
})

test("worker-backed Chat estimation preserves exact token counts", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [
      { role: "user", content: "x".repeat(50_000) },
      { role: "assistant", content: '{"value":' },
    ],
    model: dualModel.id,
  }

  const synchronous = await countPreparedCopilotMessages(
    prepareCopilotMessagesRequest(source),
  )
  const workerBacked = await countPreparedCopilotMessages(
    prepareCopilotMessagesRequest(source),
    { signal: new AbortController().signal },
  )

  expect(workerBacked).toEqual(synchronous)
})

test("Count Tokens does not invoke generation adapters", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const generationCalled = mock(() => {})
  preparedMessagesGenerationDependencies.handleWithChatCompletions = () => {
    generationCalled()
    return Promise.reject(new Error("generation must remain unreachable"))
  }
  preparedMessagesGenerationDependencies.handleWithMessagesApi = () => {
    generationCalled()
    return Promise.reject(new Error("generation must remain unreachable"))
  }
  preparedMessagesGenerationDependencies.handleWithResponsesApi = () => {
    generationCalled()
    return Promise.reject(new Error("generation must remain unreachable"))
  }
  preparedMessagesCountDependencies.getTokenCount = () =>
    Promise.resolve({ input: 20, output: 0 })

  await countPreparedCopilotMessages(
    prepareCopilotMessagesRequest({
      max_tokens: 128,
      messages: [
        { role: "user", content: "Return JSON" },
        { role: "assistant", content: '{"value":' },
      ],
      model: dualModel.id,
    }),
  )

  expect(generationCalled).not.toHaveBeenCalled()
})

test("generation rethrows transport HTTP errors for the route error adapter", async () => {
  state.models = {
    object: "list",
    data: [dualModel],
  } as typeof state.models
  const expected = new HTTPError(
    "upstream failed",
    new Response("plain upstream failure", { status: 502 }),
  )
  preparedMessagesGenerationDependencies.handleWithChatCompletions = () =>
    Promise.reject(expected)
  let thrown: unknown

  try {
    await handleCopilotMessages(createGenerationContext(), {
      max_tokens: 128,
      messages: [
        { role: "user", content: "Return JSON" },
        { role: "assistant", content: '{"value":' },
      ],
      model: dualModel.id,
    })
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBe(expected)
})

test("native Messages count preserves non-fallback upstream errors", async () => {
  state.models = {
    object: "list",
    data: [messagesModel],
  } as typeof state.models
  const source: AnthropicMessagesPayload = {
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    model: messagesModel.id,
  }

  for (const status of [401, 429, 500]) {
    const expected = new HTTPError(
      `upstream ${status}`,
      new Response("failed", { status }),
    )
    preparedMessagesCountDependencies.countCopilotMessagesTokens = () =>
      Promise.reject(expected)
    let thrown: unknown
    try {
      await countPreparedCopilotMessages(prepareCopilotMessagesRequest(source))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(expected)
  }
})

test("fallback Chat estimation preserves trimmed unknown model behavior", async () => {
  state.models = undefined
  preparedMessagesCoreDependencies.findEndpointModel = () => undefined
  const getTokenCount = mock((_payload: unknown, _model: Model) =>
    Promise.resolve({ input: 20, output: 0 }),
  )
  preparedMessagesCountDependencies.getTokenCount = getTokenCount

  await countPreparedCopilotMessages(
    prepareCopilotMessagesRequest({
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      model: " claude-unknown ",
    }),
  )

  expect(getTokenCount.mock.calls[0][0]).toMatchObject({
    model: "claude-unknown",
  })
})

const createGenerationContext = () =>
  ({
    req: {
      header: () => undefined,
      raw: {
        signal: new AbortController().signal,
      },
    },
  }) as unknown as Parameters<typeof generatePreparedCopilotMessages>[0]
