import { expect, mock, test } from "bun:test"

import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import { emitResponsesStreamError } from "../src/routes/responses/stream-error"

test("Responses stream error treats caller cancellation as debug without writing", async () => {
  const controller = new AbortController()
  const abort = new Error("This operation was aborted")
  abort.name = "AbortError"
  controller.abort(abort)
  const writeSSE = mock(() => Promise.resolve())
  const warn = mock(() => {})

  await emitResponsesStreamError(
    { writeSSE } as never,
    { warn } as never,
    controller.signal.reason,
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
      signal: controller.signal,
    },
  )

  expect(warn).not.toHaveBeenCalled()
  expect(writeSSE).not.toHaveBeenCalled()
})

test("Responses stream error does not write after an aborted timeout race", async () => {
  const controller = new AbortController()
  const timeout = new UpstreamLifecycleTimeoutError("HTTP body", 5)
  controller.abort(timeout)
  const writeSSE = mock(() => Promise.resolve())

  await emitResponsesStreamError(
    { writeSSE } as never,
    { warn: mock(() => {}) } as never,
    timeout,
    { signal: controller.signal },
  )

  expect(writeSSE).not.toHaveBeenCalled()
})
