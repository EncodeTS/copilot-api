import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import type { Model } from "../src/services/copilot/get-models"
import type { GatewayReasoningEffort } from "../src/lib/reasoning-effort"
import { forwardError } from "../src/lib/error"
import { adaptMessagesRouteError } from "../src/routes/messages/route-error"

import {
  compactSummaryPromptStart,
  compactTextOnlyGuard,
} from "../src/lib/compact"

const actualConfigModule = await import("../src/lib/config")
const actualModelsModule = await import("../src/lib/models")
const actualUtilsModule = await import("../src/lib/utils")
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)

let messagesApiEnabled = true
let responsesApiWebSocketEnabled = true
let modelMappings: Record<string, string> = {}
type SelectedModel = {
  id: string
  reasoningEffort?: Array<GatewayReasoningEffort>
  supported_endpoints?: Array<string>
}

type FlowCallOptions = {
  compactType?: number
  reasoningRecoverySessionId?: string
  requestId: string
  sessionId?: string
  signal?: AbortSignal
  subagentMarker?: unknown
  anthropicBetaHeader?: string
}

let selectedModel: SelectedModel | undefined

const findEndpointModel = mock((_: string): Model | undefined =>
  selectedModel ?
    ({
      capabilities: {
        family: "test",
        limits: {},
        object: "model_capabilities",
        supports: {
          ...(selectedModel.reasoningEffort ?
            { reasoning_effort: selectedModel.reasoningEffort }
          : {}),
        },
        tokenizer: "o200k_base",
        type: "chat",
      },
      id: selectedModel.id,
      model_picker_enabled: true,
      name: selectedModel.id,
      object: "model",
      preview: false,
      supported_endpoints: selectedModel.supported_endpoints,
      vendor: "test",
      version: "1",
    } satisfies Model)
  : undefined,
)
const handleWithMessagesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("messages")),
)
const handleWithResponsesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("responses")),
)
const handleWithChatCompletions = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => Promise.resolve(new Response("chat")),
)
const countCopilotMessagesTokens = mock((_payload: AnthropicMessagesPayload) =>
  Promise.resolve({ input_tokens: 42 }),
)

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  isMessagesApiEnabled: () => messagesApiEnabled,
  isResponsesApiWebSocketEnabled: () => responsesApiWebSocketEnabled,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))
await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))
await mock.module("~/lib/utils", () => ({
  ...actualUtilsModule,
}))
const actualPreparedMessagesModule = await import(
  "../src/routes/messages/prepared-messages/facade"
)
const { createPreparedMessagesPolicyPort } = await import(
  "../src/routes/messages/prepared-messages/policy"
)
const testPreparedMessagesPolicy = createPreparedMessagesPolicyPort(() => {
  const lookupModel = modelMappings["original-model"] ?? "original-model"
  const model = selectedModel && findEndpointModel(lookupModel)
  const facadeMappings: Record<string, string> = { ...modelMappings }
  if (model && model.id !== "original-model") {
    facadeMappings["original-model"] = model.id
  }
  return {
    catalogLoaded: false,
    claudeTokenMultiplier: 1.15,
    contextManagementMessages: true,
    extraPrompt: "",
    modelMappings: facadeMappings,
    modelResponsesApiCompactThresholds: {},
    models: model ? [model] : [],
    reasoningEffort: "high",
    useMessagesApi: messagesApiEnabled,
    useResponsesApiWebSocket: responsesApiWebSocketEnabled,
  }
})
const testPreparedMessages =
  actualPreparedMessagesModule.createPreparedMessagesFacade({
    countCopilotMessagesTokens,
    handleWithChatCompletions,
    handleWithMessagesApi,
    handleWithResponsesApi,
  })
const { handleCompletion } = await import("../src/routes/messages/handler")
const { handleCountTokens } = await import(
  "../src/routes/messages/count-tokens-handler"
)
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const createApp = () => {
  const app = new Hono()
  app.post("/", async (c) => {
    try {
      return await handleCompletion(c, {
        preparedMessages: testPreparedMessages,
        preparedMessagesPolicy: testPreparedMessagesPolicy,
      })
    } catch (error) {
      return await forwardError(c, adaptMessagesRouteError(error))
    }
  })
  app.post("/count_tokens", async (c) => {
    try {
      return await handleCountTokens(c, {
        preparedMessages: testPreparedMessages,
        preparedMessagesPolicy: testPreparedMessagesPolicy,
      })
    } catch (error) {
      return await forwardError(c, adaptMessagesRouteError(error))
    }
  })
  return app
}

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "original-model",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
})

