import { expect, test } from "bun:test"

import {
  prefetchResponsesStreamSession,
  type PrefetchedResponsesSession,
} from "../src/routes/provider/responses/stream-prefetch"
import {
  runResponsesStreamSession,
  type ResponsesStreamSessionOutcome,
} from "../src/lib/responses-stream-session"
import type { ResponsesStream } from "../src/services/copilot/create-responses"

type TerminalKind = "completed" | "error" | "failed" | "incomplete"

for (const terminal of [
  "completed",
  "incomplete",
  "failed",
  "error",
] as const) {
  test(`provider prefetch session owns first-frame ${terminal} and cancels its iterator`, async () => {
    const inspected = createInspectableStream([createTerminalChunk(terminal)])
    const observed = new Array<unknown>()

    const result = await prefetchResponsesStreamSession({
      observeFrame: (frame) => {
        if (frame.kind === "event") observed.push(frame.event)
      },
      source: inspected.stream,
    })

    expect(result.kind).toBe("settled")
    if (result.kind !== "settled") throw new Error("expected settled session")
    expect(result.outcome.kind).toBe(terminal)
    expect(result.frames).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(inspected.nextCount()).toBe(1)
    expect(inspected.returnCount()).toBe(1)
  })
}

test("provider prefetch session classifies EOF and source throw through the session", async () => {
  const eof = createInspectableStream([])
  const eofResult = await prefetchResponsesStreamSession({ source: eof.stream })
  expectSettledKind(eofResult, "eof")
  expect(eof.returnCount()).toBe(1)

  const thrown = createInspectableStream([], {
    nextError: new Error("prefetch failed"),
  })
  const throwResult = await prefetchResponsesStreamSession({
    source: thrown.stream,
  })
  expectSettledKind(throwResult, "throw")
  expect(thrown.returnCount()).toBe(1)

  const iteratorError = new Error("iterator creation failed")
  const creationResult = await prefetchResponsesStreamSession({
    source: {
      [Symbol.asyncIterator]: () => {
        throw iteratorError
      },
    },
  })
  expectSettledKind(creationResult, "throw")
  if (creationResult.kind !== "settled") {
    throw new Error("expected settled session")
  }
  if (creationResult.outcome.kind !== "throw") {
    throw new Error("expected throw outcome")
  }
  expect(creationResult.outcome.error).toBe(iteratorError)
})

test("provider prefetch session cancels without pulling when already aborted", async () => {
  const controller = new AbortController()
  controller.abort(new Error("caller aborted"))
  const inspected = createInspectableStream([createTerminalChunk("completed")])

  const result = await prefetchResponsesStreamSession({
    signal: controller.signal,
    source: inspected.stream,
  })

  expectSettledKind(result, "abort")
  expect(inspected.nextCount()).toBe(0)
  expect(inspected.returnCount()).toBe(1)
})

test("provider prefetch session cancels a pending first read on abort", async () => {
  const controller = new AbortController()
  let returnCount = 0
  const pending = prefetchResponsesStreamSession({
    signal: controller.signal,
    source: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<{ data?: string; event?: string }>>(
            () => {},
          ),
        return: () => {
          returnCount += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }),
    },
  })

  controller.abort(new Error("caller aborted during prefetch"))
  const result = await pending

  expectSettledKind(result, "abort")
  expect(returnCount).toBe(1)
})

test("provider prefetch continuation replays metadata once and delegates return", async () => {
  const metadata = {
    data: JSON.stringify({
      plan_type: "team",
      rate_limits: {},
      type: "codex.rate_limits",
    }),
    event: "codex.rate_limits",
  }
  const inspected = createInspectableStream([
    metadata,
    createTerminalChunk("completed"),
  ])
  const result = await prefetchResponsesStreamSession({
    source: inspected.stream,
  })
  expect(result.kind).toBe("continue")
  if (result.kind !== "continue") throw new Error("expected continuation")

  const observed = new Array<unknown>()
  const outcome = await runResponsesStreamSession({
    onFrame: (frame) => {
      if (frame.kind === "unknown") observed.push(frame.parsed)
    },
    source: result.source,
  })
  await result.cancel()

  expect(outcome.kind).toBe("completed")
  expect(observed).toEqual([
    expect.objectContaining({ type: "codex.rate_limits" }),
  ])
  expect(inspected.nextCount()).toBe(2)
  expect(inspected.returnCount()).toBe(1)
})

test("provider prefetch iterator delegates throw before its cached frame is consumed", async () => {
  const inspected = createInspectableStream([createTerminalChunk("completed")])
  const result = await prefetchResponsesStreamSession({
    source: inspected.stream,
  })
  expect(result.kind).toBe("settled")

  const continuation = createInspectableStream([createNonTerminalChunk()])
  const pending = await prefetchResponsesStreamSession({
    source: continuation.stream,
  })
  expect(pending.kind).toBe("continue")
  if (pending.kind !== "continue") throw new Error("expected continuation")
  const reason = new Error("downstream rejected stream")
  const iterator = pending.source[Symbol.asyncIterator]()
  const throwIntoIterator = iterator.throw?.bind(iterator)
  expect(throwIntoIterator).toBeFunction()
  if (!throwIntoIterator) {
    throw new Error("expected iterator throw delegation")
  }
  const thrownResult = await Promise.resolve(throwIntoIterator(reason))
  expect(thrownResult).toMatchObject({ done: true })
  expect(continuation.throwCount()).toBe(1)
})

const expectSettledKind = (
  result: PrefetchedResponsesSession,
  kind: ResponsesStreamSessionOutcome["kind"],
): void => {
  expect(result.kind).toBe("settled")
  if (result.kind !== "settled") throw new Error("expected settled session")
  expect(result.outcome.kind).toBe(kind)
}

const createTerminalChunk = (terminal: TerminalKind) => {
  if (terminal === "error") {
    return {
      data: JSON.stringify({
        code: "upstream_error",
        message: "failed",
        sequence_number: 1,
        type: "error",
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        copilot_usage: { total_nano_aiu: 9 },
      }),
      event: "error",
    }
  }
  return {
    data: JSON.stringify({
      response: {
        error:
          terminal === "failed" ?
            { code: "upstream_error", message: "failed" }
          : null,
        incomplete_details:
          terminal === "incomplete" ? { reason: "max_output_tokens" } : null,
        status: terminal,
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
      sequence_number: 1,
      type: `response.${terminal}`,
    }),
    event: `response.${terminal}`,
  }
}

const createNonTerminalChunk = () => ({
  data: JSON.stringify({
    sequence_number: 0,
    type: "response.in_progress",
  }),
  event: "response.in_progress",
})

const createInspectableStream = (
  chunks: Array<{ data?: string; event?: string }>,
  options: { nextError?: Error } = {},
): {
  nextCount: () => number
  returnCount: () => number
  stream: ResponsesStream
  throwCount: () => number
} => {
  let index = 0
  let nextCount = 0
  let returnCount = 0
  let throwCount = 0
  return {
    nextCount: () => nextCount,
    returnCount: () => returnCount,
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCount += 1
          if (options.nextError) return Promise.reject(options.nextError)
          const value = chunks[index++]
          return Promise.resolve(
            value ?
              { done: false as const, value }
            : { done: true as const, value: undefined },
          )
        },
        return: () => {
          returnCount += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
        throw: (error?: unknown) => {
          throwCount += 1
          return Promise.resolve({ done: true as const, value: error })
        },
      }),
    },
    throwCount: () => throwCount,
  }
}
