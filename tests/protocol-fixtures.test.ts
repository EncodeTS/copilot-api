import { expect, test } from "bun:test"

import {
  createAnthropicSseStream,
  createAnthropicTerminalEvents,
  createAnthropicUsage,
  createResponsesResult,
  createResponsesSseStream,
  createResponsesTerminalEvent,
  createResponsesUsage,
} from "./fixtures/protocol"

test("Responses fixtures build a typed terminal stream with safe synthetic data", async () => {
  const usage = createResponsesUsage({ output_tokens: 7, total_tokens: 19 })
  const terminal = createResponsesTerminalEvent("response.completed", {
    response: createResponsesResult({ usage }),
  })

  expect(terminal.response.usage).toEqual({
    input_tokens: 12,
    input_tokens_details: {
      cached_tokens: 2,
      cache_write_tokens: 1,
    },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 19,
  })
  expect(await collect(createResponsesSseStream([terminal]))).toEqual([
    { data: JSON.stringify(terminal), event: "response.completed" },
  ])
  expectProtocolFixtureToBeSafe(terminal)
})

test("Responses fixtures cover incomplete, failed, and post-terminal transport failure", async () => {
  const incomplete = createResponsesTerminalEvent("response.incomplete")
  const failed = createResponsesTerminalEvent("response.failed")

  expect(incomplete.response).toMatchObject({
    incomplete_details: { reason: "max_output_tokens" },
    status: "incomplete",
  })
  expect(failed.response).toMatchObject({
    error: { code: "fixture_error", message: "fixture failure" },
    status: "failed",
  })

  const stream = createResponsesSseStream([incomplete], {
    errorAfter: new Error("fixture disconnect"),
  })
  const iterator = stream[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({
    done: false,
    value: {
      data: JSON.stringify(incomplete),
      event: "response.incomplete",
    },
  })
  expect(iterator.next()).rejects.toThrow("fixture disconnect")
  expectProtocolFixtureToBeSafe([incomplete, failed])
})

test("Responses terminal type overrides contradictory response state", () => {
  const contradictory = createResponsesResult({
    error: { code: "wrong", message: "wrong state" },
    incomplete_details: { reason: "content_filter" },
    status: "incomplete",
  })

  expect(
    createResponsesTerminalEvent("response.completed", {
      response: contradictory,
    }).response,
  ).toMatchObject({
    error: null,
    incomplete_details: null,
    status: "completed",
  })
  expect(
    createResponsesTerminalEvent("response.failed", {
      response: { ...contradictory, error: null },
    }).response,
  ).toMatchObject({
    error: { code: "fixture_error", message: "fixture failure" },
    incomplete_details: null,
    status: "failed",
  })
  expect(
    createResponsesTerminalEvent("response.incomplete", {
      response: {
        ...contradictory,
        error: { code: "wrong", message: "wrong state" },
        incomplete_details: null,
        status: "failed",
      },
    }).response,
  ).toMatchObject({
    error: null,
    incomplete_details: { reason: "max_output_tokens" },
    status: "incomplete",
  })
})

test("Anthropic fixtures keep terminal usage on message_delta before message_stop", async () => {
  const usage = createAnthropicUsage({
    cache_read_input_tokens: 3,
    output_tokens: 5,
  })
  const terminal = createAnthropicTerminalEvents({ usage })

  expect(terminal).toEqual([
    {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      type: "message_delta",
      usage,
    },
    { type: "message_stop" },
  ])
  expect(await collect(createAnthropicSseStream(terminal))).toEqual(
    terminal.map((event) => ({
      data: JSON.stringify(event),
      event: event.type,
    })),
  )
  expectProtocolFixtureToBeSafe(terminal)
})

async function collect<T>(stream: AsyncIterable<T>): Promise<Array<T>> {
  const items: Array<T> = []
  for await (const item of stream) items.push(item)
  return items
}

function expectProtocolFixtureToBeSafe(value: unknown): void {
  const serialized = JSON.stringify(value)

  expect(serialized).not.toMatch(
    /authorization|api[_-]?key|bearer|cookie|github_token/iu,
  )
  expect(serialized).not.toMatch(
    /encrypted_content|file_data|image_url|input_audio|prompt/iu,
  )
  expect(serialized).not.toMatch(/\b(?:resp|msg|call|item)_[a-zA-Z0-9]+\b/u)
}
