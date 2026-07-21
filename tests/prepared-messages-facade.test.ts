import { expect, mock, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { messagesApiFlowDependencies } from "../src/routes/messages/api-flows"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import { createPreparedMessagesFacade } from "../src/routes/messages/prepared-messages/facade"
import {
  createPreparedMessagesPolicyPort,
  type PreparedMessagesPolicySnapshot,
} from "../src/routes/messages/prepared-messages/policy"
import type { MessagesRequestContext } from "../src/routes/messages/request-context"
import type { Model } from "../src/services/copilot/get-models"

const chatModel = {
  id: "gpt-chat",
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    limits: { max_prompt_tokens: 128_000 },
    supports: {},
    tokenizer: "o200k_base",
  },
} as Model

const messagesModel = {
  ...chatModel,
  id: "claude-native",
  supported_endpoints: ["/v1/messages"],
} as Model

const createSnapshot = (
  model: Model,
  overrides: Partial<PreparedMessagesPolicySnapshot> = {},
): PreparedMessagesPolicySnapshot => ({
  catalogLoaded: true,
  claudeTokenMultiplier: 1.15,
  contextManagementMessages: true,
  extraPrompt: "",
  modelMappings: {},
  modelResponsesApiCompactThresholds: {},
  models: [model],
  reasoningEffort: "high",
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  ...overrides,
})

const source: AnthropicMessagesPayload = {
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "model-alias",
}

const createRequestContext = (
  policy: PreparedMessagesPolicySnapshot,
): MessagesRequestContext =>
  Object.freeze({
    policy: createPreparedMessagesPolicyPort(() => policy).snapshot(),
    response: Object.freeze({
      json: (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 }),
      streamSSE: () => new Response(),
    }),
    signal: new AbortController().signal,
  }) as MessagesRequestContext

test("facade exposes only generate and count", () => {
  const facade = createPreparedMessagesFacade()

  expect(Object.keys(facade).sort()).toEqual(["count", "generate"])
  expect(Object.isFrozen(facade)).toBe(true)
})

test("parallel facades keep routing dependencies isolated", async () => {
  const chatHandler = mock(() => Promise.resolve(new Response("chat")))
  const messagesHandler = mock(() => Promise.resolve(new Response("messages")))
  const chatFacade = createPreparedMessagesFacade({
    handleWithChatCompletions: chatHandler,
  })
  const messagesFacade = createPreparedMessagesFacade({
    handleWithMessagesApi: messagesHandler,
  })
  const chatContext = createRequestContext(
    createSnapshot(chatModel, {
      modelMappings: { "model-alias": "gpt-chat" },
    }),
  )
  const messagesContext = createRequestContext(
    createSnapshot(messagesModel, {
      modelMappings: { "model-alias": "claude-native" },
    }),
  )

  const [chatResponse, messagesResponse] = await Promise.all([
    chatFacade.generate(chatContext, source),
    messagesFacade.generate(messagesContext, source),
  ])

  expect(await chatResponse.text()).toBe("chat")
  expect(await messagesResponse.text()).toBe("messages")
  expect(chatHandler).toHaveBeenCalledTimes(1)
  expect(messagesHandler).toHaveBeenCalledTimes(1)
})

test("parallel facades keep leaf flow dependencies isolated", async () => {
  const createChatResult = (content: string) => ({
    choices: [
      {
        finish_reason: "stop" as const,
        index: 0,
        logprobs: null,
        message: { content, role: "assistant" as const },
      },
    ],
    created: 0,
    id: `chatcmpl-${content}`,
    model: chatModel.id,
    object: "chat.completion" as const,
  })
  const firstCreate = mock(() => Promise.resolve(createChatResult("first")))
  const secondCreate = mock(() => Promise.resolve(createChatResult("second")))
  const first = createPreparedMessagesFacade({
    flowDependencies: {
      ...messagesApiFlowDependencies,
      createChatCompletions: firstCreate,
    },
  })
  const second = createPreparedMessagesFacade({
    flowDependencies: {
      ...messagesApiFlowDependencies,
      createChatCompletions: secondCreate,
    },
  })
  const context = createRequestContext(
    createSnapshot(chatModel, {
      modelMappings: { "model-alias": chatModel.id },
    }),
  )

  const [firstResponse, secondResponse] = await Promise.all([
    first.generate(context, source),
    second.generate(context, source),
  ])

  expect(await firstResponse.text()).toContain("first")
  expect(await secondResponse.text()).toContain("second")
  expect(firstCreate).toHaveBeenCalledTimes(1)
  expect(secondCreate).toHaveBeenCalledTimes(1)
})

