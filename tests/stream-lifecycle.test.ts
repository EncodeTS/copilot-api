import { expect, mock, test } from "bun:test"

import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import { HTTPError } from "../src/lib/error"
import {
  classifyStreamTermination,
  RetryableStreamTransportError,
  reportStreamTermination,
  StreamLifecycleError,
  streamLifecycleDependencies,
  superviseStream,
} from "../src/lib/stream-lifecycle"

test("stream lifecycle classifies caller cancellation as client_abort", () => {
  const controller = new AbortController()
  const abort = new Error("This operation was aborted")
  abort.name = "AbortError"
  controller.abort(abort)

  expect(
    classifyStreamTermination({
      error: controller.signal.reason,
      signal: controller.signal,
      terminalSeen: false,
    }),
  ).toBe("client_abort")
})

test("stream lifecycle does not infer client cancellation from AbortError alone", () => {
  const abort = new Error("upstream aborted")
  abort.name = "AbortError"

  expect(
    classifyStreamTermination({
      error: abort,
      terminalSeen: false,
    }),
  ).toBe("upstream_disconnect")
})

test("stream lifecycle reports caller cancellation as debug", () => {
  const controller = new AbortController()
  controller.abort(new Error("client disconnected"))
  const debug = mock(() => {})
  const error = mock(() => {})
  const warn = mock(() => {})

  const reported = reportStreamTermination(
    {
      diagnostics: {
        elapsedMs: 25,
        eventCount: 0,
        flow: "responses",
        lastEventType: null,
        retryCount: 0,
        terminalSeen: false,
        transport: "http",
      },
      error: controller.signal.reason,
      signal: controller.signal,
    },
    { debug, error, warn },
  )

  expect(reported.kind).toBe("client_abort")
  expect(debug).toHaveBeenCalledWith(
    "stream.lifecycle",
    expect.objectContaining({ kind: "client_abort" }),
  )
  expect(error).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

test("stream lifecycle gives timeout precedence over abort state", () => {
  const controller = new AbortController()
  const timeout = new UpstreamLifecycleTimeoutError("HTTP first byte", 120_000)
  controller.abort(timeout)

  expect(
    classifyStreamTermination({
      error: new Error("request aborted", { cause: timeout }),
      signal: controller.signal,
      terminalSeen: false,
    }),
  ).toBe("timeout")
})

test("stream lifecycle reports an upstream disconnect only once", () => {
  const debug = mock(() => {})
  const error = mock(() => {})
  const warn = mock(() => {})
  const logger = { debug, error, warn }
  const reset = new Error("connection reset")
  const input = {
    diagnostics: {
      elapsedMs: 73_000,
      eventCount: 1_703,
      flow: "responses" as const,
      lastEventType: "response.output_text.delta",
      retryCount: 0,
      terminalSeen: false,
      transport: "websocket" as const,
    },
    error: reset,
  }

  const first = reportStreamTermination(input, logger)
  const second = reportStreamTermination(input, logger)

  expect(first).toBe(second)
  expect(first.kind).toBe("upstream_disconnect")
  expect(error).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith("stream.lifecycle", {
    elapsedMs: 73_000,
    eventCount: 1_703,
    flow: "responses",
    kind: "upstream_disconnect",
    lastEventType: "response.output_text.delta",
    retryCount: 0,
    terminalSeen: false,
    transport: "websocket",
  })
  expect(debug).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

test("stream lifecycle reports timeout as warn", () => {
  const debug = mock(() => {})
  const error = mock(() => {})
  const warn = mock(() => {})
  const timeout = new UpstreamLifecycleTimeoutError("HTTP first byte", 120_000)

  const reported = reportStreamTermination(
    {
      diagnostics: {
        elapsedMs: 120_000,
        eventCount: 0,
        flow: "responses",
        lastEventType: null,
        retryCount: 0,
        terminalSeen: false,
        transport: "http",
      },
      error: timeout,
    },
    { debug, error, warn },
  )

  expect(reported.kind).toBe("timeout")
  expect(warn).toHaveBeenCalledWith(
    "stream.lifecycle",
    expect.objectContaining({ kind: "timeout" }),
  )
  expect(debug).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})

test("stream lifecycle does not log normal terminal completion", () => {
  const debug = mock(() => {})
  const error = mock(() => {})
  const warn = mock(() => {})

  const reported = reportStreamTermination(
    {
      diagnostics: {
        elapsedMs: 5_000,
        eventCount: 12,
        flow: "responses",
        lastEventType: "response.completed",
        retryCount: 0,
        terminalSeen: true,
        transport: "http",
      },
      error: new Error("ignored after terminal"),
    },
    { debug, error, warn },
  )

  expect(reported.kind).toBe("normal_terminal")
  expect(debug).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
})

test("stream lifecycle retries one HTTP attempt before the first event", async () => {
  let retryAttempts = 0
  const disconnectedWebSocket = () =>
    Promise.reject<AsyncIterable<{ type: string }>>(
      new RetryableStreamTransportError(
        "websocket ended before the first event",
      ),
    )
  async function* completedHttp() {
    await Promise.resolve()
    retryAttempts += 1
    yield { type: "response.completed" }
  }

  const events: Array<{ type: string }> = []
  for await (const event of superviseStream({
    flow: "responses",
    getEventType: (item) => item.type,
    isTerminalEvent: (item) => item.type === "response.completed",
    primary: {
      open: () => disconnectedWebSocket(),
      transport: "websocket",
    },
    retry: {
      open: () => completedHttp(),
      transport: "http",
    },
  })) {
    events.push(event)
  }

  expect(events).toEqual([{ type: "response.completed" }])
  expect(retryAttempts).toBe(1)
})

test("stream lifecycle does not retry after caller abort before the first event", async () => {
  const controller = new AbortController()
  controller.abort(new Error("client disconnected"))
  let retryAttempts = 0
  let caught: unknown
  async function* retryStream() {
    await Promise.resolve()
    retryAttempts += 1
    yield { type: "response.completed" }
  }

  try {
    for await (const _event of superviseStream({
      flow: "responses",
      getEventType: () => null,
      isTerminalEvent: () => false,
      primary: {
        open: () =>
          Promise.reject(new RetryableStreamTransportError("connection reset")),
        transport: "websocket",
      },
      retry: {
        open: () => retryStream(),
        transport: "http",
      },
      signal: controller.signal,
    })) {
      // No events are expected after caller cancellation.
    }
  } catch (error) {
    caught = error
  }

  expect(retryAttempts).toBe(0)
  expect(caught).toBeInstanceOf(StreamLifecycleError)
  expect((caught as StreamLifecycleError).kind).toBe("client_abort")
})

test("stream lifecycle never retries after yielding the first event", async () => {
  const originalReporter = streamLifecycleDependencies.reportTermination
  const loggedError = mock(() => {})
  const logger = {
    debug: mock(() => {}),
    error: loggedError,
    warn: mock(() => {}),
  }
  streamLifecycleDependencies.reportTermination = (input) =>
    reportStreamTermination(input, logger)
  let retryAttempts = 0
  async function* partialWebSocket() {
    await Promise.resolve()
    yield { type: "response.created" }
    throw new RetryableStreamTransportError("connection reset")
  }
  async function* completedHttp() {
    await Promise.resolve()
    retryAttempts += 1
    yield { type: "response.completed" }
  }

  const events: Array<{ type: string }> = []
  let failure: unknown
  try {
    for await (const event of superviseStream({
      flow: "responses",
      getEventType: (item) => item.type,
      isTerminalEvent: (item) => item.type === "response.completed",
      primary: {
        open: () => partialWebSocket(),
        transport: "websocket",
      },
      retry: {
        open: () => completedHttp(),
        transport: "http",
      },
    })) {
      events.push(event)
    }
  } catch (error) {
    failure = error
  } finally {
    streamLifecycleDependencies.reportTermination = originalReporter
  }

  expect(events).toEqual([{ type: "response.created" }])
  expect(retryAttempts).toBe(0)
  expect(failure).toBeInstanceOf(StreamLifecycleError)
  expect((failure as StreamLifecycleError).diagnostics).toMatchObject({
    eventCount: 1,
    lastEventType: "response.created",
    retryCount: 0,
    terminalSeen: false,
    transport: "websocket",
  })
  expect(loggedError).toHaveBeenCalledTimes(1)
})

test("stream lifecycle leaves semantic HTTP failures unclassified", async () => {
  const originalReporter = streamLifecycleDependencies.reportTermination
  const reportTermination = mock(originalReporter)
  streamLifecycleDependencies.reportTermination = reportTermination
  const semanticError = new HTTPError(
    "invalid request body",
    new Response("", { status: 400 }),
  )
  let caught: unknown

  try {
    for await (const _event of superviseStream({
      flow: "responses",
      getEventType: () => null,
      isTerminalEvent: () => false,
      primary: {
        open: () => Promise.reject(semanticError),
        transport: "http",
      },
    })) {
      // No events are expected from a semantic rejection.
    }
  } catch (error) {
    caught = error
  } finally {
    streamLifecycleDependencies.reportTermination = originalReporter
  }

  expect(caught).toBe(semanticError)
  expect(reportTermination).not.toHaveBeenCalled()
})
