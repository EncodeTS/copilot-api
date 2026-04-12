import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

const actualStateModule = await import("../src/lib/state")
const actualConfigModule = await import("../src/lib/config")
const actualModelsModule = await import("../src/lib/models")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualUtilsModule = await import("../src/lib/utils")

const state = {
  ...actualStateModule.state,
  manualApprove: false,
  verbose: false,
}

let messagesApiEnabled = true
type SelectedModel = {
  id: string
  supported_endpoints?: Array<string>
}

type FlowCallOptions = {
  requestId: string
  sessionId?: string
  subagentMarker?: unknown
  anthropicBetaHeader?: string
}

let selectedModel: SelectedModel | undefined

const findEndpointModel = mock((_: string, _suffix?: string) => selectedModel)
const handleWithMessagesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("messages"),
)
const handleWithResponsesApi = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("responses"),
)
const handleWithChatCompletions = mock(
  (
    _c: unknown,
    _payload: AnthropicMessagesPayload,
    _options: FlowCallOptions,
  ) => new Response("chat"),
)

await mock.module("~/lib/state", () => ({
  ...actualStateModule,
  state,
}))
await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit: async () => {},
}))
await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  isMessagesApiEnabled: () => messagesApiEnabled,
}))
await mock.module("~/lib/models", () => ({
  ...actualModelsModule,
  findEndpointModel,
}))
await mock.module("~/lib/utils", () => ({
  ...actualUtilsModule,
}))
await mock.module("~/routes/messages/api-flows", () => ({
  handleWithMessagesApi,
  handleWithResponsesApi,
  handleWithChatCompletions,
}))

const { handleCompletion } = await import("../src/routes/messages/handler")

const createApp = () => {
  const app = new Hono()
  app.post("/", handleCompletion)
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
  state.manualApprove = false
  state.verbose = false
  messagesApiEnabled = true
  selectedModel = undefined

  findEndpointModel.mockClear()
  handleWithMessagesApi.mockClear()
  handleWithResponsesApi.mockClear()
  handleWithChatCompletions.mockClear()
})

describe("messages handler orchestration", () => {
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

  test("delegates to the Responses API flow when the model supports /responses", async () => {
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
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("responses")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).toHaveBeenCalledTimes(1)
    expect(handleWithChatCompletions).not.toHaveBeenCalled()
  })

  test("falls back to the Chat Completions flow when no endpoint matches", async () => {
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
      body: JSON.stringify(createPayload()),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("chat")
    expect(handleWithMessagesApi).not.toHaveBeenCalled()
    expect(handleWithResponsesApi).not.toHaveBeenCalled()
    expect(handleWithChatCompletions).toHaveBeenCalledTimes(1)
  })

  test("passes subagent marker and request metadata to the selected flow", async () => {
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

  test("resolves -1m model variant when context-1m beta header is present", async () => {
    const model1m = {
      id: "claude-opus-4.6-1m",
      supported_endpoints: ["/v1/messages"],
    }
    findEndpointModel.mockImplementation((_id: string, suffix?: string) =>
      suffix === "-1m" ? model1m : undefined,
    )

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta":
          "context-1m-2025-08-07,interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify(createPayload({ model: "claude-opus-4-6" })),
    })

    expect(response.status).toBe(200)
    expect(findEndpointModel).toHaveBeenCalledWith("claude-opus-4-6", "-1m")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("claude-opus-4.6-1m")
  })

  test("falls back to base model when context-1m is present but no -1m variant exists", async () => {
    const baseModel = {
      id: "claude-opus-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    // findEndpointModel now handles fallback internally — when suffix "-1m" is
    // passed but no -1m model exists, it returns the base model
    findEndpointModel.mockImplementation(() => baseModel)

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify(createPayload({ model: "claude-opus-4-6" })),
    })

    expect(response.status).toBe(200)
    expect(findEndpointModel).toHaveBeenCalledWith("claude-opus-4-6", "-1m")

    const [, forwardedPayload] = handleWithMessagesApi.mock.calls[0]
    expect(forwardedPayload.model).toBe("claude-opus-4.6")
  })

  test("does not try -1m suffix when context-1m beta header is absent", async () => {
    selectedModel = {
      id: "claude-opus-4.6",
      supported_endpoints: ["/v1/messages"],
    }

    const app = createApp()
    await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify(createPayload({ model: "claude-opus-4-6" })),
    })

    expect(findEndpointModel).toHaveBeenCalledTimes(1)
    expect(findEndpointModel).toHaveBeenCalledWith("claude-opus-4-6", undefined)
  })
})