test("each operation keeps one immutable policy snapshot", async () => {
  let currentModel = chatModel
  let observedFrozen: boolean | undefined
  const policy = createPreparedMessagesPolicyPort(() =>
    createSnapshot(currentModel, {
      modelMappings: { "model-alias": currentModel.id },
    }),
  )
  const facade = createPreparedMessagesFacade({
    handleWithChatCompletions: (_response, _source, options) => {
      currentModel = messagesModel
      observedFrozen = Object.isFrozen(
        (options as typeof options & { selectedModel?: Model }).selectedModel,
      )
      return Promise.resolve(new Response("chat"))
    },
    handleWithMessagesApi: () => Promise.resolve(new Response("messages")),
  })

  expect(
    await (
      await facade.generate(createRequestContext(policy.snapshot()), source)
    ).text(),
  ).toBe("chat")
  expect(
    await (
      await facade.generate(createRequestContext(policy.snapshot()), source)
    ).text(),
  ).toBe("messages")
  expect(observedFrozen).toBe(true)
})

test("Chat translation cannot observe a catalog refresh after the operation snapshot", async () => {
  const originalModels = state.models
  const makeModel = (maxThinkingBudget: number) =>
    ({
      ...chatModel,
      capabilities: {
        ...chatModel.capabilities,
        limits: { max_output_tokens: 10_000, max_prompt_tokens: 128_000 },
        supports: {
          max_thinking_budget: maxThinkingBudget,
          min_thinking_budget: 1024,
        },
      },
    }) as Model
  const oldModel = makeModel(4_000)
  const newModel = makeModel(8_000)
  const thinkingSource: AnthropicMessagesPayload = {
    ...source,
    thinking: { type: "enabled", budget_tokens: 7_000 },
  }
  const observedBudgets: Array<number | undefined> = []
  const facade = createPreparedMessagesFacade({
    handleWithChatCompletions: (_response, _source, _options, payload) => {
      observedBudgets.push(payload.thinking_budget)
      return Promise.resolve(new Response("chat"))
    },
  })

  try {
    const oldContext = createRequestContext(
      createSnapshot(oldModel, {
        modelMappings: { "model-alias": oldModel.id },
      }),
    )
    state.models = { data: [newModel], object: "list" }

    await facade.generate(oldContext, thinkingSource)
    await facade.generate(
      createRequestContext(
        createSnapshot(newModel, {
          modelMappings: { "model-alias": newModel.id },
        }),
      ),
      thinkingSource,
    )
  } finally {
    state.models = originalModels
  }

  expect(observedBudgets).toEqual([4_000, 7_000])
})

test("Responses translation keeps reasoning and prompt policy on the operation snapshot", async () => {
  const responsesModel = {
    ...chatModel,
    id: "gpt-responses-policy",
    supported_endpoints: ["/responses"],
  } as Model
  let extraPrompt = " old-extra"
  let reasoningEffort: PreparedMessagesPolicySnapshot["reasoningEffort"] = "low"
  const policy = createPreparedMessagesPolicyPort(() =>
    createSnapshot(responsesModel, {
      extraPrompt,
      modelMappings: { "model-alias": responsesModel.id },
      reasoningEffort,
    }),
  )
  const oldContext = createRequestContext(policy.snapshot(source.model))
  const observed: Array<{
    effort?: string | null
    instructions?: string | null
  }> = []
  const facade = createPreparedMessagesFacade({
    handleWithResponsesApi: (_response, _source, _options, payload) => {
      observed.push({
        effort: payload.reasoning?.effort,
        instructions: payload.instructions,
      })
      return Promise.resolve(new Response("responses"))
    },
  })
  const payload = { ...source, system: "base" }

  await Promise.resolve()
  extraPrompt = " new-extra"
  reasoningEffort = "high"
  await facade.generate(oldContext, payload)
  await facade.generate(
    createRequestContext(policy.snapshot(source.model)),
    payload,
  )

  expect(observed).toEqual([
    { effort: "low", instructions: "base old-extra" },
    { effort: "high", instructions: "base new-extra" },
  ])
})

test("count and generation share assistant-prefill Chat preparation without exposing a plan", async () => {
  const generatedPayloads: Array<unknown> = []
  const countedPayloads: Array<unknown> = []
  const dualModel = {
    ...chatModel,
    supported_endpoints: ["/responses", "/chat/completions"],
  } as Model
  const context = createRequestContext(
    createSnapshot(dualModel, {
      modelMappings: { "model-alias": "gpt-chat" },
    }),
  )
  const facade = createPreparedMessagesFacade({
    getTokenCount: (payload) => {
      countedPayloads.push(structuredClone(payload))
      return Promise.resolve({ input: 17, output: 0 })
    },
    handleWithChatCompletions: (_response, _source, _options, payload) => {
      generatedPayloads.push(structuredClone(payload))
      return Promise.resolve(new Response("chat"))
    },
  })
  const prefill: AnthropicMessagesPayload = {
    ...source,
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: '{"value":' },
    ],
  }
  const original = structuredClone(prefill)

  await facade.generate(context, prefill)
  const result = await facade.count(context, prefill)

  expect(result).toEqual({ inputTokens: 17, mode: "estimate" })
  expect(countedPayloads).toEqual(generatedPayloads)
  expect(prefill).toEqual(original)
})

