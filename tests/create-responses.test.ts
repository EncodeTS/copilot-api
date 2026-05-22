import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import {
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "../src/lib/api-config"
import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"

const {
  buildResponsesWebSocketPoolKey,
  buildResponsesWebSocketPayload,
  buildResponsesWebSocketUrl,
  prepareResponsesWebSocketRequest,
} = await import("../src/services/copilot/create-responses")

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
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
})

describe("createResponses", () => {
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
      "Editor-Plugin-Version": "copilot-chat/0.48.0",
      "Editor-Version": "vscode/1.120.0",
      "OpenAI-Intent": "conversation-agent",
      "VScode-SessionId": "session-1",
      "VScode-MachineId": "machine-1",
      "X-Agent-Task-Id": "request-1",
      "X-GitHub-Api-Version": "2026-01-09",
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
    expect(headerNames.at(-1)).toBe("user-agent")
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
    expect(request.headers["OpenAI-Intent"]).toBe("conversation-other")
    expect(request.headers["X-Interaction-Id"]).toBe("interaction-1")
    expect(request.headers["X-Interaction-Type"]).toBe("conversation-other")
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
})
