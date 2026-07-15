import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"

import type {
  ResponseInputItem,
  ResponsesResult,
} from "../src/services/copilot/create-responses"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"

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
const originalConsolaDebug = consola.debug
const originalConsolaWarn = consola.warn
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
const { createResponses: createResponsesImpl } = await import(
  "../src/services/copilot/create-responses"
)
const createResponses: typeof createResponsesImpl = (payload, options) =>
  createResponsesImpl(payload, {
    ...options,
    fetcher: globalThis.fetch,
  })
const { responsesReasoningRecoveryRegistry } = await import(
  "../src/services/copilot/responses-reasoning-recovery-registry"
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

const parseRequestBody = (
  init?: RequestInit,
): Record<string, unknown> & { input: Array<Record<string, unknown>> } => {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON request body")
  }
  return JSON.parse(init.body) as {
    [key: string]: unknown
    input: Array<Record<string, unknown>>
  }
}

const userHistoryInput = (): ResponseInputItem => ({
  content: [{ text: "continue", type: "input_text" }],
  role: "user",
  type: "message",
})

const reasoningHistoryInput = (): Array<ResponseInputItem> => [
  {
    encrypted_content: "old-reasoning",
    type: "reasoning",
  },
  userHistoryInput(),
]

const connectionOwnershipErrorResponse = (): Response =>
  Response.json(
    {
      error: {
        code: "",
        message: "input item does not belong to this connection",
      },
    },
    { status: 400 },
  )

const createHttpTestResponse = (
  input: Array<ResponseInputItem>,
  requestId: string,
) =>
  createResponses(
    { input, model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId,
      transport: "http",
      vision: false,
    },
  )

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

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
  responsesReasoningRecoveryRegistry.clear()
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
  responsesReasoningRecoveryRegistry.clear()
  consola.debug = originalConsolaDebug
  consola.warn = originalConsolaWarn
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

test("Responses websocket falls back to HTTP when it closes before the first event", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-zero-event-fallback",
            ),
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
      requestId: "zero-event-fallback",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.close()
  const chunks = await chunksPromise

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-zero-event-fallback"')
})

test("Responses websocket recovers incompatible reasoning history over HTTP", async () => {
  MockWebSocket.autoComplete = false
  const warnMock = Object.assign(
    mock(() => {}),
    { raw: mock(() => {}) },
  )
  consola.warn = warnMock
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    const body = parseRequestBody(init)
    expect(body).toMatchObject({
      context_management: [{ compact_threshold: 100_000, type: "compaction" }],
      instructions: "Keep prior instructions",
      metadata: { session: "recovery-test" },
      prompt_cache_key: "recovery-cache",
      tools: [
        {
          description: "Read one file",
          name: "read_file",
          parameters: { properties: {}, type: "object" },
          strict: true,
          type: "function",
        },
      ],
    })
    expect(body.input).toEqual([
      {
        content: [{ text: "previous answer", type: "output_text" }],
        id: "message-1",
        role: "assistant",
        type: "message",
      },
      {
        arguments: '{"path":"README.md"}',
        call_id: "call-1",
        name: "read_file",
        type: "function_call",
      },
      {
        call_id: "call-1",
        output: "contents",
        type: "function_call_output",
      },
      {
        content: [
          { text: "continue", type: "input_text" },
          {
            detail: "low",
            image_url: "data:image/png;base64,AA==",
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ])

    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-reasoning-recovery",
            ),
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
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      context_management: [{ compact_threshold: 100_000, type: "compaction" }],
      input: [
        {
          encrypted_content: "old-reasoning-1",
          id: "reasoning-1",
          type: "reasoning",
        },
        {
          encrypted_content: "old-reasoning-2",
          id: "reasoning-2",
          type: "reasoning",
        },
        {
          content: [{ text: "previous answer", type: "output_text" }],
          id: "message-1",
          role: "assistant",
          type: "message",
        },
        {
          arguments: '{"path":"README.md"}',
          call_id: "call-1",
          name: "read_file",
          type: "function_call",
        },
        {
          call_id: "call-1",
          output: "contents",
          type: "function_call_output",
        },
        {
          content: [
            { text: "continue", type: "input_text" },
            {
              detail: "low",
              image_url: "data:image/png;base64,AA==",
              type: "input_image",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
      instructions: "Keep prior instructions",
      metadata: { session: "recovery-test" },
      model: "gpt-test",
      prompt_cache_key: "recovery-cache",
      stream: true,
      tools: [
        {
          description: "Read one file",
          name: "read_file",
          parameters: { properties: {}, type: "object" },
          strict: true,
          type: "function",
        },
      ],
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "reasoning-recovery",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "bad_request",
        message: "input item does not belong to this connection",
      },
      type: "error",
    }),
  )

  const chunks = await chunksPromise

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(warnMock).toHaveBeenCalledWith(
    "responses.reasoning_history_recovery",
    {
      reason: "incompatible_reasoning_history",
      removedReasoningItems: 2,
      retryTransport: "http",
      sourceTransport: "websocket",
    },
  )
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-reasoning-recovery"')
})

test("Responses websocket recovery retries an HTTP body reset with the recovery payload", async () => {
  MockWebSocket.autoComplete = false
  let attempt = 0
  const reasoningByRequest: Array<Array<string>> = []
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    attempt += 1
    reasoningByRequest.push(
      parseRequestBody(init).input.flatMap((item) =>
        item.type === "reasoning" ? [String(item.encrypted_content)] : [],
      ),
    )
    if (attempt === 1) {
      const socketError = Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      })
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(
                new TypeError("terminated", { cause: socketError }),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-recovery-body-reset",
            ),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: reasoningHistoryInput(),
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "reasoning-recovery-body-reset",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "bad_request",
        message: "input item does not belong to this connection",
      },
      type: "error",
    }),
  )

  const chunks = await chunksPromise

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(reasoningByRequest).toEqual([[], []])
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-recovery-body-reset"')
})

