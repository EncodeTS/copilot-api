import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
  Tool,
} from "../src/services/copilot/create-responses"

import {
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "../src/lib/api-config"
import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"
import {
  buildResponsesWebSocketPoolKey,
  buildResponsesWebSocketPayload,
  buildResponsesWebSocketUrl,
  createResponses,
  ensureEncryptedReasoningIncluded,
  prepareResponsesWebSocketRequest,
} from "../src/services/copilot/create-responses"

const originalFetch = globalThis.fetch
const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
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

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(JSON.stringify(createResponsesResult("gpt-test")), {
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    }),
  ),
)

const parseFetchBody = (init: RequestInit | undefined): ResponsesPayload => {
  expect(typeof init?.body).toBe("string")
  return JSON.parse(init?.body as string) as ResponsesPayload
}

const getToolParameters = (tool: Tool | undefined): unknown =>
  tool && "parameters" in tool ? tool.parameters : undefined

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }

  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.macMachineId = originalState.macMachineId
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("createResponses", () => {
  test("aborts an in-flight HTTP request when the caller disconnects", async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error ?
                  init.signal.reason
                : new Error("request aborted"),
              ),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()

    const request = createResponses(
      {
        input: "hello",
        model: "gpt-test",
      },
      {
        initiator: "user",
        requestId: "request-1",
        signal: controller.signal,
        vision: false,
      },
    )
    controller.abort(new Error("client disconnected"))

    const outcome = await Promise.race([
      request.then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("request remained pending"), 20),
      ),
    ])
    expect(outcome).toBe("client disconnected")
  })

  test("applies the configured HTTP headers deadline", async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error ?
                  init.signal.reason
                : new Error("request aborted"),
              ),
            { once: true },
          )
        }),
    )

    const request = createResponses(
      {
        input: "hello",
        model: "gpt-test",
      },
      {
        initiator: "user",
        requestId: "request-1",
        timeouts: { httpHeadersMs: 5 },
        vision: false,
      },
    )

    expect(
      await request.then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : "unknown error",
      ),
    ).toBe("Upstream HTTP headers timed out after 5ms")
  })

  test("keeps HTTP responses requests using x-initiator header", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const requestInit = init as RequestInit & {
      headers: Record<string, string>
    }
    expect(requestInit.headers["x-initiator"]).toBe("user")
    expect(requestInit.headers["X-Request-Id"]).toBeUndefined()

    expect(typeof requestInit.body).toBe("string")
    const body = JSON.parse(requestInit.body as string) as Record<
      string,
      unknown
    >
    expect(body.initiator).toBeUndefined()
    expect(body.type).toBeUndefined()
    expect(body.include).toEqual(["reasoning.encrypted_content"])
  })

  test("normalizes a None function schema before forwarding Responses", async () => {
    const payload: ResponsesPayload = {
      input: "update the automation",
      model: "gpt-test",
      tools: [
        {
          name: "automation_update",
          parameters: { type: "None" },
          strict: false,
          type: "function",
        },
      ],
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    const tool = body.tools?.[0]
    expect(tool).toMatchObject({
      name: "automation_update",
      parameters: {
        properties: {},
        type: "object",
      },
      type: "function",
    })
  })

  test("normalizes case variants of the None schema sentinel", async () => {
    const payload: ResponsesPayload = {
      input: "update the automation",
      model: "gpt-test",
      tools: ["None", "NONE", "none"].map((type, index) => ({
        name: `automation_update_${index}`,
        parameters: { type },
        strict: false,
        type: "function" as const,
      })),
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    expect(body.tools?.map((tool) => getToolParameters(tool))).toEqual([
      { properties: {}, type: "object" },
      { properties: {}, type: "object" },
      { properties: {}, type: "object" },
    ])
  })

  test("normalizes a None schema inside a Responses namespace", async () => {
    const payload: ResponsesPayload = {
      input: "update the automation",
      model: "gpt-test",
      tools: [
        {
          name: "automations",
          tools: [
            {
              name: "automation_update",
              parameters: { type: "None" },
              strict: false,
              type: "function",
            },
          ],
          type: "namespace",
        },
      ],
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    const namespace = body.tools?.[0]
    expect(namespace).toMatchObject({
      tools: [
        {
          name: "automation_update",
          parameters: {
            properties: {},
            type: "object",
          },
          type: "function",
        },
      ],
      type: "namespace",
    })
  })

  test("normalizes a None schema returned by Responses tool search", async () => {
    const payload: ResponsesPayload = {
      input: [
        {
          call_id: "search-1",
          tools: [
            {
              name: "automation_update",
              parameters: { type: "None" },
              strict: false,
              type: "function",
            },
          ],
          type: "tool_search_output",
        },
      ],
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    const toolSearchOutput = Array.isArray(body.input) ? body.input[0] : null
    expect(toolSearchOutput).toMatchObject({
      tools: [
        {
          name: "automation_update",
          parameters: {
            properties: {},
            type: "object",
          },
          type: "function",
        },
      ],
      type: "tool_search_output",
    })
  })

  test("normalizes nested schemas in Responses additional tools", async () => {
    const payload: ResponsesPayload = {
      input: [
        {
          role: "developer",
          tools: [
            {
              name: "automations",
              tools: [
                {
                  name: "automation_update",
                  parameters: { type: "None" },
                  strict: false,
                  type: "function",
                },
              ],
              type: "namespace",
            },
          ],
          type: "additional_tools",
        },
      ],
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    const additionalTools = Array.isArray(body.input) ? body.input[0] : null
    expect(additionalTools).toMatchObject({
      tools: [
        {
          tools: [
            {
              name: "automation_update",
              parameters: { properties: {}, type: "object" },
              type: "function",
            },
          ],
          type: "namespace",
        },
      ],
      type: "additional_tools",
    })
  })

  test("preserves null and valid Responses function schemas", async () => {
    const validSchema = {
      properties: {
        automation_id: { type: "string" },
      },
      required: ["automation_id"],
      type: "object",
    }
    const payload: ResponsesPayload = {
      input: "update the automation",
      model: "gpt-test",
      tools: [
        {
          name: "no_arguments",
          parameters: null,
          strict: false,
          type: "function",
        },
        {
          name: "automation_update",
          parameters: validSchema,
          strict: false,
          type: "function",
        },
      ],
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = parseFetchBody(init)
    expect(getToolParameters(body.tools?.[0])).toBeNull()
    expect(getToolParameters(body.tools?.[1])).toEqual(validSchema)
  })

  test("rejects an excessively deep Responses tool graph deterministically", () => {
    let nestedTool: Record<string, unknown> = {
      name: "automation_update",
      parameters: { type: "None" },
      strict: false,
      type: "function",
    }
    for (let index = 0; index < 10_001; index += 1) {
      nestedTool = {
        name: `namespace-${index}`,
        tools: [nestedTool],
        type: "namespace",
      }
    }
    const payload: ResponsesPayload = {
      input: "update the automation",
      model: "gpt-test",
      tools: [nestedTool],
    }

    expect(
      createResponses(payload, {
        initiator: "user",
        requestId: "request-1",
        vision: false,
      }),
    ).rejects.toThrow("Responses tool graph exceeds 10000 entries")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("preserves existing responses include values when adding encrypted reasoning", () => {
    const payload: ResponsesPayload = {
      include: ["web_search_call.results"],
      input: "hello",
      model: "gpt-test",
    }

    ensureEncryptedReasoningIncluded(payload)
    ensureEncryptedReasoningIncluded(payload)

    expect(payload.include).toEqual([
      "web_search_call.results",
      "reasoning.encrypted_content",
    ])
  })

  test("sets subagent interaction headers for HTTP responses requests", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "agent",
      requestId: "request-1",
      sessionId: "interaction-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "collab_spawn",
        session_id: "sub-session",
      },
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const requestInit = init as RequestInit & {
      headers: Record<string, string>
    }
    expect(requestInit.headers["x-initiator"]).toBe("agent")
    expect(requestInit.headers["x-interaction-id"]).toBe("interaction-1")
    expect(requestInit.headers["x-interaction-type"]).toBe(
      "conversation-subagent",
    )
  })

  test("uses HTTP when websocket transport is requested without stream=true", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
      stream: false,
    }

    const response = await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response).toEqual(createResponsesResult("gpt-test"))
  })

  test("builds the first websocket frame as response.create", () => {
    const payload = {
      background: true,
      input: "hello",
      model: "gpt-test",
      service_tier: "auto",
      stream: true,
    } as ResponsesPayload

    const websocketPayload = buildResponsesWebSocketPayload(payload, "agent")

    expect(websocketPayload).toEqual({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect("stream" in websocketPayload).toBe(false)
    expect("background" in websocketPayload).toBe(false)
    expect("service_tier" in websocketPayload).toBe(false)
  })

  test("builds websocket URLs from the Copilot base URL", () => {
    expect(buildResponsesWebSocketUrl("https://api.githubcopilot.com")).toBe(
      "wss://api.githubcopilot.com/responses",
    )
    expect(buildResponsesWebSocketUrl("http://localhost:3000/")).toBe(
      "ws://localhost:3000/responses",
    )
  })

  test("builds capture-style websocket headers without x-initiator", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", true),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", false, preparedHeaders)

    const headers = copilotWebSocketHeaders(preparedHeaders)

    expect(headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Device-Id": "device-1",
      "Editor-Plugin-Version": "copilot-chat/0.52.0",
      "Editor-Version": "vscode/1.120.0",
      "OpenAI-Intent": "conversation-agent",
      "VScode-SessionId": "session-1",
      "VScode-MachineId": "machine-1",
      "X-Agent-Task-Id": "request-1",
      "X-GitHub-Api-Version": "2026-06-01",
      "X-Interaction-Id": "interaction-1",
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": "request-1",
      "user-agent": "node",
    })
    const headerNames = Object.keys(headers)
    const agentTaskIdIndex = headerNames.indexOf("X-Agent-Task-Id")
    expect(
      headerNames.slice(agentTaskIdIndex + 1, agentTaskIdIndex + 3),
    ).toEqual(["VScode-SessionId", "VScode-MachineId"])
    expect(headerNames[headerNames.length - 1]).toBe("user-agent")
    expect(headers.accept).toBeUndefined()
    expect(headers["accept-encoding"]).toBeUndefined()
    expect(headers["accept-language"]).toBeUndefined()
    expect(headers["cache-control"]).toBeUndefined()
    expect(headers.pragma).toBeUndefined()
    expect(headers["sec-fetch-mode"]).toBeUndefined()
    expect(headers["x-initiator"]).toBeUndefined()
    expect(headers["sec-websocket-key"]).toBeUndefined()
  })

  test("websocket request uses prepared compact and interaction headers", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
        subagentMarker: {
          agent_id: "agent-1",
          agent_type: "Explore",
          session_id: "sub-session",
        },
      },
    )

    expect(request.payload).toMatchObject({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect(request.headers["OpenAI-Intent"]).toBe("conversation-agent")
    expect(request.headers["X-Interaction-Id"]).toBe("interaction-1")
    expect(request.headers["X-Interaction-Type"]).toBe(
      "conversation-compaction",
    )
    expect(request.headers["x-initiator"]).toBeUndefined()
  })

  test("websocket request keeps opencode headers and moves x-initiator into body", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
      },
    )

    expect(request.payload.initiator).toBe("agent")
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Openai-Intent": "conversation-edits",
    })
    expect(request.headers["User-Agent"]).toStartWith("opencode/")
    expect(request.headers["x-initiator"]).toBeUndefined()
    expect(request.headers["X-Request-Id"]).toBeUndefined()
    expect(request.headers["x-interaction-id"]).toBeUndefined()
  })

  test("websocket pool key separates model request and subagent context", () => {
    const basePayload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }
    const mainKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
    })
    const subagentKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "Explore",
        session_id: "sub-session",
      },
    })
    const otherModelKey = buildResponsesWebSocketPoolKey(
      {
        ...basePayload,
        model: "gpt-other",
      },
      {
        requestId: "request-1",
      },
    )

    expect(new Set([mainKey, subagentKey, otherModelKey]).size).toBe(3)
    expect(mainKey).toContain("gpt-test")
    expect(mainKey).toContain("request-1")
  })

  test("websocket pool key fingerprints stable handshake headers only", () => {
    const payload: ResponsesPayload = { input: "hello", model: "gpt-test" }
    const baseOptions = {
      reasoningRecoverySessionId: "stable-session",
      requestId: "request-1",
      websocketHeaders: {
        Authorization: "Bearer token-1",
        "User-Agent": "opencode/1",
        "X-Request-Id": "request-1",
        "X-Session-Affinity": "affinity-1",
      },
    }
    const first = buildResponsesWebSocketPoolKey(payload, baseOptions)
    const volatileOnly = buildResponsesWebSocketPoolKey(payload, {
      ...baseOptions,
      requestId: "request-2",
      websocketHeaders: {
        ...baseOptions.websocketHeaders,
        Authorization: "Bearer token-2",
        "X-Request-Id": "request-2",
      },
    })
    const otherAffinity = buildResponsesWebSocketPoolKey(payload, {
      ...baseOptions,
      websocketHeaders: {
        ...baseOptions.websocketHeaders,
        "X-Session-Affinity": "affinity-2",
      },
    })
    const otherUserAgent = buildResponsesWebSocketPoolKey(payload, {
      ...baseOptions,
      websocketHeaders: {
        ...baseOptions.websocketHeaders,
        "User-Agent": "opencode/2",
      },
    })

    expect(volatileOnly).toBe(first)
    expect(otherAffinity).not.toBe(first)
    expect(otherUserAgent).not.toBe(first)
  })

  test("preserves Copilot prompt limit failures after diagnostic logging", () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "model_max_prompt_tokens_exceeded",
              message:
                "prompt token count of 967636 exceeds the limit of 922000",
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-copilot-service-request-id": "service-request-1",
              "x-github-request-id": "github-request-1",
              "x-request-id": "upstream-request-1",
            },
            status: 400,
          },
        ),
      ),
    )

    expect(
      createResponses(
        { input: "hello", model: "gpt-5.6-luna", stream: false },
        {
          initiator: "user",
          requestId: "request-1",
          vision: false,
        },
      ),
    ).rejects.toThrow(
      "Failed to create responses: prompt token count of 967636 exceeds the limit of 922000",
    )
  })
})
