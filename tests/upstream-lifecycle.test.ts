import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import {
  fetchWithUpstreamLifecycle,
  upstreamLifecycleDependencies,
} from "../src/lib/upstream-lifecycle"

const originalUnrefTimer = upstreamLifecycleDependencies.unrefTimer

beforeEach(() => {
  upstreamLifecycleDependencies.unrefTimer = () => {}
})

afterEach(() => {
  upstreamLifecycleDependencies.unrefTimer = originalUnrefTimer
})

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

test("upstream HTTP lifecycle accepts an explicitly null RequestInit signal", async () => {
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return Promise.resolve(new Response("ok"))
  })

  const response = await fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    { signal: null },
    { fetcher },
  )

  expect(await response.text()).toBe("ok")
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

test("upstream HTTP body times out while waiting for the first byte", async () => {
  let observedSignal: AbortSignal | undefined
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        observedSignal?.addEventListener(
          "abort",
          () => controller.error(observedSignal?.reason),
          { once: true },
        )
      },
    })
    return Promise.resolve(new Response(body))
  })
  const response = await fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      timeouts: {
        httpFirstByteMs: 5,
        httpInactivityMs: 100,
        httpTotalMs: 100,
      },
    },
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Expected a response body reader")
  }

  expect(await rejectionMessage(reader.read())).toBe(
    "Upstream HTTP first byte timed out after 5ms",
  )
  expect(observedSignal?.aborted).toBe(true)
}, 100)

test("upstream HTTP body times out after an inactivity gap", async () => {
  const fetcher = mock((_: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(init.signal?.reason),
          { once: true },
        )
      },
    })
    return Promise.resolve(new Response(body))
  })
  const response = await fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      timeouts: {
        httpFirstByteMs: 100,
        httpInactivityMs: 5,
        httpTotalMs: 100,
      },
    },
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Expected a response body reader")
  }

  await reader.read()
  expect(await rejectionMessage(reader.read())).toBe(
    "Upstream HTTP inactivity timed out after 5ms",
  )
}, 100)

test("upstream HTTP body enforces a total deadline", async () => {
  let cancelled = false
  const fetcher = mock(() => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 2))
        if (!cancelled) {
          controller.enqueue(new TextEncoder().encode("progress"))
        }
      },
      cancel() {
        cancelled = true
      },
    })
    return Promise.resolve(new Response(body))
  })
  const response = await fetchWithUpstreamLifecycle(
    "https://example.test/responses",
    {},
    {
      fetcher,
      timeouts: {
        httpFirstByteMs: 100,
        httpInactivityMs: 100,
        httpTotalMs: 8,
      },
    },
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("Expected a response body reader")
  }

  const consume = async () => {
    while (!(await reader.read()).done) {
      // Keep consuming progress until the total deadline wins.
    }
  }
  expect(await rejectionMessage(consume())).toBe(
    "Upstream HTTP total timed out after 8ms",
  )
  expect(cancelled).toBe(true)
}, 100)

const toAbortError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error("request aborted")

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : "unknown error",
  )
