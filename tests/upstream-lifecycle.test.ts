import { expect, mock, test } from "bun:test"

import { fetchWithUpstreamLifecycle } from "../src/lib/upstream-lifecycle"

test("upstream HTTP request stops when the caller aborts", async () => {
  let observedSignal: AbortSignal | undefined
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(toAbortError(observedSignal?.reason)),
        { once: true },
      )
    })
  })
  const controller = new AbortController()
  const request = fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      signal: controller.signal,
    },
  )

  controller.abort(new Error("client disconnected"))

  expect(observedSignal?.aborted).toBe(true)
  expect(await rejectionMessage(request)).toBe("client disconnected")
})

test("upstream HTTP request times out while waiting for response headers", async () => {
  let observedSignal: AbortSignal | undefined
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(toAbortError(observedSignal?.reason)),
        { once: true },
      )
    })
  })

  const request = fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      headersTimeoutMs: 5,
    },
  )

  expect(await rejectionMessage(request)).toBe(
    "Upstream HTTP headers timed out after 5ms",
  )
  expect(observedSignal?.aborted).toBe(true)
}, 100)

test("caller abort remains active while reading the response body", async () => {
  let observedSignal: AbortSignal | undefined
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        observedSignal?.addEventListener(
          "abort",
          () => controller.error(observedSignal?.reason),
          { once: true },
        )
      },
    })
    return Promise.resolve(new Response(body))
  })
  const controller = new AbortController()
  const response = await fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      signal: controller.signal,
    },
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Expected a response body reader")
  }

  const firstChunk = await reader.read()
  if (!(firstChunk.value instanceof Uint8Array)) {
    throw new Error("Expected a Uint8Array response chunk")
  }
  expect(new TextDecoder().decode(firstChunk.value)).toBe("partial")
  controller.abort(new Error("client disconnected after partial response"))

  expect(observedSignal?.aborted).toBe(true)
  expect(await rejectionMessage(reader.read())).toBe(
    "client disconnected after partial response",
  )
})

const toAbortError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error("request aborted")

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : "unknown error",
  )
