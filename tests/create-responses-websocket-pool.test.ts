import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { ResponsesResult } from "../src/services/copilot/create-responses"

type ListenerEvent = {
  data?: string
  error?: unknown
  message?: string
}

type Listener = (event: ListenerEvent) => void

type MockWebSocketInit = {
  headers?: Record<string, string>
  proxy?: string
}

const originalClearTimeout = globalThis.clearTimeout
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const proxyEnvKeys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "npm_config_http_proxy",
  "NPM_CONFIG_HTTP_PROXY",
  "npm_config_https_proxy",
  "NPM_CONFIG_HTTPS_PROXY",
  "npm_config_proxy",
  "NPM_CONFIG_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "npm_config_no_proxy",
  "NPM_CONFIG_NO_PROXY",
] as const

type ProxyEnvKey = (typeof proxyEnvKeys)[number]

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static autoComplete = true
  static closeAfterComplete = false
  static failOpen = false
  static failOpenEvent: ListenerEvent | null = null
  static neverOpen = false
  static instances: Array<MockWebSocket> = []

  readonly sent: Array<string> = []
  readonly init: MockWebSocketInit
  readonly url: string
  readyState = MockWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string, init: MockWebSocketInit) {
    this.init = init
    this.url = url
    MockWebSocket.instances.push(this)
    originalSetTimeout(() => {
      if (MockWebSocket.neverOpen) {
        return
      }
      if (MockWebSocket.failOpen) {
        this.readyState = MockWebSocket.CLOSED
        this.emit("error", MockWebSocket.failOpenEvent ?? {})
        return
      }

      this.readyState = MockWebSocket.OPEN
      this.emit("open", {})
    }, 0)
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeEventListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)

    if (MockWebSocket.autoComplete) {
      originalSetTimeout(() => {
        this.completeLatestResponse()
      }, 0)
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }

    this.readyState = MockWebSocket.CLOSED
    this.emit("close", {})
  }

  emitError(payload: ListenerEvent): void {
    this.emit("error", payload)
  }

  emitMessage(data: string): void {
    this.emit("message", { data })
  }

  completeLatestResponse(): void {
    const latestSent = this.sent.at(-1)
    if (!latestSent) {
      throw new Error("No websocket request to complete")
    }

    const parsed = JSON.parse(latestSent) as { model: string }
    this.emit("message", {
      data: JSON.stringify({
        response: createResponsesResult(
          parsed.model,
          `resp-${this.sent.length}`,
        ),
        sequence_number: 1,
        type: "response.completed",
      }),
    })

    if (MockWebSocket.closeAfterComplete) {
      originalSetTimeout(() => {
        this.close()
      }, 0)
    }
  }

  private emit(event: string, payload: ListenerEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }
}

class MockAgent {
  close(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): void {}
}

class MockProxyAgent extends MockAgent {
  readonly proxyUrl: string

  constructor(proxyUrl: string) {
    super()
    this.proxyUrl = proxyUrl
  }
}

const setGlobalDispatcherMock = mock((_dispatcher: unknown) => {})

await mock.module("undici", () => ({
  Agent: MockAgent,
  ProxyAgent: MockProxyAgent,
  setGlobalDispatcher: setGlobalDispatcherMock,
  WebSocket: MockWebSocket,
}))

const { state } = await import("../src/lib/state")
const { createResponses } = await import(
  "../src/services/copilot/create-responses"
)

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeVersion: state.vsCodeVersion,
}

const createResponsesResult = (
  model: string,
  id = "resp-test",
): ResponsesResult => ({
  created_at: 0,
  error: null,
  id,
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

beforeEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  MockWebSocket.instances = []
  state.accountType = "individual"
  state.copilotApiUrl = "https://api.githubcopilot.com"
  state.copilotToken = "test-token"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"
})

afterEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }

  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(
    globalThis as unknown as { clearTimeout: typeof clearTimeout }
  ).clearTimeout = originalClearTimeout
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  ;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout =
    originalSetTimeout
})

test("Responses websocket pool reuses the same connection for matching pool keys", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-1")

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(2)
})

test("Responses websocket open failure includes the underlying reason", async () => {
  MockWebSocket.failOpen = true
  MockWebSocket.failOpenEvent = {
    error: new Error("tls handshake failed"),
  }

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Failed to create responses websocket: tls handshake failed"',
  )
})

