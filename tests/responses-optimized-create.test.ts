import { expect, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import {
  createOptimizedCopilotResponses,
  getResponsesSendHardLimitForTransport,
} from "../src/routes/responses/optimized-create"
import { HTTPError } from "~/lib/error"
import { buildResponsesWebSocketPayload } from "../src/services/copilot/create-responses"
import { calculateResponsesPayloadBytes } from "../src/routes/responses/utils"

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

test("does not clone an already prepared no-op payload before dispatch", async () => {
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

  expect(dispatchedPayload).toBe(payload)
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
