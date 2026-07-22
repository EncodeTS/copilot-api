import { expect, test } from "bun:test"

import {
  isResponsesStreamTerminalData,
  type ResponsesStreamNonTerminalEventType,
  type ResponsesStreamEventType,
} from "../src/lib/responses-stream-protocol"
import { incrementSaturatingCounter } from "../src/lib/saturating-counter"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../src/services/copilot/create-responses"

import {
  runResponsesStreamSession,
  type ResponsesStreamSessionChunk,
  type ResponsesStreamSessionFrame,
} from "../src/lib/responses-stream-session"

type EventUniversesMatch =
  [ResponsesStreamEventType] extends [ResponseStreamEvent["type"]] ?
    [ResponseStreamEvent["type"]] extends [ResponsesStreamEventType] ?
      true
    : false
  : false

const eventUniversesMatch: EventUniversesMatch = true

test("neutral and service Responses event universes match bidirectionally", () => {
  expect(eventUniversesMatch).toBe(true)
})

test("shared transport terminal detection preserves tolerant pool semantics", () => {
  expect(isResponsesStreamTerminalData('{"type":"response.completed"}')).toBe(
    true,
  )
  expect(isResponsesStreamTerminalData('{"type":"response.failed"}')).toBe(true)
  expect(isResponsesStreamTerminalData('{"type":"response.incomplete"}')).toBe(
    true,
  )
  expect(isResponsesStreamTerminalData('{"type":"error"}')).toBe(true)
  expect(isResponsesStreamTerminalData('{"type":"response.created"}')).toBe(
    false,
  )
  expect(isResponsesStreamTerminalData("not-json")).toBe(false)
})