test("Responses HTTP retries once when the stream ends before the first event", async () => {
  let attempt = 0
  const fetchMock = mock(() => {
    attempt += 1
    if (attempt === 1) {
      return Promise.resolve(
        new Response("", {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult("gpt-test", "resp-http-retry"),
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
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "http-zero-event-retry",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-retry"')
})

test("Responses HTTP retries once when the connection resets before the first event", async () => {
  let attempt = 0
  const fetchMock = mock(() => {
    attempt += 1
    if (attempt === 1) {
      const socketError = Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("terminated", { cause: socketError }))
        },
      })
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-reset-retry",
            ),
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
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "http-reset-retry",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-reset-retry"')
})

test("Responses HTTP retries once when the connection resets before headers", async () => {
  let attempt = 0
  const fetchMock = mock(() => {
    attempt += 1
    if (attempt === 1) {
      const socketError = Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      })
      return Promise.reject(
        new TypeError("fetch failed", { cause: socketError }),
      )
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-headers-retry",
            ),
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
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "http-headers-retry",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-headers-retry"')
})

test("Responses HTTP emits a protocol error after two pre-header resets", async () => {
  const fetchMock = mock(() => {
    const socketError = Object.assign(new Error("socket closed"), {
      code: "UND_ERR_SOCKET",
    })
    return Promise.reject(new TypeError("fetch failed", { cause: socketError }))
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId: "http-final-headers-reset",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain("fetch failed")
})

test("Responses HTTP shares one retry budget across headers and body", async () => {
  let attempt = 0
  const fetchMock = mock(() => {
    attempt += 1
    if (attempt === 1) {
      const socketError = Object.assign(new Error("socket closed"), {
        code: "UND_ERR_SOCKET",
      })
      return Promise.reject(
        new TypeError("fetch failed", { cause: socketError }),
      )
    }
    return Promise.resolve(
      new Response("", {
        headers: { "content-type": "text/event-stream" },
      }),
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "http-shared-retry-budget",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"http stream ended without a terminal event"',
  )
})

test("Responses HTTP does not retry after forwarding the first event", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        [
          "event: response.created",
          `data: ${JSON.stringify({
            response: createResponsesResult("gpt-test", "resp-http-partial"),
            sequence_number: 1,
            type: "response.created",
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
      initiator: "user",
      requestId: "http-partial-no-retry",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(2)
  expect(chunks[0]?.event).toBe("response.created")
  expect(chunks[1]?.event).toBe("error")
  expect(chunks[1]?.data).toContain(
    '"message":"http stream ended without a terminal event"',
  )
})

test("Responses HTTP recovers incompatible reasoning history once", async () => {
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    if (fetchMock.mock.calls.length === 1) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: "",
              message: "input item does not belong to this connection",
            },
          },
          { status: 400 },
        ),
      )
    }

    const body = parseRequestBody(init)
    expect(body.input).toEqual([
      {
        content: [{ text: "continue", type: "input_text" }],
        role: "user",
        type: "message",
      },
    ])
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-reasoning-recovery",
            ),
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
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: [
        {
          encrypted_content: "old-reasoning",
          id: "reasoning-1",
          type: "reasoning",
        },
        {
          content: [{ text: "continue", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      requestId: "http-reasoning-recovery",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain('"id":"resp-http-reasoning-recovery"')
})

test("Responses remembers rejected reasoning and preserves new reasoning next turn", async () => {
  const debugMock = Object.assign(
    mock(() => {}),
    { raw: mock(() => {}) },
  )
  const warnMock = Object.assign(
    mock(() => {}),
    { raw: mock(() => {}) },
  )
  consola.debug = debugMock
  consola.warn = warnMock
  const reasoningByRequest: Array<Array<string>> = []
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    const body = parseRequestBody(init)
    const reasoning = body.input
      .filter((item) => item.type === "reasoning")
      .map((item) => String(item.encrypted_content))
    reasoningByRequest.push(reasoning)

    if (reasoning.some((value) => value.startsWith("old-reasoning"))) {
      return Promise.resolve(connectionOwnershipErrorResponse())
    }

    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              `resp-turn-${reasoningByRequest.length}`,
            ),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const oldReasoning = [
    {
      encrypted_content: "old-reasoning-1",
      type: "reasoning" as const,
    },
    {
      encrypted_content: "old-reasoning-2",
      type: "reasoning" as const,
    },
  ]
  const options = {
    initiator: "user" as const,
    reasoningRecoverySessionId: "reasoning-cache-session",
    requestId: "reasoning-cache-turn-1",
    transport: "http" as const,
    vision: false,
  }

  const first = await createResponses(
    {
      input: [...oldReasoning, userHistoryInput()],
      model: "gpt-test",
      stream: true,
    },
    options,
  )
  await collectStreamChunks(first as AsyncIterable<unknown>)

  const second = await createResponses(
    {
      input: [
        ...oldReasoning,
        {
          encrypted_content: "new-reasoning",
          type: "reasoning",
        },
        userHistoryInput(),
      ],
      model: "gpt-test",
      stream: true,
    },
    { ...options, requestId: "reasoning-cache-turn-2" },
  )
  await collectStreamChunks(second as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(reasoningByRequest).toEqual([
    ["old-reasoning-1", "old-reasoning-2"],
    [],
    ["new-reasoning"],
  ])
  expect(debugMock).toHaveBeenCalledWith(
    "responses.reasoning_history_prefilter",
    {
      model: "gpt-test",
      reason: "known_incompatible_reasoning_history",
      removedReasoningItems: 2,
      subagent: false,
    },
  )
  expect(warnMock).toHaveBeenCalledWith(
    "responses.reasoning_history_recovery",
    {
      reason: "incompatible_reasoning_history",
      removedReasoningItems: 2,
      retryTransport: "http",
      sourceTransport: "http",
    },
  )
})

test("Responses reasoning memory is isolated by session, model, and subagent", async () => {
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    const body = parseRequestBody(init)
    const hasRejectedReasoning = body.input.some(
      (item) => item.encrypted_content === "old-reasoning",
    )
    if (hasRejectedReasoning) {
      return Promise.resolve(connectionOwnershipErrorResponse())
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(String(body.model)),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const requestCounts: Array<number> = []
  const run = async ({
    agentId,
    model = "gpt-test",
    requestId,
    sessionId,
  }: {
    agentId?: string
    model?: string
    requestId: string
    sessionId: string
  }) => {
    const before = fetchMock.mock.calls.length
    const response = await createResponses(
      {
        input: [
          {
            encrypted_content: "old-reasoning",
            type: "reasoning",
          },
          userHistoryInput(),
        ],
        model,
        stream: true,
      },
      {
        initiator: "user",
        reasoningRecoverySessionId: sessionId,
        requestId,
        subagentMarker:
          agentId ?
            {
              agent_id: agentId,
              agent_type: "review",
              session_id: sessionId,
            }
          : null,
        transport: "http",
        vision: false,
      },
    )
    await collectStreamChunks(response as AsyncIterable<unknown>)
    requestCounts.push(fetchMock.mock.calls.length - before)
  }

  await run({ requestId: "base-learn", sessionId: "session-a" })
  await run({ requestId: "base-reuse", sessionId: "session-a" })
  await run({ requestId: "other-session", sessionId: "session-b" })
  await run({
    model: "gpt-other",
    requestId: "other-model",
    sessionId: "session-a",
  })
  await run({
    agentId: "agent-a",
    requestId: "other-subagent",
    sessionId: "session-a",
  })

  expect(requestCounts).toEqual([2, 1, 2, 2, 2])
})

test("Responses without a stable session repeats stateless recovery", async () => {
  const reasoningByRequest: Array<Array<string>> = []
  const fetchMock = mock((_input: unknown, init?: RequestInit) => {
    const body = parseRequestBody(init)
    const reasoning = body.input
      .filter((item) => item.type === "reasoning")
      .map((item) => String(item.encrypted_content))
    reasoningByRequest.push(reasoning)
    if (reasoning.some((value) => value === "old-reasoning")) {
      return Promise.resolve(connectionOwnershipErrorResponse())
    }
    return Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult("gpt-test"),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  for (const requestId of ["stateless-turn-1", "stateless-turn-2"]) {
    const response = await createResponses(
      {
        input: [
          {
            encrypted_content: "old-reasoning",
            type: "reasoning",
          },
          userHistoryInput(),
        ],
        model: "gpt-test",
        stream: true,
      },
      {
        initiator: "user",
        requestId,
        transport: "http",
        vision: false,
      },
    )
    await collectStreamChunks(response as AsyncIterable<unknown>)
  }

  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect(reasoningByRequest).toEqual([
    ["old-reasoning"],
    [],
    ["old-reasoning"],
    [],
  ])
})

test("Responses HTTP reasoning recovery runs at most once", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(connectionOwnershipErrorResponse()),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const caught = await captureError(() =>
    createHttpTestResponse(
      reasoningHistoryInput(),
      "http-reasoning-recovery-fails",
    ),
  )

  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe(
    "Failed to create responses: input item does not belong to this connection",
  )
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("Responses HTTP does not recover without reasoning history", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(connectionOwnershipErrorResponse()),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const caught = await captureError(() =>
    createHttpTestResponse(
      [userHistoryInput()],
      "http-recovery-without-reasoning",
    ),
  )

  expect(caught).toBeInstanceOf(Error)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Responses HTTP does not recover unrelated validation errors", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message: "invalid request body",
          },
        },
        { status: 400 },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const caught = await captureError(() =>
    createHttpTestResponse(
      reasoningHistoryInput(),
      "http-recovery-unrelated-error",
    ),
  )

  expect(caught).toBeInstanceOf(Error)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Responses HTTP does not recover a not-found response", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(
      Response.json(
        { error: { code: "not_found", message: "" } },
        { status: 404 },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const caught = await captureError(() =>
    createHttpTestResponse(reasoningHistoryInput(), "http-recovery-not-found"),
  )

  expect(caught).toBeInstanceOf(Error)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Responses HTTP preserves aborts while reading an error body", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            const error = new Error("request aborted")
            error.name = "AbortError"
            controller.error(error)
          },
        }),
        { status: 400 },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  let caught: unknown
  try {
    await createHttpTestResponse(
      reasoningHistoryInput(),
      "http-recovery-aborted-error-body",
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).name).toBe("AbortError")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Responses HTTP preserves timeouts while reading an error body", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new UpstreamLifecycleTimeoutError("HTTP body", 5))
          },
        }),
        { status: 400 },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  let caught: unknown
  try {
    await createHttpTestResponse(
      reasoningHistoryInput(),
      "http-recovery-timeout-error-body",
    )
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(UpstreamLifecycleTimeoutError)
  expect((caught as Error).message).toContain("HTTP body timed out")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("Responses websocket does not recover after forwarding a frame", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() => Promise.reject(new Error("unexpected fetch")))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: [
        {
          encrypted_content: "old-reasoning",
          type: "reasoning",
        },
        {
          content: [{ text: "continue", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "reasoning-recovery-after-frame",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      content_index: 0,
      delta: "partial output",
      item_id: "message-1",
      output_index: 0,
      sequence_number: 0,
      type: "response.output_text.delta",
    }),
  )
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "bad_request",
        message: "input item does not belong to this connection",
      },
      type: "error",
    }),
  )

  const chunks = await chunksPromise

  expect(fetchMock).not.toHaveBeenCalled()
  expect(chunks.map((chunk) => chunk.event)).toEqual([
    "response.output_text.delta",
    "error",
  ])
})

test("Responses websocket recovery preserves an HTTP rejection message", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            code: "invalid_request_body",
            message: "sanitized reasoning retry rejected",
          },
        },
        { status: 400 },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const response = await createResponses(
    {
      input: [
        {
          encrypted_content: "old-reasoning",
          type: "reasoning",
        },
        {
          content: [{ text: "continue", type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "reasoning-recovery-http-rejection",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)

  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "bad_request",
        message: "input item does not belong to this connection",
      },
      type: "error",
    }),
  )

  const chunks = await chunksPromise

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain("sanitized reasoning retry rejected")
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
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.created")
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
