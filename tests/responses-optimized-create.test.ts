import { expect, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import {
  createOptimizedCopilotResponses,
  getResponsesSendHardLimitForTransport,
} from "../src/routes/responses/optimized-create"
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