test("Responses websocket falls back to HTTP when opening fails before send", async () => {
  MockWebSocket.failOpen = true
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult("gpt-test", "resp-http-fallback"),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "open-fallback",
      transport: "websocket",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-fallback"')
})

test("Responses websocket times out while connecting", async () => {
  MockWebSocket.neverOpen = true

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "connect-timeout",
      timeouts: { websocketConnectMs: 5 },
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances.length === 1)
  const websocket = MockWebSocket.instances[0]
  const cleanupTimer = originalSetTimeout(() => {
    websocket?.emitError({
      error: new Error("forced test cleanup"),
    })
  }, 20)

  const chunks = await chunksPromise
  originalClearTimeout(cleanupTimer)

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Upstream WebSocket connect timed out after 5ms"',
  )
})

test("Responses websocket times out while waiting for the first frame", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(new Response("unexpected HTTP fallback")),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "first-frame-timeout",
      timeouts: {
        websocketFirstFrameMs: 5,
        websocketInactivityMs: 100,
        websocketTotalMs: 100,
      },
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  const websocket = MockWebSocket.instances[0]
  const cleanupTimer = originalSetTimeout(() => {
    websocket?.emitError({
      error: new Error("forced test cleanup"),
    })
  }, 20)

  const chunks = await chunksPromise
  originalClearTimeout(cleanupTimer)

  expect(chunks).toHaveLength(1)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Upstream WebSocket first frame timed out after 5ms"',
  )
})

test("Responses websocket times out after an inactivity gap", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "inactivity-timeout",
      timeouts: {
        websocketFirstFrameMs: 100,
        websocketInactivityMs: 5,
        websocketTotalMs: 100,
      },
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  const websocket = MockWebSocket.instances[0]
  await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))
  websocket?.emitMessage(
    JSON.stringify({
      response: createResponsesResult("gpt-test", "resp-partial"),
      sequence_number: 0,
      type: "response.created",
    }),
  )
  const cleanupTimer = originalSetTimeout(() => {
    websocket?.emitError({
      error: new Error("forced test cleanup"),
    })
  }, 20)

  const chunks = await chunksPromise
  originalClearTimeout(cleanupTimer)

  expect(chunks.at(-1)?.event).toBe("error")
  expect(chunks.at(-1)?.data).toContain(
    '"message":"Upstream WebSocket inactivity timed out after 5ms"',
  )
})

test("Responses websocket enforces a total request deadline", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "total-timeout",
      timeouts: {
        websocketFirstFrameMs: 100,
        websocketInactivityMs: 100,
        websocketTotalMs: 10,
      },
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  const websocket = MockWebSocket.instances[0]
  await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))
  const emitProgress = () => {
    if (websocket?.readyState !== MockWebSocket.OPEN) {
      return
    }
    websocket.emitMessage(
      JSON.stringify({
        response: createResponsesResult("gpt-test", "resp-progress"),
        sequence_number: 0,
        type: "response.in_progress",
      }),
    )
    originalSetTimeout(emitProgress, 2)
  }
  emitProgress()
  const cleanupTimer = originalSetTimeout(() => {
    websocket?.emitError({
      error: new Error("forced test cleanup"),
    })
  }, 30)

  const chunks = await chunksPromise
  originalClearTimeout(cleanupTimer)

  expect(chunks.at(-1)?.event).toBe("error")
  expect(chunks.at(-1)?.data).toContain(
    '"message":"Upstream WebSocket total timed out after 10ms"',
  )
})

test("Responses websocket closes after caller aborts a partial stream", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(new Response("unexpected HTTP fallback")),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  const controller = new AbortController()

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "caller-abort",
      signal: controller.signal,
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  const websocket = MockWebSocket.instances[0]
  await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))
  websocket?.emitMessage(
    JSON.stringify({
      response: createResponsesResult("gpt-test", "resp-partial"),
      sequence_number: 0,
      type: "response.created",
    }),
  )
  await waitFor(() => websocket?.readyState === MockWebSocket.OPEN)
  controller.abort(new Error("client disconnected after partial response"))

  const chunks = await chunksPromise

  expect(fetchMock).not.toHaveBeenCalled()
  expect(websocket?.readyState).toBe(MockWebSocket.CLOSED)
  expect(chunks.at(-1)?.event).toBe("error")
  expect(chunks.at(-1)?.data).toContain(
    '"message":"client disconnected after partial response"',
  )
})

