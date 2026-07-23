import { expect, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import {
  createOptimizedCopilotResponses,
  getResponsesSendHardLimitForTransport,
  prepareCopilotResponsesPayloadForSend,
} from "../src/routes/responses/optimized-create"
import { HTTPError, LocalPayloadTooLargeError } from "~/lib/error"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import { getConfig } from "~/lib/config"
import { buildResponsesWebSocketPayload } from "../src/services/copilot/create-responses"
import { serializeImmutableResponsesPayload } from "../src/services/copilot/responses-wire-artifact"
import {
  createReasoningRecoveryScope,
  responsesReasoningRecoveryRegistry,
} from "../src/services/copilot/responses-reasoning-recovery-registry"
import {
  degradeResponsesWebSocketTransport,
  resetResponsesWebSocketTransportHealth,
} from "../src/services/copilot/responses-transport-health"
import {
  calculateResponsesPayloadBytes,
  optimizeInputImagesForPayloadBudget,
} from "../src/routes/responses/utils"

const createResult = (model: string): ResponsesResult => ({
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

test("optimized Responses requests budget encrypted reasoning before dispatch", async () => {
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-test",
  }
  let dispatchedPayload: ResponsesPayload | undefined

  await createOptimizedCopilotResponses(payload, {
    createResponses: (outboundPayload) => {
      dispatchedPayload = structuredClone(outboundPayload)
      return Promise.resolve(createResult(outboundPayload.model))
    },
    requestOptions: {
      initiator: "user",
      requestId: "request-1",
      transport: "http",
      vision: false,
    },
  })

  expect(dispatchedPayload?.include).toContain("reasoning.encrypted_content")
})

test("dispatches the exact admitted HTTP artifact after all wire mutations", async () => {
  const payload: ResponsesPayload = {
    input: "update the automation",
    model: "gpt-test",
    service_tier: "priority",
    tools: [
      {
        name: "automation_update",
        parameters: { type: "None" },
        strict: false,
        type: "function",
      },
    ],
  }
  let admitted:
    | {
        httpBody: string
        payload: ResponsesPayload
        summary: { httpBodyBytes: number }
      }
    | undefined

  await createOptimizedCopilotResponses(payload, {
    createResponses: (_outboundPayload, requestOptions) => {
      admitted = (
        requestOptions as typeof requestOptions & {
          wireArtifact?: typeof admitted
        }
      ).wireArtifact
      return Promise.resolve(createResult("gpt-test"))
    },
    requestOptions: {
      initiator: "user",
      requestId: "request-wire-http",
      transport: "http",
      vision: false,
    },
  })

  expect(admitted).toBeDefined()
  expect(admitted?.summary.httpBodyBytes).toBe(
    Buffer.byteLength(admitted?.httpBody ?? "", "utf8"),
  )
  expect(JSON.parse(admitted?.httpBody ?? "{}")).toMatchObject({
    include: ["reasoning.encrypted_content"],
    tools: [
      {
        parameters: { properties: {}, type: "object" },
        type: "function",
      },
    ],
  })
  const admittedBody = JSON.parse(admitted?.httpBody ?? "{}") as Record<
    string,
    unknown
  >
  expect(admittedBody.service_tier).toBeUndefined()
  expect(Object.isFrozen(admitted?.payload)).toBe(true)

  payload.instructions = "late mutation"
  expect(admitted?.httpBody).not.toContain("late mutation")
})

test("applies known reasoning recovery before admission", async () => {
  const rejectedReasoning = {
    encrypted_content: "synthetic-rejected-reasoning",
    type: "reasoning" as const,
  }
  const scope = createReasoningRecoveryScope({
    model: "gpt-test",
    sessionId: "session-wire-prefilter",
  })
  responsesReasoningRecoveryRegistry.rememberRejected(scope, [
    rejectedReasoning,
  ])
  let admittedBody = ""

  try {
    await createOptimizedCopilotResponses(
      {
        input: [
          rejectedReasoning,
          {
            content: [{ text: "continue", type: "input_text" }],
            role: "user",
            type: "message",
          },
        ],
        model: "gpt-test",
      },
      {
        createResponses: (_outboundPayload, requestOptions) => {
          admittedBody =
            (
              requestOptions as typeof requestOptions & {
                wireArtifact?: { httpBody: string }
              }
            ).wireArtifact?.httpBody ?? ""
          return Promise.resolve(createResult("gpt-test"))
        },
        requestOptions: {
          initiator: "user",
          reasoningRecoverySessionId: "session-wire-prefilter",
          requestId: "request-wire-prefilter",
          transport: "http",
          vision: false,
        },
      },
    )
  } finally {
    responsesReasoningRecoveryRegistry.clear()
  }

  expect(admittedBody).not.toContain("synthetic-rejected-reasoning")
  expect(admittedBody).toContain("continue")
})

test("separates an already prepared payload before admission", async () => {
  const payload: ResponsesPayload = {
    include: ["reasoning.encrypted_content"],
    input: "hello",
    model: "gpt-test",
  }
  let dispatchedPayload: ResponsesPayload | undefined

  await createOptimizedCopilotResponses(payload, {
    createResponses: (outboundPayload) => {
      dispatchedPayload = outboundPayload
      return Promise.resolve(createResult(outboundPayload.model))
    },
    requestOptions: {
      initiator: "user",
      requestId: "request-no-op",
      transport: "http",
      vision: false,
    },
  })

  expect(dispatchedPayload).not.toBe(payload)
  expect(dispatchedPayload).toEqual(payload)
  expect(Object.isFrozen(dispatchedPayload)).toBe(true)
})

test("selects HTTP before dispatch when websocket cannot be the actual transport", async () => {
  const selectedTransports: Array<string | undefined> = []
  const run = async (payload: ResponsesPayload, compactType?: CompactType) => {
    await createOptimizedCopilotResponses(payload, {
      createResponses: (_outboundPayload, requestOptions) => {
        selectedTransports.push(requestOptions.transport)
        return Promise.resolve(createResult("gpt-test"))
      },
      requestOptions: {
        compactType,
        initiator: "user",
        requestId: `request-transport-${selectedTransports.length}`,
        transport: "websocket",
        vision: false,
      },
    })
  }

  await run({ input: "non-stream", model: "gpt-test", stream: false })
  await run(
    { input: "compact", model: "gpt-test", stream: true },
    COMPACT_REQUEST,
  )

  expect(selectedTransports).toEqual(["http", "http"])
})

test("selects HTTP before websocket admission while transport health is degraded", async () => {
  const serializationStages: Array<string> = []
  let dispatchedTransport: string | undefined
  let artifactTransport: string | undefined
  degradeResponsesWebSocketTransport("sent_unknown_disconnect")

  try {
    await createOptimizedCopilotResponses(
      { input: "hello", model: "gpt-test", stream: true },
      {
        createResponses: (_payload, requestOptions) => {
          dispatchedTransport = requestOptions.transport
          artifactTransport = requestOptions.wireArtifact?.transport
          return Promise.resolve(createResult("gpt-test"))
        },
        requestOptions: {
          allowHttpFallback: true,
          initiator: "user",
          requestId: "request-transport-cooldown",
          transport: "websocket",
          vision: false,
          wireSerializationObserver: {
            onSerialization: (stage) => serializationStages.push(stage),
          },
        },
        selectedModel: {
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      },
    )
  } finally {
    resetResponsesWebSocketTransportHealth()
  }

  expect(dispatchedTransport).toBe("http")
  expect(artifactTransport).toBe("http")
  expect(serializationStages).toEqual(["budget_initial"])
})

test("websocket hard limit reserves the serialized envelope overhead", () => {
  const payload: ResponsesPayload = {
    include: ["reasoning.encrypted_content"],
    input: "hello",
    model: "gpt-test",
    stream: true,
  }
  const configuredLimit = 1000
  const effectiveLimit = getResponsesSendHardLimitForTransport(
    payload,
    configuredLimit,
    {
      initiator: "user",
      transport: "websocket",
    },
  )
  const payloadBytes = calculateResponsesPayloadBytes(payload)
  const websocketBytes = calculateResponsesPayloadBytes(
    buildResponsesWebSocketPayload(payload, "user"),
  )

  expect(configuredLimit - effectiveLimit).toBe(websocketBytes - payloadBytes)
  expect(
    getResponsesSendHardLimitForTransport(payload, configuredLimit, {
      initiator: "user",
      transport: "http",
    }),
  ).toBe(configuredLimit)
})

test("websocket hard limit uses a signed frame delta", () => {
  const payload: ResponsesPayload = {
    background: "removed".repeat(32),
    include: ["reasoning.encrypted_content"],
    input: "hello",
    model: "gpt-test",
    stream: true,
  }
  const payloadBytes = calculateResponsesPayloadBytes(payload)
  const websocketBytes = calculateResponsesPayloadBytes(
    buildResponsesWebSocketPayload(payload, "user"),
  )
  expect(websocketBytes).toBeLessThan(payloadBytes)

  expect(
    getResponsesSendHardLimitForTransport(payload, websocketBytes, {
      initiator: "user",
      transport: "websocket",
    }),
  ).toBe(payloadBytes)
})

test("websocket admission also preserves the HTTP fallback hard cap", async () => {
  const config = getConfig()
  const original = {
    responsesImageRetryRequiresHttp: config.responsesImageRetryRequiresHttp,
    responsesPayloadBudgetBytes: config.responsesPayloadBudgetBytes,
    responsesPayloadRetryBudgetBytes: config.responsesPayloadRetryBudgetBytes,
    responsesPayloadSendHardLimitBytes:
      config.responsesPayloadSendHardLimitBytes,
  }
  Object.assign(config, {
    responsesImageRetryRequiresHttp: false,
    responsesPayloadBudgetBytes: 1_100_000,
    responsesPayloadRetryBudgetBytes: 1_050_000,
    responsesPayloadSendHardLimitBytes: 1_200_000,
  })
  const payload: ResponsesPayload = {
    background: "x".repeat(1_210_000),
    input: "hello",
    model: "gpt-test",
    stream: true,
  }
  const options = {
    createResponses: (outboundPayload: ResponsesPayload) =>
      Promise.resolve(createResult(outboundPayload.model)),
    mode: "normal" as const,
    requestOptions: {
      initiator: "user" as const,
      requestId: "request-negative-delta-fallback",
      transport: "websocket" as const,
      vision: false,
    },
    selectedModel: {
      supported_endpoints: ["/responses", "ws:/responses"],
    },
  }

  try {
    const websocketOnly = await prepareCopilotResponsesPayloadForSend(payload, {
      ...options,
      requestOptions: {
        ...options.requestOptions,
        allowHttpFallback: false,
      },
    })
    expect(websocketOnly.transport).toBe("websocket")
    expect(websocketOnly.wireArtifact.summary.httpBodyBytes).toBeGreaterThan(
      1_200_000,
    )
    expect(websocketOnly.wireArtifact.summary.websocketFrameBytes).toBeLessThan(
      1_200_000,
    )

    expect(
      prepareCopilotResponsesPayloadForSend(payload, {
        ...options,
        requestOptions: {
          ...options.requestOptions,
          allowHttpFallback: true,
        },
      }),
    ).rejects.toThrow(LocalPayloadTooLargeError)
  } finally {
    Object.assign(config, original)
  }
})

test("websocket exact cap admits the frame and rejects cap plus one", async () => {
  const exactPayload: ResponsesPayload = {
    include: ["reasoning.encrypted_content"],
    input: "",
    model: "gpt-test",
    stream: true,
  }
  const exactFrameBytes = calculateResponsesPayloadBytes(
    buildResponsesWebSocketPayload(exactPayload, "user"),
  )
  const effectivePayloadLimit = getResponsesSendHardLimitForTransport(
    exactPayload,
    exactFrameBytes,
    { initiator: "user", transport: "websocket" },
  )
  const exact = await optimizeInputImagesForPayloadBudget(exactPayload, {
    budgetBytes: effectivePayloadLimit,
    enabled: false,
    sendHardLimitBytes: effectivePayloadLimit,
  })

  const capPlusOnePayload = { ...exactPayload, input: "x" }
  const capPlusOne = await optimizeInputImagesForPayloadBudget(
    capPlusOnePayload,
    {
      budgetBytes: effectivePayloadLimit,
      enabled: false,
      sendHardLimitBytes: effectivePayloadLimit,
    },
  )

  expect(exact.finalPayloadBytes).toBe(effectivePayloadLimit)
  expect(exact.sendAllowed).toBe(true)
  expect(
    calculateResponsesPayloadBytes(
      buildResponsesWebSocketPayload(capPlusOnePayload, "user"),
    ),
  ).toBe(exactFrameBytes + 1)
  expect(capPlusOne.finalPayloadBytes).toBe(effectivePayloadLimit + 1)
  expect(capPlusOne.sendAllowed).toBe(false)
})

test("reuses an exact pre-serialization during unchanged admission", async () => {
  const payload: ResponsesPayload = {
    include: ["reasoning.encrypted_content"],
    input: "unchanged",
    model: "gpt-test",
  }
  const payloadSerialization = serializeImmutableResponsesPayload(payload)
  expect(Object.isFrozen(payload)).toBe(true)
  expect(Reflect.set(payload, "input", "stale mutation")).toBe(false)

  const result = await optimizeInputImagesForPayloadBudget(payload, {
    budgetBytes: payloadSerialization.payloadBytes,
    enabled: false,
    initialPayloadSerialization: payloadSerialization,
    initialSerializationCount: 1,
    sendHardLimitBytes: payloadSerialization.payloadBytes,
  })

  expect(result.budgetInstrumentation.serializations).toBe(1)
  expect(result.payloadSerialization).toBe(payloadSerialization)
  expect(result.finalPayloadBytes).toBe(payloadSerialization.payloadBytes)
})

test("serializes each unchanged actual transport exactly once", async () => {
  const httpStages: Array<string> = []
  const websocketStages: Array<string> = []
  let httpWebsocketFrame: string | undefined

  await createOptimizedCopilotResponses(
    { input: "http", model: "gpt-test" },
    {
      createResponses: (_payload, requestOptions) => {
        httpWebsocketFrame = requestOptions.wireArtifact?.websocketFrame
        return Promise.resolve(createResult("gpt-test"))
      },
      requestOptions: {
        initiator: "user",
        requestId: "request-http-serialization-count",
        transport: "http",
        vision: false,
        wireSerializationObserver: {
          onSerialization: (stage) => httpStages.push(stage),
        },
      },
    },
  )
  await createOptimizedCopilotResponses(
    { input: "websocket", model: "gpt-test", stream: true },
    {
      createResponses: () => Promise.resolve(createResult("gpt-test")),
      requestOptions: {
        initiator: "user",
        requestId: "request-websocket-serialization-count",
        transport: "websocket",
        vision: false,
        wireSerializationObserver: {
          onSerialization: (stage) => websocketStages.push(stage),
        },
      },
      selectedModel: { supported_endpoints: ["ws:/responses"] },
    },
  )

  expect(httpStages).toEqual(["budget_initial"])
  expect(httpWebsocketFrame).toBeUndefined()
  expect(websocketStages).toEqual(["budget_initial", "websocket_frame"])
})

test("uses the final image-mutated serialization as the wire artifact", async () => {
  const serializationStages: Array<string> = []
  const oldImageUrl = `data:image/png;base64,${"A".repeat(32)}`
  const latestImageUrl = `data:image/png;base64,${"B".repeat(4)}`
  const payload = {
    input: [
      {
        content: [
          { image_url: oldImageUrl, type: "input_image" },
          { text: "old", type: "input_text" },
        ],
        role: "user",
      },
      {
        content: [
          { image_url: latestImageUrl, type: "input_image" },
          { text: "latest", type: "input_text" },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  } as ResponsesPayload

  const prepared = await prepareCopilotResponsesPayloadForSend(payload, {
    createResponses: (outboundPayload) =>
      Promise.resolve(createResult(outboundPayload.model)),
    maxInputImageBytesOverride: 8,
    mode: "normal",
    requestOptions: {
      initiator: "user",
      requestId: "request-mutated-artifact",
      transport: "http",
      vision: true,
      wireSerializationObserver: {
        onSerialization: (stage) => serializationStages.push(stage),
      },
    },
  })

  expect(prepared.imageBudget.changed).toBe(true)
  expect(prepared.wireArtifact.httpBody).toBe(
    prepared.imageBudget.payloadSerialization.serializedPayload,
  )
  expect(prepared.wireArtifact.summary.httpBodyBytes).toBe(
    prepared.imageBudget.finalPayloadBytes,
  )
  expect(prepared.wireArtifact.httpBody).not.toContain(oldImageUrl)
  expect(JSON.stringify(payload)).toContain(oldImageUrl)
  expect(serializationStages[0]).toBe("budget_initial")
  expect(serializationStages.slice(1).length).toBeGreaterThan(0)
  expect(
    serializationStages.slice(1).every((stage) => stage === "budget_mutation"),
  ).toBe(true)
})

test("re-admits a successful 413 retry only after the payload changes", async () => {
  const config = getConfig()
  const original = {
    responsesImageAllowNormalReplacement:
      config.responsesImageAllowNormalReplacement,
    responsesImageCompression: config.responsesImageCompression,
    responsesPayloadBudgetBytes: config.responsesPayloadBudgetBytes,
    responsesPayloadRetryBudgetBytes: config.responsesPayloadRetryBudgetBytes,
    responsesPayloadSendHardLimitBytes:
      config.responsesPayloadSendHardLimitBytes,
  }
  Object.assign(config, {
    responsesImageAllowNormalReplacement: true,
    responsesImageCompression: true,
    responsesPayloadBudgetBytes: 1_150_000,
    responsesPayloadRetryBudgetBytes: 1_050_000,
    responsesPayloadSendHardLimitBytes: 1_250_000,
  })

  const oldImageUrl = `data:image/png;base64,${"A".repeat(1_100_000)}`
  const payload = {
    input: [
      {
        content: [
          { image_url: oldImageUrl, type: "input_image" },
          { text: "old", type: "input_text" },
        ],
        role: "user",
      },
      {
        content: [
          {
            image_url: `data:image/png;base64,${"B".repeat(4)}`,
            type: "input_image",
          },
          { text: "latest", type: "input_text" },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  } as ResponsesPayload
  const bodies: Array<string> = []
  const serializationStages: Array<string> = []
  let attempts = 0

  try {
    await createOptimizedCopilotResponses(payload, {
      createResponses: (_outboundPayload, requestOptions) => {
        attempts += 1
        bodies.push(requestOptions.wireArtifact?.httpBody ?? "")
        if (attempts === 1) {
          return Promise.reject(
            new HTTPError(
              "Failed to create responses",
              new Response("payload too large", { status: 413 }),
            ),
          )
        }
        return Promise.resolve(createResult("gpt-test"))
      },
      maxInputImageBytesOverride: 2_000_000,
      requestOptions: {
        initiator: "user",
        requestId: "request-successful-413-retry",
        transport: "http",
        vision: true,
        wireSerializationObserver: {
          onSerialization: (stage) => serializationStages.push(stage),
        },
      },
    })
  } finally {
    Object.assign(config, original)
  }

  expect(attempts).toBe(2)
  expect(bodies[0]).toContain(oldImageUrl)
  expect(bodies[1]).not.toContain(oldImageUrl)
  expect(Buffer.byteLength(bodies[1], "utf8")).toBeLessThan(
    Buffer.byteLength(bodies[0], "utf8"),
  )
  expect(serializationStages).toEqual([
    "budget_initial",
    "budget_initial",
    "budget_mutation",
  ])
})

test("replans retry from the unchanged logical payload and skips a non-smaller retry", async () => {
  const olderImageUrl = `data:image/png;base64,${"A".repeat(32)}`
  const payload = {
    input: [
      {
        content: [
          { text: "old", type: "input_text" },
          { image_url: olderImageUrl, type: "input_image" },
        ],
        role: "user",
      },
      {
        content: [
          { text: "latest", type: "input_text" },
          {
            image_url: `data:image/png;base64,${"B".repeat(4)}`,
            type: "input_image",
          },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  } as ResponsesPayload
  const pristinePayload = structuredClone(payload)
  const dispatchedPayloads: Array<ResponsesPayload> = []
  const budgetLogs: Array<Record<string, unknown>> = []

  let caught: unknown
  try {
    await createOptimizedCopilotResponses(payload, {
      createResponses: (outboundPayload) => {
        dispatchedPayloads.push(structuredClone(outboundPayload))
        return Promise.reject(
          new HTTPError(
            "Failed to create responses",
            new Response("payload too large", { status: 413 }),
          ),
        )
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (_message: unknown, context: unknown) => {
          if (context && typeof context === "object") {
            budgetLogs.push(context as Record<string, unknown>)
          }
        },
      } as never,
      maxInputImageBytesOverride: 8,
      requestOptions: {
        initiator: "user",
        requestId: "request-1",
        transport: "http",
        vision: true,
      },
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(HTTPError)
  expect(payload).toEqual(pristinePayload)
  expect(dispatchedPayloads).toHaveLength(1)
  expect(JSON.stringify(dispatchedPayloads[0])).not.toContain(olderImageUrl)
  expect(budgetLogs.map((entry) => entry.mode)).toEqual(["normal", "retry"])
  expect(budgetLogs[0]?.initialPayloadBytes).toBe(
    budgetLogs[1]?.initialPayloadBytes,
  )
})
