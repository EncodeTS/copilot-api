import { expect, mock, test } from "bun:test"

import {
  createResponsesTransportErrorDiagnostic,
  createResponsesUpstreamErrorDiagnostic,
  parseResponsesPromptLimitFailure,
  summarizeResponsesPayload,
} from "../src/lib/responses-diagnostics"

test("summarizes Responses payload shape without retaining private content", () => {
  const summary = summarizeResponsesPayload({
    context_management: [{ compact_threshold: 890_000, type: "compaction" }],
    input: [
      {
        content: "private user prompt",
        role: "user",
        type: "message",
      },
      {
        output: "private tool output",
        type: "function_call_output",
      },
      {
        encrypted_content: "opaque reasoning content",
        summary: [],
        type: "reasoning",
      },
      {
        encrypted_content: "opaque compaction content",
        id: "compaction-private-id",
        type: "compaction",
      },
      { type: "compaction_trigger" },
      {
        content: [
          {
            image_url: "https://private.example/image.png",
            type: "input_image",
          },
        ],
        role: "developer",
        type: "message",
      },
    ],
    instructions: "private system prompt",
    model: "gpt-5.6-luna",
    stream: true,
    tools: [
      {
        description: "private tool description",
        name: "private_tool_name",
        type: "function",
      },
    ],
  })

  expect(summary).toMatchObject({
    compactThreshold: 890_000,
    contextManagementItems: 1,
    inputItems: 6,
    inputTypeCounts: {
      compaction: 1,
      compaction_trigger: 1,
      function_call_output: 1,
      message: 2,
      reasoning: 1,
    },
    instructionsBytes: 21,
    model: "gpt-5.6-luna",
    roleCounts: { developer: 1, user: 1 },
    stream: true,
    toolCount: 1,
    visionItems: 1,
  })
  expect(summary.payloadBytes).toBeGreaterThan(0)

  const serialized = JSON.stringify(summary)
  expect(serialized).not.toContain("private")
  expect(serialized).not.toContain("opaque")
})

test("skips full payload serialization when byte diagnostics are disabled", () => {
  const toJSON = mock(() => {
    throw new Error("payload should not be serialized")
  })
  const payload = {
    input: [],
    model: "gpt-5.6-luna",
    toJSON,
  }

  const summary = summarizeResponsesPayload(payload, {
    includePayloadBytes: false,
  })

  expect(toJSON).not.toHaveBeenCalled()
  expect(summary.payloadBytes).toBeUndefined()
})

test("builds self-contained transport error diagnostics", () => {
  const diagnostic = createResponsesTransportErrorDiagnostic({
    error: Object.assign(new Error("private echoed request text"), {
      code: "ECONNRESET",
    }),
    payload: {
      input: [{ content: "private prompt", role: "user", type: "message" }],
      model: "gpt-5.6-sol",
      stream: true,
    },
    requestHeaders: {
      "x-interaction-id": "session-1",
      "x-request-id": "request-1",
    },
    transport: "websocket",
  })

  expect(diagnostic).toMatchObject({
    errorCode: "ECONNRESET",
    errorName: "Error",
    inputItems: 1,
    model: "gpt-5.6-sol",
    requestId: "request-1",
    sessionId: "session-1",
    stream: true,
    transport: "websocket",
  })
  expect(JSON.stringify(diagnostic)).not.toContain("private")
})

test("builds self-contained HTTP prompt limit diagnostics", () => {
  const diagnostic = createResponsesUpstreamErrorDiagnostic({
    failure: {
      code: "model_max_prompt_tokens_exceeded",
      message: "prompt token count of 967636 exceeds the limit of 922000",
    },
    payload: {
      context_management: [{ compact_threshold: 890_000, type: "compaction" }],
      input: [{ content: "private prompt", role: "user", type: "message" }],
      model: "gpt-5.6-luna",
      stream: true,
    },
    requestHeaders: {
      "X-Interaction-Id": "session-safe-id",
      "X-Request-Id": "request-safe-id",
    },
    responseHeaders: new Headers({
      "x-copilot-service-request-id": "service-request-1",
      "x-github-backend": "Kubernetes",
      "x-github-request-id": "github-request-1",
      "x-request-id": "upstream-request-1",
    }),
    status: 400,
    transport: "http",
  })

  expect(diagnostic).toMatchObject({
    compactThreshold: 890_000,
    errorCode: "model_max_prompt_tokens_exceeded",
    githubBackend: "Kubernetes",
    githubRequestId: "github-request-1",
    model: "gpt-5.6-luna",
    overLimitTokens: 45_636,
    promptLimitTokens: 922_000,
    promptTokens: 967_636,
    requestId: "request-safe-id",
    serviceRequestId: "service-request-1",
    sessionId: "session-safe-id",
    status: 400,
    transport: "http",
    upstreamRequestId: "upstream-request-1",
  })
  expect(JSON.stringify(diagnostic)).not.toContain("private prompt")
})

test("drops hostile external correlation metadata", () => {
  const diagnostic = createResponsesUpstreamErrorDiagnostic({
    failure: { code: "bad_request", message: "rejected" },
    payload: { input: [], model: "gpt-test" },
    requestHeaders: {
      "x-interaction-id": "private prompt text",
      "x-request-id": "Bearer secret-token",
    },
    responseHeaders: new Headers({
      "x-github-request-id": "private response header",
    }),
    status: 400,
    transport: "http",
  })

  expect(diagnostic.requestId).toBeUndefined()
  expect(diagnostic.sessionId).toBeUndefined()
  expect(diagnostic.githubRequestId).toBeUndefined()
  expect(JSON.stringify(diagnostic)).not.toContain("private")
  expect(JSON.stringify(diagnostic)).not.toContain("secret-token")
})

test("keeps WebSocket error diagnostics correlated without response headers", () => {
  expect(
    createResponsesUpstreamErrorDiagnostic({
      failure: {
        code: "bad_request",
        message: "prompt token count of 329922 exceeds the limit of 272000",
      },
      payload: { input: [], model: "gpt-test", stream: true },
      requestHeaders: {
        "x-interaction-id": "session-1",
        "x-request-id": "request-1",
      },
      transport: "websocket",
    }),
  ).toMatchObject({
    errorCode: "bad_request",
    overLimitTokens: 57_922,
    promptLimitTokens: 272_000,
    promptTokens: 329_922,
    requestId: "request-1",
    sessionId: "session-1",
    transport: "websocket",
  })
})

test("extracts prompt limit diagnostics from Copilot failures", () => {
  expect(
    parseResponsesPromptLimitFailure({
      code: "model_max_prompt_tokens_exceeded",
      message: "prompt token count of 967636 exceeds the limit of 922000",
    }),
  ).toEqual({
    errorCode: "model_max_prompt_tokens_exceeded",
    overLimitTokens: 45_636,
    promptLimitTokens: 922_000,
    promptTokens: 967_636,
  })
})

test("keeps non-limit failures content-free", () => {
  expect(
    parseResponsesPromptLimitFailure({
      code: "upstream_rejected",
      message: "private upstream failure text",
    }),
  ).toEqual({ errorCode: "upstream_rejected" })
})