test("Responses websocket pool separates different request IDs", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-2")

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket does not open until the stream is consumed", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const iterator = (response as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const firstChunk = iterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await iterator.next()
})

test("Responses websocket closes a pooled connection when the consumer returns before terminal", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const iterator = (response as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const firstChunk = iterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      response: createResponsesResult("gpt-test", "resp-partial"),
      sequence_number: 0,
      type: "response.created",
    }),
  )
  await firstChunk
  await iterator.return?.()

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  MockWebSocket.autoComplete = true
  await collectResponsesStream("request-1")
  expect(MockWebSocket.instances).toHaveLength(2)
})

test("Responses websocket delayed concurrent streams still use dedicated connections", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const secondResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )

  expect(MockWebSocket.instances).toHaveLength(0)

  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const secondIterator = (secondResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondChunk = secondIterator.next()

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondChunk
  await secondIterator.next()

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket concurrent request bypasses the pool without closing the previous websocket", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket multiple concurrent requests each use a dedicated connection", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")
  const thirdPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 3
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[2]?.sent).toHaveLength(1)

  MockWebSocket.instances[2]?.completeLatestResponse()
  await thirdPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()
})

test("Responses websocket sequential request reuses the pooled connection after concurrent work completes", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const firstIterator = (firstResponse as AsyncIterable<unknown>)[
    Symbol.asyncIterator
  ]()
  const firstChunk = firstIterator.next()

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const secondPromise = collectResponsesStream("request-1")

  await waitFor(
    () =>
      MockWebSocket.instances.length === 2
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondPromise

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await firstIterator.next()

  const thirdPromise = collectResponsesStream("request-1")
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await thirdPromise
})

test("Responses websocket stream failure includes the underlying reason", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.emitError({
    error: new Error("socket hang up"),
  })

  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Responses websocket stream error: socket hang up"',
  )
})

test("Responses websocket emits an error event when the websocket closes without a terminal response", async () => {
  MockWebSocket.autoComplete = false

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.instances[0]?.close()

  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Responses websocket ended without a terminal response"',
  )
})

test("Responses websocket passes HTTPS proxy env to Bun websocket init", async () => {
  const proxyEnv = clearProxyEnv()
  process.env.HTTPS_PROXY = "http://127.0.0.1:8080"

  try {
    await collectResponsesStream("proxy-request")

    expect(MockWebSocket.instances[0]?.init.proxy).toBe("http://127.0.0.1:8080")
  } finally {
    restoreProxyEnv(proxyEnv)
  }
})

test("Responses websocket honors NO_PROXY when resolving Bun websocket proxy", async () => {
  const proxyEnv = clearProxyEnv()
  process.env.HTTPS_PROXY = "http://127.0.0.1:8080"
  process.env.NO_PROXY = "api.githubcopilot.com"

  try {
    await collectResponsesStream("no-proxy-request")

    expect(MockWebSocket.instances[0]?.init.proxy).toBeUndefined()
  } finally {
    restoreProxyEnv(proxyEnv)
  }
})

const collectResponsesStream = async (requestId: string): Promise<void> => {
  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId,
      transport: "websocket",
      vision: false,
    },
  )

  for await (const _chunk of response as AsyncIterable<unknown>) {
    // consume stream
  }
}

const collectStreamChunks = async (
  stream: AsyncIterable<unknown>,
): Promise<Array<{ data?: string; event?: string; id?: string | number }>> => {
  const chunks: Array<{ data?: string; event?: string; id?: string | number }> =
    []

  for await (const chunk of stream as AsyncIterable<{
    data?: string
    event?: string
    id?: string | number
  }>) {
    chunks.push(chunk)
  }

  return chunks
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise<void>((resolve) => {
      originalSetTimeout(resolve, 0)
    })
  }

  throw new Error("Timed out waiting for condition")
}

const clearProxyEnv = (): Map<ProxyEnvKey, string | undefined> => {
  const originalValues = new Map<ProxyEnvKey, string | undefined>()

  for (const key of proxyEnvKeys) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }

  return originalValues
}

const restoreProxyEnv = (
  originalValues: Map<ProxyEnvKey, string | undefined>,
): void => {
  for (const key of proxyEnvKeys) {
    const value = originalValues.get(key)
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}
