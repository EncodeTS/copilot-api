import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { createResponses as createCopilotResponses } from "../src/services/copilot/create-responses"

let responsesApiWebSocketEnabled = true
const originalFetch = globalThis.fetch

const createResponses = mock((() =>
  Promise.resolve(streamChunks([]))) as typeof createCopilotResponses)

const createResponsesResult = (model: string) => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response" as const,
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const { state } = await import("../src/lib/state")
const { closeUsageStore } = await import("../src/lib/token-usage")
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")
const { responsesHandlerDependencies } = await import(
  "../src/routes/responses/handler"
)
const { responsesRoutes } = await import("../src/routes/responses/route")
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)
const { generateRequestIdFromPayload, getUUID } = await import(
  "../src/lib/utils"
)
const { HTTPError } = await import("../src/lib/error")

const defaultResponsesHandlerDependencies = {
  ...responsesHandlerDependencies,
}
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  models: state.models,
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

async function* streamChunksThenThrow(
  items: Array<Record<string, unknown>>,
  message: string,
) {
  yield* streamChunks(items)
  throw new Error(message)
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.macMachineId = "machine-1"
  state.verbose = false
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  responsesApiWebSocketEnabled = true
  responsesHandlerDependencies.createResponses = createResponses
  responsesHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
  responsesHandlerDependencies.resolveMappedModel = (model) => model
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createResponses.mockReset()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = originalState.copilotToken
  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.macMachineId = originalState.macMachineId
  state.verbose = originalState.verbose
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  Object.assign(
    responsesHandlerDependencies,
    defaultResponsesHandlerDependencies,
  )
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("responses handler token usage", () => {
  test("model mapping preserves explicit and omitted native Responses intent", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: { max_prompt_tokens: 128000 },
          },
          id: "gpt-target",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesHandlerDependencies.resolveMappedModel = (model) =>
      model === "gpt-source" ? "gpt-target" : model
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const input = [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]
    const tools = [
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
      },
    ]

    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      const response = await createApp().request("/v1/responses", {
        body: JSON.stringify({
          input,
          instructions: "Keep the caller instructions",
          max_output_tokens: 321,
          metadata: { request: effort },
          model: "gpt-source",
          reasoning: { effort, summary: "detailed" },
          tool_choice: "required",
          tools,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponses.mock.calls.at(-1)?.[0]).toMatchObject({
        input,
        instructions: "Keep the caller instructions",
        max_output_tokens: 321,
        metadata: { request: effort },
        model: "gpt-target",
        reasoning: { effort, summary: "detailed" },
        tool_choice: "required",
        tools,
      })
    }

    await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input,
        model: "gpt-source",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(createResponses.mock.calls.at(-1)?.[0].reasoning).toBeUndefined()
  })

  test("rejects unknown runtime Responses reasoning effort values", async () => {
    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        reasoning: { effort: "future-hyper" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_value",
        message: "Unsupported Responses reasoning effort",
        param: "reasoning.effort",
        type: "invalid_request_error",
      },
    })
    expect(createResponses).not.toHaveBeenCalled()
  })

  test("forwards the Hono request abort signal to the upstream lifecycle", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const controller = new AbortController()
    const request = new Request("http://localhost/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal,
    })

    const response = await createApp().request(request)

    expect(response.status).toBe(200)
    expect(createResponses.mock.calls[0][1]?.signal).toBe(controller.signal)
  })

  test("uses websocket transport by default for dual-endpoint models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("websocket")
    expect(createResponses.mock.calls[0][1]?.allowHttpFallback).toBe(true)
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    responsesApiWebSocketEnabled = false
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("keeps HTTP transport when the selected model only supports /responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("recovers incompatible reasoning history before returning the Responses stream", async () => {
    const fetchMock = mock(() => {
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "",
                message: "input item does not belong to this connection",
              },
            },
            { status: 400 },
          ),
        )
      }

      return Promise.resolve(
        new Response(
          [
            "event: response.completed",
            `data: ${JSON.stringify({
              response: createResponsesResult("gpt-test"),
              sequence_number: 1,
              type: "response.completed",
            })}`,
            "",
            "",
          ].join("\n"),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
    })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch
    responsesHandlerDependencies.createResponses =
      defaultResponsesHandlerDependencies.createResponses
    responsesApiWebSocketEnabled = false

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            encrypted_content: "old-reasoning",
            type: "reasoning",
          },
          {
            content: [{ text: "continue", type: "input_text" }],
            role: "user",
            type: "message",
          },
        ],
        model: "gpt-test",
        stream: true,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    const stream = await response.text()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stream).toContain("response.completed")
    expect(stream).not.toContain('"type":"error"')
  })

  test("does not cache reasoning recovery under a request-derived fallback session", async () => {
    const fetchMock = mock((_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a JSON request body")
      }
      const body = JSON.parse(init.body) as {
        input: Array<Record<string, unknown>>
      }
      const hasRejectedReasoning = body.input.some(
        (item) => item.encrypted_content === "old-reasoning",
      )
      if (hasRejectedReasoning) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "",
                message: "input item does not belong to this connection",
              },
            },
            { status: 400 },
          ),
        )
      }
      return Promise.resolve(
        new Response(
          [
            "event: response.completed",
            `data: ${JSON.stringify({
              response: createResponsesResult("gpt-test"),
              sequence_number: 1,
              type: "response.completed",
            })}`,
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch
    responsesHandlerDependencies.createResponses =
      defaultResponsesHandlerDependencies.createResponses
    responsesApiWebSocketEnabled = false

    const app = createApp()
    for (const traceId of ["trace-1", "trace-2"]) {
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              encrypted_content: "old-reasoning",
              type: "reasoning",
            },
            {
              content: [{ text: "continue", type: "input_text" }],
              role: "user",
              type: "message",
            },
          ],
          model: "gpt-test",
          stream: true,
        }),
        headers: {
          "content-type": "application/json",
          "x-request-id": traceId,
        },
        method: "POST",
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("response.completed")
    }

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test("does not add context management to native Responses API by default", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
  })

  test("preserves client-owned context management without pruning input", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const input = [
      { role: "user", content: "old history" },
      {
        type: "compaction",
        id: "compaction-1",
        encrypted_content: "cipher",
      },
      { role: "user", content: "latest history" },
    ]
    const contextManagement = [
      { type: "compaction", compact_threshold: 345_678 },
    ]

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        model: "gpt-test",
        input,
        context_management: contextManagement,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses.mock.calls[0][0]).toMatchObject({
      context_management: contextManagement,
      input,
    })
  })

  test("preserves the Codex native Responses intent bundle", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const input = [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]
    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        model: "gpt-test",
        input,
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
        prompt_cache_key: "codex-native-session",
        reasoning: {
          effort: "max",
          summary: "concise",
          context: "all_turns",
        },
        store: false,
        text: { verbosity: "low" },
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0]).toMatchObject({
      include: ["reasoning.encrypted_content"],
      input,
      parallel_tool_calls: false,
      prompt_cache_key: "codex-native-session",
      reasoning: {
        effort: "max",
        summary: "concise",
        context: "all_turns",
      },
      store: false,
      text: { verbosity: "low" },
    })
  })

  test("removes unsupported service tiers so Copilot can serve the request", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    for (const serviceTier of [
      "auto",
      "default",
      "priority",
      "flex",
      "future",
    ]) {
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: "hello",
          model: "gpt-test",
          service_tier: serviceTier,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(
        createResponses.mock.calls.at(-1)?.[0].service_tier,
      ).toBeUndefined()
    }
    expect(createResponses).toHaveBeenCalledTimes(5)
  })

  test("rejects background true instead of silently running in foreground", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        background: true,
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(createResponses).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_value",
        message:
          "GitHub Copilot Responses does not support background; the request was not modified.",
        param: "background",
        type: "invalid_request_error",
      },
    })
  })

  test("rejects image_generation instead of deleting the requested tool", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "draw a lighthouse",
        model: "gpt-test",
        tools: [{ type: "image_generation" }],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(createResponses).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_value",
        message:
          "GitHub Copilot Responses does not support image_generation; the request was not modified.",
        param: "tools",
        type: "invalid_request_error",
      },
    })
  })

  test("uses model Responses API compact threshold before max token fallback", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-threshold-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = (
      model,
    ) => (model === "gpt-threshold-test" ? 272_000 * 0.8 : undefined)
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-threshold-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 217600,
      },
    ])
  })

  test("preserves client input ending with a compaction trigger", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const latestInput = {
      content: "Continue after the latest compaction.",
      role: "user",
    }
    const compactionTrigger = {
      type: "compaction_trigger",
    }
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "old content before compaction",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: [
              {
                text: "Completed the review for the latest two commits.",
                type: "output_text",
              },
            ],
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
          latestInput,
          compactionTrigger,
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        content: "old content before compaction",
        role: "user",
      },
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: [
          {
            text: "Completed the review for the latest two commits.",
            type: "output_text",
          },
        ],
        phase: "final_answer",
        role: "assistant",
        type: "message",
      },
      latestInput,
      compactionTrigger,
    ])
  })

  test("does not compact input ending with compaction trigger when context management is disabled", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const input = [
      {
        content: "old content before compaction",
        role: "user",
      },
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: "Continue after the latest compaction.",
        role: "user",
      },
      {
        type: "compaction_trigger",
      },
    ]

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input,
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
    expect(createResponses.mock.calls[0][0].input).toEqual(input)
  })

  test("preserves custom apply_patch tools for Copilot Responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const applyPatchTool = {
      type: "custom",
      name: "apply_patch",
      description: "Edit files with a patch",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        tools: [applyPatchTool],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].tools?.[0]).toEqual(applyPatchTool)
  })

  test("applies configured context management to gpt-5.6 models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 272000,
            },
          },
          id: "gpt-5.6-sol",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
      undefined
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-5.6-sol",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toEqual([
      { type: "compaction", compact_threshold: 217600 },
    ])
  })

  test("does not disable configured context management for future GPT models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 272000,
            },
          },
          id: "gpt-6",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-6",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toEqual([
      { type: "compaction", compact_threshold: 217600 },
    ])
  })

  test("uses Codex subagent headers for Responses request attribution", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "child-thread",
      agent_type: "collab_spawn",
      session_id: "child-thread",
    })
  })

  test("does not use Codex parent thread header as Responses session", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
        "x-session-id": "alternate-session",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "parent-thread",
      agent_type: "collab_spawn",
      session_id: "root-session",
    })
  })

  test("uses session headers when Codex subagent header is missing", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    const expectedRequestId = generateRequestIdFromPayload(
      { messages: payload.input },
      expectedSessionId,
    )
    expect(options?.initiator).toBe("user")
    expect(options?.requestId).toBe(expectedRequestId)
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.subagentMarker).toBeNull()
  })

  test("ignores unknown x-openai-subagent values", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-openai-subagent": "unexpected",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("accepts known Codex subagent header values", async () => {
    for (const agentType of ["compact", "memory_consolidation", "review"]) {
      createResponses.mockReset()
      createResponses.mockImplementation((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

      const app = createApp()
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              content: [{ text: "hello", type: "input_text" }],
              role: "user",
            },
          ],
          model: "gpt-test",
        }),
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-openai-subagent": agentType,
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponses).toHaveBeenCalledTimes(1)
      expect(createResponses.mock.calls[0][1]?.initiator).toBe("agent")
      expect(createResponses.mock.calls[0][1]?.subagentMarker).toEqual({
        agent_id: "child-thread",
        agent_type: agentType,
        session_id: "child-thread",
      })
    }
  })

  test("ignores stale model image byte limits when the request is within the configured budget", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const olderImageUrl = `data:image/png;base64,${"A".repeat(16)}`
    const latestImageUrl = `data:image/png;base64,${"B".repeat(4)}`

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "old", type: "input_text" },
              {
                image_url: olderImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
          {
            content: [
              { text: "latest", type: "input_text" },
              {
                detail: "low",
                image_url: latestImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(createResponses.mock.calls[0][0].input)).toContain(
      olderImageUrl,
    )
    expect(JSON.stringify(createResponses.mock.calls[0][0].input)).toContain(
      latestImageUrl,
    )
    expect(
      JSON.stringify(createResponses.mock.calls[0][0].input),
    ).not.toContain("Local proxy omitted")
  })

  test("forwards a latest image above the stale model byte limit when the request is within budget", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                image_url: `data:image/png;base64,${"A".repeat(16)}`,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(createResponses.mock.calls[0][0].input)).toContain(
      `data:image/png;base64,${"A".repeat(16)}`,
    )
  })

  test("preserves multiple input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 1,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const firstImageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const secondImageUrl = `data:image/png;base64,${"B".repeat(8)}`

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                detail: "low",
                image_url: firstImageUrl,
                type: "input_image",
              },
              {
                detail: "low",
                image_url: secondImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: firstImageUrl, type: "input_image" },
          { detail: "low", image_url: secondImageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ])
  })

  test("does not retry upstream payload-too-large when no safe reduction remains", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses
      .mockImplementationOnce(() =>
        Promise.reject(
          new HTTPError(
            "Failed to create responses",
            new Response("payload too large", { status: 413 }),
          ),
        ),
      )
      .mockImplementationOnce((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

    const olderImageUrl = `data:image/png;base64,${"A".repeat(32)}`
    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "old", type: "input_text" },
              {
                detail: "high",
                image_url: olderImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
          {
            content: [
              { text: "latest", type: "input_text" },
              {
                detail: "low",
                image_url: `data:image/png;base64,${"B".repeat(4)}`,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
    expect(JSON.stringify(createResponses.mock.calls[0][0])).toContain(
      olderImageUrl,
    )
  })

  test("records usage from failed streaming responses and falls back to interaction id", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              copilot_usage: {
                total_nano_aiu: 1234,
              },
              response: {
                created_at: 0,
                error: {
                  message: "request failed",
                },
                id: "resp_123",
                incomplete_details: null,
                instructions: null,
                metadata: null,
                model: "gpt-test",
                object: "response",
                output: [],
                output_text: "",
                parallel_tool_calls: false,
                status: "failed",
                temperature: null,
                tool_choice: "auto",
                tools: [],
                top_p: null,
                usage: {
                  input_tokens: 5,
                  input_tokens_details: {
                    cached_tokens: 1,
                  },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
              sequence_number: 1,
              type: "response.failed",
            }),
            event: "response.failed",
            id: "event_1",
          },
        ]),
      ),
    )

    const app = createApp()
    const payload = {
      input: "hello",
      model: "gpt-test",
      stream: true,
    }

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    await response.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    expect(eventsResponse.status).toBe(200)

    const page = (await eventsResponse.json()) as {
      items: Array<{
        cache_read_input_tokens: number
        input_tokens: number
        output_tokens: number
        session_id: string
        total_nano_aiu: number | null
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)

    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    const expectedInteractionId = getUUID(expectedRequestId)

    expect(page.items[0]?.session_id).toBe(expectedInteractionId)
    expect(page.items[0]?.cache_read_input_tokens).toBe(1)
    expect(page.items[0]?.input_tokens).toBe(4)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_nano_aiu).toBe(1234)
    expect(page.items[0]?.total_tokens).toBe(7)
  })

  test("emits one native Responses error when upstream ends without a typed terminal", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(streamChunks([]) as never),
    )

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain("Responses stream ended without a terminal event")
  })

  test("stops reading after every native Responses typed terminal", async () => {
    const responseResult = createResponsesResult("gpt-test")
    const terminalEvents = [
      {
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: { ...responseResult, status: "completed" },
        }),
      },
      {
        event: "response.failed",
        data: JSON.stringify({
          type: "response.failed",
          sequence_number: 1,
          response: { ...responseResult, status: "failed" },
        }),
      },
      {
        event: "response.incomplete",
        data: JSON.stringify({
          type: "response.incomplete",
          sequence_number: 1,
          response: { ...responseResult, status: "incomplete" },
        }),
      },
      {
        event: "error",
        data: JSON.stringify({
          type: "error",
          sequence_number: 1,
          code: null,
          message: "typed upstream error",
          param: null,
        }),
      },
    ]

    for (const terminalEvent of terminalEvents) {
      let readsPastTerminal = 0
      async function* terminalThenTail() {
        await Promise.resolve()
        yield terminalEvent
        readsPastTerminal += 1
        throw new Error("read past typed terminal")
      }
      createResponses.mockReset()
      createResponses.mockImplementation(() =>
        Promise.resolve(terminalThenTail() as never),
      )

      const response = await createApp().request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "hello",
          model: "gpt-test",
          stream: true,
        }),
      })
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(body).toContain(`event: ${terminalEvent.event}`)
      expect(body).not.toContain("read past typed terminal")
      expect(readsPastTerminal).toBe(0)
    }
  })

  test("emits native Responses error event when upstream stream throws", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamChunksThenThrow([], "native responses stream reset") as never,
      ),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()

    expect(body.match(/event: error/gu)).toHaveLength(1)
    expect(body).toContain('"type":"error"')
    expect(body).toContain(
      "Upstream stream ended unexpectedly: native responses stream reset",
    )
  })
})