test("Responses session parses data frames once and exposes content-free control classifications", async () => {
  const frames = new Array<ResponsesStreamSessionFrame>()

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frames.push(frame)
    },
    source: createStream([
      { event: "ping", data: "not-json", id: "ping-1" },
      { data: "{", id: "malformed-json" },
      { data: "null", id: 2 },
      {
        data: JSON.stringify({ type: "response.future.delta", secret: "x" }),
        event: "message",
        id: "unknown-1",
      },
      {
        data: JSON.stringify({
          content_index: 0,
          delta: "hello",
          item_id: "item-1",
          output_index: 0,
          sequence_number: 1,
          type: "response.output_text.delta",
        }),
      },
      { data: "[DONE]", event: "message", id: "done-1" },
      {
        data: JSON.stringify({
          response: createResult(),
          sequence_number: 2,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(frames.map((frame) => frame.kind)).toEqual([
    "ping",
    "malformed",
    "malformed",
    "unknown",
    "event",
    "done",
  ])
  expect(frames[1]).toMatchObject({ kind: "malformed" })
  expect(frames[0]?.wire).toEqual({
    comment: undefined,
    data: "not-json",
    event: "ping",
    id: "ping-1",
    retry: undefined,
  })
  expect(frames[1]?.wire).toEqual({
    comment: undefined,
    data: "{",
    event: undefined,
    id: "malformed-json",
    retry: undefined,
  })
  expect(frames[2]).toMatchObject({ kind: "malformed", parsed: null })
  expect(frames[3]).toMatchObject({
    kind: "unknown",
    parsed: { secret: "x", type: "response.future.delta" },
    wire: {
      event: "message",
      id: "unknown-1",
    },
  })
  expect(Object.isFrozen(frames[3]?.wire)).toBe(true)
  expect(outcome.kind).toBe("eof")
  expect(outcome.diagnostics).toMatchObject({
    doneCount: 1,
    eventCount: 1,
    frameCount: 6,
    lastEventType: "response.output_text.delta",
    malformedCount: 2,
    pingCount: 1,
    terminalSeen: false,
    unknownCount: 1,
  })
  if (outcome.kind === "eof") {
    expect(outcome.endedBy).toBe("done")
  }
})

test("Responses session can observe a DONE marker without ending adapter-owned streams", async () => {
  const response = createResult()
  const frames = new Array<ResponsesStreamSessionFrame>()

  const outcome = await runResponsesStreamSession({
    doneMarkerBehavior: "continue",
    onFrame: (frame) => {
      frames.push(frame)
    },
    source: createThrowingStream(
      [
        { data: "[DONE]", event: "message" },
        {
          data: JSON.stringify({
            response,
            sequence_number: 1,
            type: "response.completed",
          }),
        },
      ],
      "read past terminal",
    ),
  })

  expect(frames.map((frame) => frame.kind)).toEqual(["done", "event"])
  expect(outcome.kind).toBe("completed")
})

test("Responses session delivers data-free SSE envelope metadata without loss", async () => {
  const frames = new Array<ResponsesStreamSessionFrame>()
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frames.push(frame)
    },
    source: createStream([
      { id: "id-only" },
      { event: "metadata-only" },
      { comment: "keepalive" },
      { retry: 1500 },
      { data: "", id: "empty-data" },
      {
        data: JSON.stringify({
          response: createResult(),
          sequence_number: 1,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("completed")
  expect(frames.map((frame) => frame.kind)).toEqual([
    "envelope",
    "envelope",
    "envelope",
    "envelope",
    "envelope",
    "event",
  ])
  expect(frames.slice(0, 5).map((frame) => frame.wire)).toEqual([
    {
      comment: undefined,
      data: undefined,
      event: undefined,
      id: "id-only",
      retry: undefined,
    },
    {
      comment: undefined,
      data: undefined,
      event: "metadata-only",
      id: undefined,
      retry: undefined,
    },
    {
      comment: "keepalive",
      data: undefined,
      event: undefined,
      id: undefined,
      retry: undefined,
    },
    {
      comment: undefined,
      data: undefined,
      event: undefined,
      id: undefined,
      retry: 1500,
    },
    {
      comment: undefined,
      data: "",
      event: undefined,
      id: "empty-data",
      retry: undefined,
    },
  ])
  expect(frames.slice(0, 5).every((frame) => Object.isFrozen(frame.wire))).toBe(
    true,
  )
  expect(outcome.diagnostics).toMatchObject({
    envelopeCount: 5,
    frameCount: 6,
  })
})

test("Responses session returns completed usage and never pulls after the terminal frame", async () => {
  const frames = new Array<ResponsesStreamSessionFrame>()
  const response = createResult()
  response.usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
    output_tokens: 4,
    total_tokens: 16,
  }

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frames.push(frame)
    },
    source: createThrowingStream(
      [
        {
          data: JSON.stringify({
            copilot_usage: { total_nano_aiu: 3_000_000_000 },
            response,
            sequence_number: 1,
            type: "response.completed",
          }),
        },
      ],
      "read past terminal",
    ),
  })

  expect(outcome.kind).toBe("completed")
  expect(outcome.terminal?.usage).toEqual({
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 2,
    input_tokens: 7,
    output_tokens: 4,
    total_nano_aiu: 3_000_000_000,
    total_tokens: 16,
  })
  expect("event" in outcome).toBe(false)
  expect("usage" in outcome).toBe(false)
  expect(frames.map((frame) => frame.kind)).toEqual(["event"])
  expect(outcome.diagnostics).toMatchObject({
    eventCount: 1,
    frameCount: 1,
    lastEventType: "response.completed",
    terminalSeen: true,
  })
})

test("Responses session preserves incomplete as a distinct terminal outcome", async () => {
  const response = createResult()
  response.status = "incomplete"
  response.incomplete_details = { reason: "max_output_tokens" }
  response.usage = {
    input_tokens: 5,
    input_tokens_details: { cached_tokens: 8 },
    output_tokens: 2.9,
    total_tokens: 7.9,
  }

  const outcome = await runResponsesStreamSession({
    source: createStream([
      {
        data: JSON.stringify({
          copilot_usage: { total_nano_aiu: 11.9 },
          response,
          sequence_number: 1,
          type: "response.incomplete",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("incomplete")
  expect(outcome.terminal?.usage).toEqual({
    cache_read_input_tokens: 8,
    input_tokens: 0,
    output_tokens: 2,
    total_nano_aiu: 11,
    total_tokens: 7,
  })
  if (outcome.kind === "incomplete") {
    expect(outcome.terminal.event.response.incomplete_details?.reason).toBe(
      "max_output_tokens",
    )
  }
})

test("Responses session preserves failed response usage and error details", async () => {
  const response = createResult()
  response.status = "failed"
  response.error = { code: "upstream_error", message: "generation failed" }
  response.copilot_usage = { total_nano_aiu: 900 }
  response.usage = {
    input_tokens: 9,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens: 1,
    total_tokens: 10,
  }
  const frames = new Array<ResponsesStreamSessionFrame>()

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frames.push(frame)
    },
    source: createStream([
      {
        data: JSON.stringify({
          response,
          sequence_number: 1,
          type: "response.failed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("failed")
  expect(outcome.terminal?.usage).toEqual({
    cache_read_input_tokens: 3,
    input_tokens: 6,
    output_tokens: 1,
    total_nano_aiu: 900,
    total_tokens: 10,
  })
  expect(frames).toHaveLength(1)
  if (outcome.kind === "failed") {
    expect(outcome.terminal.event.response.error?.message).toBe(
      "generation failed",
    )
  }
})

test("Responses session preserves an error event as its own terminal outcome", async () => {
  const outcome = await runResponsesStreamSession({
    source: createThrowingStream(
      [
        {
          data: JSON.stringify({
            code: "upstream_error",
            error: {
              code: "upstream_error",
              message: "stream failed",
              type: "server_error",
            },
            message: "fallback",
            param: null,
            sequence_number: 1,
            type: "error",
          }),
        },
      ],
      "read past error terminal",
    ),
  })

  expect(outcome.kind).toBe("error")
  expect(outcome.terminal?.usage).toEqual({})
  expect(outcome.diagnostics.terminalSeen).toBe(true)
  if (outcome.kind === "error") {
    expect(outcome.terminal.event.error?.message).toBe("stream failed")
  }
})

test("Responses session recognizes every current non-terminal Responses event type", async () => {
  const eventFixtures = {
    "response.content_part.added": {},
    "response.content_part.done": {},
    "response.created": {},
    "response.function_call_arguments.delta": {},
    "response.function_call_arguments.done": {},
    "response.in_progress": {},
    "response.output_item.added": {},
    "response.output_item.done": {},
    "response.output_text.annotation.added": {},
    "response.output_text.delta": {},
    "response.output_text.done": {},
    "response.reasoning_summary_part.added": {},
    "response.reasoning_summary_part.done": {},
    "response.reasoning_summary_text.delta": {},
    "response.reasoning_summary_text.done": {},
    "response.refusal.delta": {},
    "response.refusal.done": {},
    "response.web_search_call.completed": {},
    "response.web_search_call.in_progress": {},
    "response.web_search_call.searching": {},
  } satisfies Record<ResponsesStreamNonTerminalEventType, object>
  const eventEntries = Object.entries(eventFixtures)
  const frameKinds = new Array<ResponsesStreamSessionFrame["kind"]>()

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frameKinds.push(frame.kind)
    },
    source: createStream(
      eventEntries.map(([type, fixture], sequence_number) => ({
        data: JSON.stringify({ ...fixture, sequence_number, type }),
      })),
    ),
  })

  expect(outcome.kind).toBe("eof")
  expect(frameKinds).toEqual(eventEntries.map(() => "event"))
  expect(outcome.diagnostics.eventCount).toBe(eventEntries.length)
  expect(outcome.diagnostics.unknownCount).toBe(0)
})

test("Responses session treats structurally invalid known events as malformed and non-terminal", async () => {
  const frameKinds = new Array<ResponsesStreamSessionFrame["kind"]>()
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frameKinds.push(frame.kind)
    },
    source: createStream([
      {
        data: JSON.stringify({
          sequence_number: 1,
          type: "response.completed",
        }),
      },
      {
        data: JSON.stringify({
          delta: "missing sequence number",
          type: "response.output_text.delta",
        }),
      },
      {
        data: JSON.stringify({
          response: createResult(),
          sequence_number: 2,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("completed")
  expect(frameKinds).toEqual(["malformed", "malformed", "event"])
  expect(outcome.diagnostics).toMatchObject({
    eventCount: 1,
    malformedCount: 2,
    terminalSeen: true,
  })
})

test("Responses session rejects invalid nested terminal containers", async () => {
  const invalidTerminals = {
    incompleteDetails: {
      response: {
        ...createResult(),
        incomplete_details: "not-an-object",
      },
      sequence_number: 2,
      type: "response.incomplete",
    },
    responseError: {
      response: { ...createResult(), error: "not-an-object" },
      sequence_number: 1,
      type: "response.failed",
    },
    topLevelError: {
      error: "not-an-object",
      message: "fallback",
      sequence_number: 3,
      type: "error",
    },
  } as const
  const frameKinds = new Array<ResponsesStreamSessionFrame["kind"]>()

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      frameKinds.push(frame.kind)
    },
    source: createStream([
      ...Object.values(invalidTerminals).map((event) => ({
        data: JSON.stringify(event),
      })),
      {
        data: JSON.stringify({
          response: createResult(),
          sequence_number: 4,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("completed")
  expect(frameKinds).toEqual(["malformed", "malformed", "malformed", "event"])
  expect(outcome.diagnostics.malformedCount).toBe(3)
})

test("Responses session returns a throw outcome with content-free diagnostics", async () => {
  const sourceError = new Error("private upstream detail")
  const outcome = await runResponsesStreamSession({
    source: createErrorStream(
      [
        {
          data: JSON.stringify({
            content_index: 0,
            delta: "private response text",
            item_id: "item-1",
            output_index: 0,
            sequence_number: 1,
            type: "response.output_text.delta",
          }),
        },
      ],
      sourceError,
    ),
  })

  expect(outcome.kind).toBe("throw")
  if (outcome.kind === "throw") {
    expect(outcome.error).toBe(sourceError)
  }
  expect(outcome.diagnostics).toMatchObject({
    eventCount: 1,
    lastEventType: "response.output_text.delta",
    terminalSeen: false,
  })
  expect(JSON.stringify(outcome.diagnostics)).not.toContain("private")
})

test("Responses session converts iterator creation failures into throw outcomes", async () => {
  const sourceError = new Error("iterator creation failed")
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      throw sourceError
    },
  }

  const outcome = await runResponsesStreamSession({ source })

  expect(outcome.kind).toBe("throw")
  if (outcome.kind === "throw") {
    expect(outcome.error).toBe(sourceError)
  }
  expect(outcome.diagnostics.eventCount).toBe(0)
})

test("Responses session distinguishes a nested upstream timeout from a generic throw", async () => {
  const timeout = new UpstreamLifecycleTimeoutError("Responses body", 10_000)
  const wrapped = new Error("request closed", { cause: timeout })

  const outcome = await runResponsesStreamSession({
    source: createErrorStream([], wrapped),
  })

  expect(outcome.kind).toBe("timeout")
  if (outcome.kind === "timeout") {
    expect(outcome.error).toBe(timeout)
    expect(outcome.error.phase).toBe("Responses body")
    expect(outcome.error.timeoutMs).toBe(10_000)
  }
  expect(outcome.diagnostics.terminalSeen).toBe(false)
})

test("Responses session preserves caller abort reason and does not pull another frame", async () => {
  const controller = new AbortController()
  const reason = new Error("caller disconnected")
  const responseDelta = {
    data: JSON.stringify({
      content_index: 0,
      delta: "hello",
      item_id: "item-1",
      output_index: 0,
      sequence_number: 1,
      type: "response.output_text.delta",
    }),
  }
  let pullCount = 0
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          pullCount += 1
          if (pullCount === 1) {
            return Promise.resolve({
              done: false as const,
              value: responseDelta,
            })
          }
          throw new Error("read after abort")
        },
        return: () =>
          Promise.resolve({ done: true as const, value: undefined }),
      }
    },
  }

  const outcome = await runResponsesStreamSession({
    onFrame: () => {
      controller.abort(reason)
    },
    signal: controller.signal,
    source,
  })

  expect(outcome.kind).toBe("abort")
  expect(pullCount).toBe(1)
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

test("Responses session diagnostics saturate elapsed time without wrapping", async () => {
  const originalNow = Date.now
  let nowCalls = 0
  Date.now = () => {
    nowCalls += 1
    return nowCalls === 1 ? 0 : Number.MAX_SAFE_INTEGER * 2
  }

  try {
    const outcome = await runResponsesStreamSession({
      source: createStream([]),
    })
    expect(outcome.diagnostics.elapsedMs).toBe(Number.MAX_SAFE_INTEGER)
  } finally {
    Date.now = originalNow
  }
})

test("every Responses diagnostic event counter saturates without wrapping", () => {
  const counters = {
    doneCount: Number.MAX_SAFE_INTEGER - 1,
    envelopeCount: Number.MAX_SAFE_INTEGER - 1,
    eventCount: Number.MAX_SAFE_INTEGER - 1,
    frameCount: Number.MAX_SAFE_INTEGER - 1,
    malformedCount: Number.MAX_SAFE_INTEGER - 1,
    pingCount: Number.MAX_SAFE_INTEGER - 1,
    unknownCount: Number.MAX_SAFE_INTEGER - 1,
  }
  const saturationSteps = {
    doneCount: () => incrementSaturatingCounter(counters, "doneCount", 2),
    envelopeCount: () =>
      incrementSaturatingCounter(counters, "envelopeCount", 2),
    eventCount: () => incrementSaturatingCounter(counters, "eventCount", 2),
    frameCount: () => incrementSaturatingCounter(counters, "frameCount", 2),
    malformedCount: () =>
      incrementSaturatingCounter(counters, "malformedCount", 2),
    pingCount: () => incrementSaturatingCounter(counters, "pingCount", 2),
    unknownCount: () => incrementSaturatingCounter(counters, "unknownCount", 2),
  } satisfies Record<keyof typeof counters, () => void>

  for (const saturate of Object.values(saturationSteps)) saturate()

  expect(counters).toEqual({
    doneCount: Number.MAX_SAFE_INTEGER,
    envelopeCount: Number.MAX_SAFE_INTEGER,
    eventCount: Number.MAX_SAFE_INTEGER,
    frameCount: Number.MAX_SAFE_INTEGER,
    malformedCount: Number.MAX_SAFE_INTEGER,
    pingCount: Number.MAX_SAFE_INTEGER,
    unknownCount: Number.MAX_SAFE_INTEGER,
  })
})

test("Responses session distinguishes natural source EOF from a DONE marker", async () => {
  const outcome = await runResponsesStreamSession({ source: createStream([]) })

  expect(outcome.kind).toBe("eof")
  if (outcome.kind === "eof") {
    expect(outcome.endedBy).toBe("source")
  }
  expect(outcome.diagnostics).toMatchObject({
    doneCount: 0,
    eventCount: 0,
    frameCount: 0,
    lastEventType: null,
    terminalSeen: false,
  })
})

test("Responses session preserves abort raised while delivering a non-terminal DONE marker", async () => {
  const controller = new AbortController()
  const reason = new Error("client closed during DONE delivery")
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind === "done") controller.abort(reason)
    },
    signal: controller.signal,
    source: createStream([{ data: "[DONE]" }]),
  })

  expect(outcome.kind).toBe("abort")
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

test("Responses session checks an already-aborted timeout before pulling the source", async () => {
  const controller = new AbortController()
  const timeout = new UpstreamLifecycleTimeoutError("Responses first byte", 5)
  controller.abort(timeout)
  let pulled = false
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      pulled = true
      throw new Error("source should not be opened")
    },
  }

  const outcome = await runResponsesStreamSession({
    signal: controller.signal,
    source,
  })

  expect(outcome.kind).toBe("timeout")
  expect(pulled).toBe(false)
  if (outcome.kind === "timeout") {
    expect(outcome.error).toBe(timeout)
  }
})

test("Responses session aborts a stuck first read and requests iterator cleanup", async () => {
  const controller = new AbortController()
  const reason = new Error("caller aborted before first byte")
  let cleanupCalls = 0
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<{ data?: string }>>(() => {}),
        return: () => {
          cleanupCalls += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }

  const pendingOutcome = runResponsesStreamSession({
    signal: controller.signal,
    source,
  })
  queueMicrotask(() => controller.abort(reason))
  const outcome = await settleWithin(pendingOutcome, 250)

  expect(outcome.kind).toBe("abort")
  expect(cleanupCalls).toBe(1)
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

test("Responses session times out a stuck midstream read with the actual timeout reason", async () => {
  const controller = new AbortController()
  const timeout = new UpstreamLifecycleTimeoutError(
    "Responses inactivity",
    30_000,
  )
  let cleanupCalls = 0
  let nextCalls = 0
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          nextCalls += 1
          if (nextCalls === 1) {
            return Promise.resolve({
              done: false as const,
              value: {
                data: JSON.stringify({
                  content_index: 0,
                  delta: "hello",
                  item_id: "item-1",
                  output_index: 0,
                  sequence_number: 1,
                  type: "response.output_text.delta",
                }),
              },
            })
          }
          queueMicrotask(() => controller.abort(timeout))
          return new Promise<IteratorResult<{ data?: string }>>(() => {})
        },
        return: () => {
          cleanupCalls += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }

  const outcome = await settleWithin(
    runResponsesStreamSession({ signal: controller.signal, source }),
    250,
  )

  expect(outcome.kind).toBe("timeout")
  expect(outcome.diagnostics.eventCount).toBe(1)
  expect(cleanupCalls).toBe(1)
  if (outcome.kind === "timeout") {
    expect(outcome.error).toBe(timeout)
    expect(outcome.error.phase).toBe("Responses inactivity")
    expect(outcome.error.timeoutMs).toBe(30_000)
  }
})

test("Responses session does not truncate a long legal text stream by event count", async () => {
  const deltaCount = 25_000
  const delta = JSON.stringify({
    content_index: 0,
    delta: "x",
    item_id: "item-1",
    output_index: 0,
    sequence_number: 1,
    type: "response.output_text.delta",
  })
  const completed = JSON.stringify({
    response: createResult(),
    sequence_number: deltaCount + 1,
    type: "response.completed",
  })
  let deliveredCount = 0

  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind === "event") deliveredCount += 1
    },
    source: (async function* () {
      await Promise.resolve()
      for (let index = 0; index < deltaCount; index += 1) {
        yield { data: delta }
      }
      yield { data: completed }
    })(),
  })

  expect(outcome.kind).toBe("completed")
  expect(deliveredCount).toBe(deltaCount + 1)
  expect(outcome.diagnostics.eventCount).toBe(deltaCount + 1)
  expect(outcome.diagnostics.frameCount).toBe(deltaCount + 1)
})

test("Responses session returns delivery failure with frozen terminal truth", async () => {
  const sinkError = new Error("downstream write failed")
  const response = createResult()
  response.usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    total_tokens: 16,
  }
  const outcome = await runResponsesStreamSession({
    onFrame: () => {
      throw sinkError
    },
    source: createStream([
      {
        data: JSON.stringify({
          copilot_usage: { total_nano_aiu: 1234 },
          response,
          sequence_number: 1,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("delivery_failed")
  expect(outcome.diagnostics.terminalSeen).toBe(true)
  if (outcome.kind === "delivery_failed") {
    expect(outcome.deliveryError).toBe(sinkError)
    expect(outcome.terminal).toMatchObject({
      kind: "completed",
      usage: {
        cache_read_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 4,
        total_nano_aiu: 1234,
        total_tokens: 16,
      },
    })
    expect(Object.isFrozen(outcome.terminal)).toBe(true)
    expect(Object.isFrozen(outcome.terminal?.usage)).toBe(true)
  }
})

test("Responses session terminal truth cannot be changed by the event callback", async () => {
  const response = createResult()
  response.usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 3,
    total_tokens: 13,
  }

  let mutationRejected = false
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind !== "event" || !frame.terminal) return
      const mutableEvent = frame.event as unknown as {
        response?: { usage?: { input_tokens: number } | null }
        type: string
      }
      try {
        mutableEvent.type = "response.output_text.delta"
      } catch {
        mutationRejected = true
      }
      try {
        if (mutableEvent.response?.usage) {
          mutableEvent.response.usage.input_tokens = 999
        }
      } catch {
        mutationRejected = true
      }
    },
    source: createStream([
      {
        data: JSON.stringify({
          copilot_usage: { total_nano_aiu: 77 },
          response,
          sequence_number: 1,
          type: "response.completed",
        }),
      },
    ]),
  })

  expect(outcome.kind).toBe("completed")
  expect(mutationRejected).toBe(true)
  expect(outcome.terminal?.usage).toEqual({
    cache_read_input_tokens: 2,
    input_tokens: 8,
    output_tokens: 3,
    total_nano_aiu: 77,
    total_tokens: 13,
  })
  if (outcome.kind === "completed") {
    expect(outcome.terminal.event.type).toBe("response.completed")
  }
})

test("Responses session aborts stuck terminal delivery and preserves terminal truth", async () => {
  const controller = new AbortController()
  const reason = new Error("client closed while terminal delivery was blocked")
  const response = createResult()
  response.usage = {
    input_tokens: 9,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    total_tokens: 13,
  }
  const terminalWire = {
    data: JSON.stringify({
      copilot_usage: { total_nano_aiu: 4321 },
      response,
      sequence_number: 1,
      type: "response.completed",
    }),
  }
  let cleanupCalls = 0
  let nextCalls = 0
  const source: AsyncIterable<typeof terminalWire> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          nextCalls += 1
          return Promise.resolve(
            nextCalls === 1 ?
              { done: false as const, value: terminalWire }
            : { done: true as const, value: undefined },
          )
        },
        return: () => {
          cleanupCalls += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }

  const pendingOutcome = runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind === "event" && frame.terminal) {
        queueMicrotask(() => controller.abort(reason))
        return new Promise<void>(() => {})
      }
    },
    signal: controller.signal,
    source,
  })
  const outcome = await settleWithin(pendingOutcome, 250)

  expect(outcome.kind).toBe("abort")
  expect(cleanupCalls).toBe(1)
  expect(outcome.terminal).toMatchObject({
    kind: "completed",
    usage: {
      cache_read_input_tokens: 2,
      input_tokens: 7,
      output_tokens: 4,
      total_nano_aiu: 4321,
      total_tokens: 13,
    },
  })
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

test("Responses session does not misclassify a writer rejection after signal abort", async () => {
  const controller = new AbortController()
  const reason = new Error("caller aborted delivery")
  const writerError = new Error("writer rejected after abort")

  const outcome = await settleWithin(
    runResponsesStreamSession({
      onFrame: () =>
        new Promise<void>((_resolve, reject) => {
          queueMicrotask(() => {
            controller.abort(reason)
            queueMicrotask(() => reject(writerError))
          })
        }),
      signal: controller.signal,
      source: createStream([{ event: "ping" }]),
    }),
    250,
  )

  expect(outcome.kind).toBe("abort")
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

test("Responses session interrupts a stuck writer with the lifecycle timeout reason", async () => {
  const controller = new AbortController()
  const timeout = new UpstreamLifecycleTimeoutError(
    "Responses downstream delivery",
    45_000,
  )

  const outcome = await settleWithin(
    runResponsesStreamSession({
      onFrame: () => {
        queueMicrotask(() => controller.abort(timeout))
        return new Promise<void>(() => {})
      },
      signal: controller.signal,
      source: createStream([{ event: "ping" }]),
    }),
    250,
  )

  expect(outcome.kind).toBe("timeout")
  if (outcome.kind === "timeout") {
    expect(outcome.error).toBe(timeout)
    expect(outcome.error.phase).toBe("Responses downstream delivery")
  }
})

test("Responses session preserves abort when the source closes without throwing", async () => {
  const controller = new AbortController()
  const reason = new Error("caller closed while source was waiting")
  const source: AsyncIterable<{ data?: string; event?: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await Promise.resolve()
          controller.abort(reason)
          return { done: true as const, value: undefined }
        },
      }
    },
  }

  const outcome = await runResponsesStreamSession({
    signal: controller.signal,
    source,
  })

  expect(outcome.kind).toBe("abort")
  if (outcome.kind === "abort") {
    expect(outcome.reason).toBe(reason)
  }
})

async function* createStream(
  frames: Array<ResponsesStreamSessionChunk>,
): AsyncGenerator<ResponsesStreamSessionChunk> {
  for (const frame of frames) {
    await Promise.resolve()
    yield frame
  }
}

async function* createThrowingStream(
  frames: Array<ResponsesStreamSessionChunk>,
  message: string,
): AsyncGenerator<ResponsesStreamSessionChunk> {
  yield* createStream(frames)
  throw new Error(message)
}

async function* createErrorStream(
  frames: Array<ResponsesStreamSessionChunk>,
  error: unknown,
): AsyncGenerator<ResponsesStreamSessionChunk> {
  yield* createStream(frames)
  throw error
}

const createResult = (): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-session",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
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

const settleWithin = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