beforeEach(() => {
  messagesApiEnabled = true
  responsesApiWebSocketEnabled = true
  modelMappings = {}
  selectedModel = undefined

  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled

  findEndpointModel.mockClear()
  handleWithMessagesApi.mockClear()
  handleWithResponsesApi.mockClear()
  handleWithChatCompletions.mockClear()
  countCopilotMessagesTokens.mockClear()
})

afterEach(() => {
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("messages handler orchestration", () => {
  const effortFlowCases = [
    {
      endpoints: ["/v1/messages"],
      handler: handleWithMessagesApi,
      responseText: "messages",
    },
    {
      endpoints: ["/responses"],
      handler: handleWithResponsesApi,
      responseText: "responses",
    },
    {
      endpoints: ["/chat/completions"],
      handler: handleWithChatCompletions,
      responseText: "chat",
    },
  ] as const

  test("normalizes legal explicit effort once before every flow", async () => {
    for (const { endpoints, handler, responseText } of effortFlowCases) {
      selectedModel = {
        id: "original-model",
        reasoningEffort: ["max"],
        supported_endpoints: [...endpoints],
      }

      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({ output_config: { effort: "max" } }),
        ),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe(responseText)
      expect(handler.mock.calls.at(-1)?.[1].output_config?.effort).toBe("max")
    }
  })

  test("preserves omitted effort before every flow", async () => {
    for (const { endpoints, handler } of effortFlowCases) {
      selectedModel = {
        id: "original-model",
        reasoningEffort: ["max"],
        supported_endpoints: [...endpoints],
      }

      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      })

      expect(response.status).toBe(200)
      expect(handler.mock.calls.at(-1)?.[1].output_config).toBeUndefined()
    }
  })

  test("rejects invalid explicit effort before selecting any flow", async () => {
    for (const { endpoints } of effortFlowCases) {
      selectedModel = {
        id: "original-model",
        reasoningEffort: ["max"],
        supported_endpoints: [...endpoints],
      }

      const response = await createApp().request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...createPayload(),
          output_config: { effort: "future-hyper" },
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Unsupported Messages output_config.effort",
        },
      })
    }
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("resolves mapped identity before shared generation and count preparation", async () => {
    modelMappings = { "original-model": "messages-model" }
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    const tools = [
      {
        name: "lookup",
        description: "Lookup",
        input_schema: { type: "object", properties: {} },
      },
    ]

    const body = JSON.stringify(
      createPayload({
        system: "Keep these instructions",
        temperature: 0.4,
        tools,
      }),
    )
    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    const countResponse = await app.request("/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect(response.status).toBe(200)
    expect(countResponse.status).toBe(200)
    const preparedGenerationPayload = handleWithMessagesApi.mock.calls[0][1]
    const preparedCountPayload = countCopilotMessagesTokens.mock.calls[0][0]
    expect(preparedGenerationPayload).toMatchObject({
      model: "messages-model",
      system: "Keep these instructions",
      temperature: 0.4,
      tools,
    })
    expect(preparedCountPayload).toEqual(preparedGenerationPayload)
  })

  test("forwards the Hono request abort signal to the selected flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }
    const controller = new AbortController()
    const request = new Request("http://localhost/", {
      body: JSON.stringify(createPayload()),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    })

    const response = await createApp().request(request)

    expect(response.status).toBe(200)
    expect(handleWithMessagesApi.mock.calls[0][2].signal).toBe(
      controller.signal,
    )
  })

  test("merges message-level system prompts before forwarding to the selected flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "follow the repo style",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "working on it",
            },
          ],
        },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "keep answers short",
            },
          ],
        },
        {
          role: "user",
          content: "next question",
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.system).toBeUndefined()
    expect(forwardedPayload.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "working on it",
          },
        ],
      },
      {
        role: "user",
        content: "next question",
      },
    ])
  })

  test("preserves executeCode for native Messages and rewrites getDiagnostics", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "mcp__ide__getDiagnostics",
              description: "Old description",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.tools).toEqual([
      {
        name: "mcp__ide__executeCode",
        description: "Execute code in VS Code",
        input_schema: { type: "object" },
      },
      {
        name: "mcp__ide__getDiagnostics",
        description:
          "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace.",
        input_schema: { type: "object" },
      },
      {
        name: "keep_me",
        description: "Keep me",
        input_schema: { type: "object" },
      },
    ])
  })

  test("preserves forced executeCode intent for the Responses bridge", async () => {
    selectedModel = {
      id: "responses-model",
      supported_endpoints: ["/responses"],
    }

    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tool_choice: {
            type: "tool",
            name: "mcp__ide__executeCode",
          },
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    const [, forwardedPayload] = handleWithResponsesApi.mock.calls[0]
    expect(forwardedPayload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__ide__executeCode",
      "keep_me",
    ])
    expect(forwardedPayload.tool_choice).toEqual({
      type: "tool",
      name: "mcp__ide__executeCode",
    })
  })

  test("continues removing eager executeCode from Chat Completions", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: ["/chat/completions"],
    }

    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
            {
              name: "keep_me",
              description: "Keep me",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    const [, forwardedPayload] = handleWithChatCompletions.mock.calls[0]
    expect(forwardedPayload.tools?.map((tool) => tool.name)).toEqual([
      "keep_me",
    ])
    const options = handleWithChatCompletions.mock.calls[0][2]
    expect(options.requestId).toBe(
      actualUtilsModule.generateRequestIdFromPayload(forwardedPayload),
    )
  })

  test("rejects forced executeCode when only Chat Completions is available", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: ["/chat/completions"],
    }

    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          tool_choice: {
            type: "tool",
            name: "mcp__ide__executeCode",
          },
          tools: [
            {
              name: "mcp__ide__executeCode",
              description: "Execute code in VS Code",
              input_schema: { type: "object" },
            },
          ],
        }),
      ),
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
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("preserves tool_result and text blocks by default", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "[Pasted ~4 lines]",
            },
          ],
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "[Pasted ~4 lines]",
        },
      ],
    })
  })

  test("preserves tool reference boundary blocks by default", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload: AnthropicMessagesPayload = {
      model: "original-model",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
              cache_control: {
                type: "ephemeral",
                scope: "user",
              },
            },
          ],
        },
      ],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
        {
          type: "text",
          text: "Tool loaded.",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(payload.messages[0]).toHaveProperty(
      "content.1.cache_control.scope",
      "user",
    )
  })

  test("delegates to the Messages API flow when the model supports /v1/messages", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")
    expect(handleWithMessagesApi).toHaveBeenCalledTimes(1)
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")
  })

  test("maps the requested model before resolving the endpoint model", async () => {
    modelMappings = {
      "claude-opus-4-7": "messages-model",
    }
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload({ model: "claude-opus-4-7" })),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("messages-model")
  })

  test("stabilizes Claude Code billing header before forwarding to the Messages API flow", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  test("stabilizes Claude Code billing header before forwarding to the Responses API flow", async () => {
    selectedModel = {
      id: "responses-model",
      supported_endpoints: ["/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()

    const [, forwardedPayload] = handleWithResponsesApi.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  test("delegates to the Responses API flow when the model supports ws:/responses", async () => {
    responsesApiWebSocketEnabled = true
    selectedModel = {
      id: "responses-ws-model",
      supported_endpoints: ["ws:/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "responses-session-123",
      },
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
    const expectedSessionId = actualUtilsModule.getUUID("responses-session-123")
    expect(
      handleWithResponsesApi.mock.calls[0][2].reasoningRecoverySessionId,
    ).toBe(expectedSessionId)
  })

  test("falls back to Chat Completions for assistant prefill when supported", async () => {
    selectedModel = {
      id: "dual-model",
      supported_endpoints: ["/responses", "/chat/completions"],
    }

    const response = await createApp().request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          messages: [
            { role: "user", content: "Return JSON" },
            { role: "assistant", content: '{"value":' },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("does not delegate compact requests to a ws-only Responses API model", async () => {
    selectedModel = {
      id: "responses-ws-model",
      supported_endpoints: ["ws:/responses"],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          messages: [
            {
              role: "user",
              content: `${compactTextOnlyGuard}\n\n${compactSummaryPromptStart}\n\nPending Tasks:\n- one\n\nCurrent Work:\n- two`,
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("stabilizes Claude Code billing header before falling back to the Chat Completions flow", async () => {
    selectedModel = {
      id: "chat-model",
      supported_endpoints: [],
    }

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        createPayload({
          system: [
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=6fb32;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
            },
          ],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)

    const [, forwardedPayload] = handleWithChatCompletions.mock.calls[0]
    expect(forwardedPayload.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.158.c0c; cc_entrypoint=cli; cch=<stable>;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
    ])
  })

  test("passes warmup request metadata without overriding the requested model", async () => {
    selectedModel = {
      id: "messages-model",
      supported_endpoints: ["/v1/messages"],
    }

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    })

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "warmup-beta",
        "x-session-id": "session-123",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("messages")

    const expectedSessionId = actualUtilsModule.getUUID("session-123")
    const expectedRequestId = actualUtilsModule.generateRequestIdFromPayload(
      payload,
      expectedSessionId,
    )

    const options = handleWithMessagesApi.mock.calls[0][2]
    expect(options.requestId).toBe(expectedRequestId)
    expect(options.sessionId).toBe(expectedSessionId)
    expect(options.subagentMarker).toEqual({
      session_id: "sub-session",
      agent_id: "agent-1",
      agent_type: "Explore",
    })
    expect(options.anthropicBetaHeader).toBe("warmup-beta")
  })
})
