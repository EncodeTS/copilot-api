import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import {
  countPreparedCopilotMessages,
  generatePreparedCopilotMessages,
  prepareCopilotMessagesRequest,
  preparedMessagesCountDependencies,
  preparedMessagesGenerationDependencies,
} from "../src/routes/messages/prepared-messages"
import { responsesUtilsDependencies } from "../src/routes/responses/utils"
import type { Model } from "../src/services/copilot/get-models"

const originalModels = state.models
const originalCountDependencies = { ...preparedMessagesCountDependencies }
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
    inputTokens: 123,
    mode: "authoritative",
  })
  expect(countCopilotMessagesTokens.mock.calls[0][0]).toMatchObject({
    model: messagesModel.id,
    thinking: { display: "summarized", type: "adaptive" },
  })
})

test("prepared native Messages request falls back only from 404 to its post-preparation Chat estimate", async () => {
  state.models = {
    object: "list",
    data: [messagesModel],
  } as typeof state.models
  preparedMessagesCountDependencies.countCopilotMessagesTokens = () =>
    Promise.reject(
      new HTTPError("missing", new Response("missing", { status: 404 })),
    )
  const getTokenCount = mock((_payload: unknown, _model: Model) =>
    Promise.resolve({ input: 10, output: 0 }),
  )
  preparedMessagesCountDependencies.getTokenCount = getTokenCount

  const prepared = prepareCopilotMessagesRequest({
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
  })
  const result = await countPreparedCopilotMessages(prepared, {
    requestId: "request-1",
  })

  expect(result.mode).toBe("estimate")
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

const createGenerationContext = () =>
  ({
    req: {
      header: () => undefined,
      raw: {
        signal: new AbortController().signal,
      },
    },
  }) as unknown as Parameters<typeof generatePreparedCopilotMessages>[0]
