import { expect, mock, test } from "bun:test"

import { projectResponsesWebSocketChunk } from "../src/services/responses-websocket-chunk"

test("shared websocket chunk projector preserves DONE and unchanged wire JSON", () => {
  expect(projectResponsesWebSocketChunk("[DONE]")).toEqual({ data: "[DONE]" })

  const data =
    '{ "type": "response.completed", "id": "event-1", "sequence_number": 1, "response": {} }'
  expect(projectResponsesWebSocketChunk(data)).toEqual({
    data,
    event: "response.completed",
    id: "event-1",
  })
  expect(projectResponsesWebSocketChunk("not-json")).toEqual({
    data: "not-json",
  })
})

test("shared websocket chunk projector serializes only an injected error normalization", () => {
  const normalizeError = mock((event: Record<string, unknown>) => ({
    ...event,
    message: "normalized",
  }))
  const unchangedNormalizer = mock((event: Record<string, unknown>) => event)
  const data =
    '{ "type": "error", "id": "error-1", "message": "raw", "sequence_number": 1 }'

  const normalized = projectResponsesWebSocketChunk(data, { normalizeError })
  expect(normalizeError).toHaveBeenCalledTimes(1)
  expect(normalized).toEqual({
    data: JSON.stringify({
      type: "error",
      id: "error-1",
      message: "normalized",
      sequence_number: 1,
    }),
    event: "error",
    id: "error-1",
  })

  expect(
    projectResponsesWebSocketChunk(data, {
      normalizeError: unchangedNormalizer,
    }).data,
  ).toBe(data)
  expect(unchangedNormalizer).toHaveBeenCalledTimes(1)
})