test("Responses count observes the same context-managed payload as generation", async () => {
  const responsesModel = {
    ...chatModel,
    id: "gpt-responses",
    supported_endpoints: ["/responses"],
  } as Model
  const generatedPayloads: Array<unknown> = []
  const countedPayloads: Array<unknown> = []
  const context = createRequestContext(
    createSnapshot(responsesModel, {
      modelMappings: { "model-alias": responsesModel.id },
    }),
  )
  const facade = createPreparedMessagesFacade({
    estimateResponsesInputTokens: (payload) => {
      countedPayloads.push(structuredClone(payload))
      return Promise.resolve(321)
    },
    handleWithResponsesApi: (_response, _source, _options, payload) => {
      generatedPayloads.push(structuredClone(payload))
      return Promise.resolve(new Response("responses"))
    },
  })

  await facade.generate(context, source)
  const result = await facade.count(context, source)

  expect(result).toEqual({ inputTokens: 321, mode: "estimate" })
  expect(countedPayloads).toEqual(generatedPayloads)
  expect(countedPayloads[0]).toMatchObject({
    context_management: [{ compact_threshold: 96_000, type: "compaction" }],
    model: responsesModel.id,
  })
})

test("native count builds its Chat fallback only for unavailable count endpoints", async () => {
  const getTokenCount = mock(() => Promise.resolve({ input: 10, output: 0 }))
  let status = 200
  const context = createRequestContext(
    createSnapshot(messagesModel, {
      modelMappings: { "model-alias": messagesModel.id },
    }),
  )
  const facade = createPreparedMessagesFacade({
    countCopilotMessagesTokens: () =>
      status === 200 ?
        Promise.resolve({ input_tokens: 123 })
      : Promise.reject(
          new HTTPError("missing", new Response("missing", { status })),
        ),
    getTokenCount,
  })

  expect(await facade.count(context, source)).toEqual({
    mode: "authoritative",
    response: { input_tokens: 123 },
  })
  expect(getTokenCount).not.toHaveBeenCalled()

  status = 404
  expect(await facade.count(context, source)).toMatchObject({
    fallbackStatus: 404,
    mode: "estimate",
  })
  expect(getTokenCount).toHaveBeenCalledTimes(1)

  status = 500
  expect(facade.count(context, source)).rejects.toBeInstanceOf(HTTPError)
  expect(getTokenCount).toHaveBeenCalledTimes(1)
})

test("request context carries recovery, request identity, and cancellation to generation", async () => {
  const controller = new AbortController()
  const observed: Array<{
    anthropicBetaHeader?: string
    reasoningRecoverySessionId?: string
    requestId: string
    sessionId?: string
    signal?: AbortSignal
  }> = []
  const facade = createPreparedMessagesFacade({
    handleWithMessagesApi: (_response, _payload, options) => {
      observed.push(options)
      return Promise.resolve(new Response("messages"))
    },
  })
  const context = Object.freeze({
    ...createRequestContext(
      createSnapshot(messagesModel, {
        modelMappings: { "model-alias": messagesModel.id },
      }),
    ),
    anthropicBetaHeader: "test-beta",
    reasoningRecoverySessionId: "recovery-session",
    signal: controller.signal,
  })

  await facade.generate(context, source)

  expect(observed[0]).toMatchObject({
    anthropicBetaHeader: "test-beta",
    reasoningRecoverySessionId: "recovery-session",
    sessionId: "recovery-session",
    signal: controller.signal,
  })
  expect(typeof observed[0].requestId).toBe("string")
})

test("Web Search carrier sanitizer remains an independent destination hook", async () => {
  const contexts: Array<unknown> = []
  const context = createRequestContext(
    createSnapshot(messagesModel, {
      modelMappings: { "model-alias": messagesModel.id },
    }),
  )
  const facade = createPreparedMessagesFacade({
    carrierSanitizer: {
      sanitize: (_payload, carrierContext) => {
        contexts.push(carrierContext)
        return { restoredTurns: [] }
      },
    },
    handleWithMessagesApi: () => Promise.resolve(new Response("messages")),
  })

  await facade.generate(context, source)

  expect(contexts).toEqual([
    {
      destination: "messages",
      canonicalTarget: {
        adapter: "anthropic-messages",
        provider: "copilot",
        model: messagesModel.id,
      },
    },
  ])
})
