import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import consola from "consola"

import type {
  ResponseInputItem,
  ResponsesResult,
} from "../src/services/copilot/create-responses"
import { streamLifecycleDependencies } from "../src/lib/stream-lifecycle"
import { UpstreamLifecycleTimeoutError } from "../src/lib/upstream-lifecycle"
import {
  DEFAULT_RESPONSES_WEBSOCKET_RESOURCE_LIMITS,
  type ResponsesWebSocketResourceLimits,
} from "../src/lib/responses-websocket-limits"
import {
  admitResponsesWirePayload,
  prepareResponsesWirePayload,
} from "../src/services/copilot/responses-wire-artifact"

type ListenerEvent = {
  code?: number
  data?: unknown
  error?: unknown
  message?: string
  reason?: string
  wasClean?: boolean
}

type Listener = (event: ListenerEvent) => void

type MockWebSocketInit = {
  headers?: Record<string, string>
  proxy?: string
}

const originalClearTimeout = globalThis.clearTimeout
const originalConsolaDebug = consola.debug
const originalConsolaWarn = consola.warn
const originalDateNow = Date.now
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalStreamLifecycleReporter =
  streamLifecycleDependencies.reportTermination
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
  static deferClose = false
  static failOpen = false
  static failOpenEvent: ListenerEvent | null = null
  static neverOpen = false
  static instances: Array<MockWebSocket> = []

  readonly sent: Array<string> = []
  readonly init: MockWebSocketInit
  readonly url: string
  readyState = MockWebSocket.CONNECTING

  private readonly listeners = new Map<string, Set<Listener>>()
  private pendingCloseEvent: ListenerEvent | null = null

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

  close(code = 1000, reason = "", wasClean = true): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }

    if (MockWebSocket.deferClose) {
      this.readyState = MockWebSocket.CLOSING
      this.pendingCloseEvent = { code, reason, wasClean }
      return
    }

    this.readyState = MockWebSocket.CLOSED
    this.emit("close", { code, reason, wasClean })
  }

  finishClose(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.emit(
      "close",
      this.pendingCloseEvent ?? { code: 1000, reason: "", wasClean: true },
    )
    this.pendingCloseEvent = null
  }

  emitError(payload: ListenerEvent): void {
    this.emit("error", payload)
  }

  emitMessage(data: unknown): void {
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
const copilotResponsesModule = await import(
  "../src/services/copilot/create-responses"
)
const { createResponses: createResponsesImpl } = copilotResponsesModule
const createResponses: typeof createResponsesImpl = (payload, options) =>
  createResponsesImpl(payload, {
    ...options,
    fetcher: globalThis.fetch,
  })
const { responsesReasoningRecoveryRegistry } = await import(
  "../src/services/copilot/responses-reasoning-recovery-registry"
)
const responsesTransportHealthModule = await import(
  "../src/services/copilot/responses-transport-health"
)
const originalTransportHealthNow =
  responsesTransportHealthModule.responsesWebSocketTransportHealthDependencies
    .now
const responsesWebSocketModule = await import(
  "../src/services/responses-websocket"
)

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  githubToken: state.githubToken,
  userName: state.userName,
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
  responsesWebSocketModule.clearPooledWebSocketConnections?.("network_change")
  responsesTransportHealthModule.resetResponsesWebSocketTransportHealth()
  responsesTransportHealthModule.responsesWebSocketTransportHealthDependencies.now =
    originalTransportHealthNow
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.deferClose = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  MockWebSocket.instances = []
  state.accountType = "individual"
  state.copilotApiUrl = "https://api.githubcopilot.com"
  state.copilotToken = "test-token"
  state.githubToken = "stable-github-token"
  state.userName = "test-user"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeVersion = "1.120.0"
  responsesReasoningRecoveryRegistry.clear()
  Date.now = originalDateNow
})

afterEach(() => {
  MockWebSocket.autoComplete = true
  MockWebSocket.closeAfterComplete = false
  MockWebSocket.deferClose = false
  MockWebSocket.failOpen = false
  MockWebSocket.failOpenEvent = null
  MockWebSocket.neverOpen = false
  for (const websocket of MockWebSocket.instances) {
    websocket.close()
  }
  responsesWebSocketModule.clearPooledWebSocketConnections?.("network_change")
  responsesTransportHealthModule.resetResponsesWebSocketTransportHealth()
  responsesTransportHealthModule.responsesWebSocketTransportHealthDependencies.now =
    originalTransportHealthNow

  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotToken = originalState.copilotToken
  state.githubToken = originalState.githubToken
  state.userName = originalState.userName
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeVersion = originalState.vsCodeVersion
  responsesReasoningRecoveryRegistry.clear()
  Date.now = originalDateNow
  consola.debug = originalConsolaDebug
  consola.warn = originalConsolaWarn
  streamLifecycleDependencies.reportTermination =
    originalStreamLifecycleReporter
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

test("Responses websocket admits the effective subagent initiator", async () => {
  const response = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId: "subagent-effective-initiator",
      subagentMarker: {
        agent_id: "synthetic-agent",
        agent_type: "review",
        session_id: "synthetic-session",
      },
      transport: "websocket",
      vision: false,
    },
  )
  await collectStreamChunks(response as AsyncIterable<unknown>)

  const frame = JSON.parse(MockWebSocket.instances[0]?.sent[0] ?? "{}") as {
    initiator?: string
  }
  expect(frame.initiator).toBe("agent")
})

test("pooled websocket rejects global capacity before sending", async () => {
  MockWebSocket.autoComplete = false
  const limits = createResourceLimits({
    capacityWaitMs: 0,
    globalConnectionLimit: 1,
    perCapacityKeyConnectionLimit: 1,
  })
  const first = createDirectWebSocketStream("pool-1", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const firstChunk = first.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const second = createDirectWebSocketStream("pool-2", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const error = await captureError(() => second.next())

  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketCapacityError,
  )
  expect(
    (
      error as InstanceType<
        typeof responsesWebSocketModule.PooledWebSocketCapacityError
      >
    ).sendState,
  ).toBe("not-sent")
  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(
    responsesTransportHealthModule.getResponsesWebSocketTransportHealthDiagnostics()
      .active,
  ).toBe(false)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await first.next()
})

test("pooled websocket classifies serialization failure before acquisition", async () => {
  const circularPayload: Record<string, unknown> = { model: "gpt-test" }
  circularPayload.self = circularPayload
  const stream = responsesWebSocketModule.createPooledWebSocketStream(
    {
      headers: {},
      identity: responsesWebSocketModule.createPooledWebSocketIdentity({
        accountFingerprint: "serialization-account",
        origin: "https://api.githubcopilot.com",
        poolScope: ["serialization-scope"],
        provider: "test",
      }),
      payload: circularPayload,
      resourceLimits: createResourceLimits(),
      url: "wss://api.githubcopilot.com/responses",
    },
    {
      createChunk: (data) => data,
      isTerminalChunk: () => false,
      openErrorMessage: "test websocket open error",
      streamErrorMessage: "test websocket stream error",
      terminalChunkMissingMessage: "test websocket terminal missing",
    },
  )

  const error = await captureError(async () => {
    for await (const _chunk of stream) {
      // consume stream
    }
  })

  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketRequestError,
  )
  expect(
    (
      error as InstanceType<
        typeof responsesWebSocketModule.PooledWebSocketRequestError
      >
    ).sendState,
  ).toBe("not-sent")
  expect(MockWebSocket.instances).toHaveLength(0)
})

test("pooled websocket rejects competing structured and serialized wire sources", async () => {
  const request = {
    frame: '{"model":"admitted"}',
    headers: {},
    identity: responsesWebSocketModule.createPooledWebSocketIdentity({
      accountFingerprint: "dual-source-account",
      origin: "https://api.githubcopilot.com",
      poolScope: ["dual-source-scope"],
      provider: "test",
    }),
    payload: { model: "different" },
    resourceLimits: createResourceLimits(),
    url: "wss://api.githubcopilot.com/responses",
  } as unknown as Parameters<
    typeof responsesWebSocketModule.createPooledWebSocketStream<
      Record<string, unknown>,
      string
    >
  >[0]
  const stream = responsesWebSocketModule.createPooledWebSocketStream(request, {
    createChunk: (data) => data,
    isTerminalChunk: () => false,
    openErrorMessage: "test websocket open error",
    streamErrorMessage: "test websocket stream error",
    terminalChunkMissingMessage: "test websocket terminal missing",
  })

  const error = await captureError(async () => {
    for await (const _chunk of stream) {
      // consume stream
    }
  })
  expect(error).toMatchObject({
    message: "Responses websocket request must contain exactly one wire source",
    sendState: "not-sent",
  })
  expect(MockWebSocket.instances).toHaveLength(0)
})

test("pooled websocket enforces capacity independently per account key", async () => {
  MockWebSocket.autoComplete = false
  const limits = createResourceLimits({
    capacityWaitMs: 0,
    globalConnectionLimit: 3,
    perCapacityKeyConnectionLimit: 1,
  })
  const accountOne = createDirectWebSocketStream(
    "account-1-pool",
    "account-1",
    limits,
  )[Symbol.asyncIterator]()
  const accountTwo = createDirectWebSocketStream(
    "account-2-pool",
    "account-2",
    limits,
  )[Symbol.asyncIterator]()
  const accountOneChunk = accountOne.next()
  const accountTwoChunk = accountTwo.next()
  await waitFor(
    () =>
      MockWebSocket.instances[0]?.sent.length === 1
      && MockWebSocket.instances[1]?.sent.length === 1,
  )

  const rejected = createDirectWebSocketStream(
    "account-1-other-pool",
    "account-1",
    limits,
  )[Symbol.asyncIterator]()
  const error = await captureError(() => rejected.next())

  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketCapacityError,
  )
  expect(MockWebSocket.instances).toHaveLength(2)

  MockWebSocket.instances[0]?.completeLatestResponse()
  MockWebSocket.instances[1]?.completeLatestResponse()
  await accountOneChunk
  await accountTwoChunk
  await accountOne.next()
  await accountTwo.next()
})

test("canonical websocket identity prevents one pool scope from crossing capacity identities", async () => {
  const firstIdentity = responsesWebSocketModule.createPooledWebSocketIdentity({
    accountFingerprint: "account-1",
    origin: "https://api.githubcopilot.com",
    poolScope: ["same-session"],
    provider: "test",
  })
  const secondIdentity = responsesWebSocketModule.createPooledWebSocketIdentity(
    {
      accountFingerprint: "account-2",
      origin: "https://api.githubcopilot.com",
      poolScope: ["same-session"],
      provider: "test",
    },
  )

  expect(secondIdentity.capacityKey).not.toBe(firstIdentity.capacityKey)
  expect(secondIdentity.poolKey).not.toBe(firstIdentity.poolKey)
  expect(
    firstIdentity.poolKey.startsWith(`${firstIdentity.capacityKey}|`),
  ).toBe(true)
  await collectDirectWebSocketIdentity(firstIdentity, createResourceLimits())
  await collectDirectWebSocketIdentity(secondIdentity, createResourceLimits())
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.OPEN)
})

test("pooled websocket rejects a forged pool and capacity identity before opening", async () => {
  const firstIdentity = responsesWebSocketModule.createPooledWebSocketIdentity({
    accountFingerprint: "account-1",
    origin: "https://api.githubcopilot.com",
    poolScope: ["session-1"],
    provider: "test",
  })
  const secondIdentity = responsesWebSocketModule.createPooledWebSocketIdentity(
    {
      accountFingerprint: "account-2",
      origin: "https://api.githubcopilot.com",
      poolScope: ["session-1"],
      provider: "test",
    },
  )
  const forgedIdentity = {
    capacityKey: firstIdentity.capacityKey,
    poolKey: secondIdentity.poolKey,
  } as import("../src/services/responses-websocket").PooledWebSocketIdentity

  const error = await captureError(() =>
    collectDirectWebSocketIdentity(forgedIdentity, createResourceLimits()),
  )

  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketRequestError,
  )
  expect(
    (
      error as InstanceType<
        typeof responsesWebSocketModule.PooledWebSocketRequestError
      >
    ).sendState,
  ).toBe("not-sent")
  expect(MockWebSocket.instances).toHaveLength(0)
})

test("pooled websocket evicts only the least-recent idle connection", async () => {
  const limits = createResourceLimits({ idleConnectionLimit: 2 })

  await collectDirectWebSocketStream("idle-1", "account-1", limits)
  await collectDirectWebSocketStream("idle-2", "account-1", limits)
  await collectDirectWebSocketStream("idle-3", "account-1", limits)

  expect(MockWebSocket.instances).toHaveLength(3)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[2]?.readyState).toBe(MockWebSocket.OPEN)

  await collectDirectWebSocketStream("idle-2", "account-1", limits)
  expect(MockWebSocket.instances).toHaveLength(3)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(2)
})

test("pooled websocket counts a closing LRU socket until its close event", async () => {
  const limits = createResourceLimits({
    capacityWaitMs: 100,
    globalConnectionLimit: 1,
    idleConnectionLimit: 1,
    perCapacityKeyConnectionLimit: 1,
  })
  await collectDirectWebSocketStream("idle", "account-1", limits)
  MockWebSocket.deferClose = true

  const next = createDirectWebSocketStream("next", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const nextChunk = next.next()
  await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSING)
  expect(
    responsesWebSocketModule.getPooledWebSocketDiagnostics().connections,
  ).toBe(1)

  MockWebSocket.instances[0]?.finishClose()
  await waitFor(() => MockWebSocket.instances[1]?.sent.length === 1)
  MockWebSocket.instances[1]?.completeLatestResponse()
  await nextChunk
  await next.next()
})

test("pooled websocket never evicts an active connection to satisfy the idle cap", async () => {
  MockWebSocket.autoComplete = false
  const limits = createResourceLimits({ idleConnectionLimit: 1 })
  const active = createDirectWebSocketStream("active", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const activeChunk = active.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  MockWebSocket.autoComplete = true
  await collectDirectWebSocketStream("idle-1", "account-1", limits)
  await collectDirectWebSocketStream("idle-2", "account-1", limits)

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)
  expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(MockWebSocket.instances[2]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  await activeChunk
  await active.next()
})

test("pooled websocket waits only before send for dedicated capacity", async () => {
  MockWebSocket.autoComplete = false
  const limits = createResourceLimits({
    capacityWaitMs: 100,
    dedicatedConnectionLimit: 1,
    globalConnectionLimit: 2,
    perCapacityKeyConnectionLimit: 2,
  })
  const first = createDirectWebSocketStream("shared", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const second = createDirectWebSocketStream("shared", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const third = createDirectWebSocketStream("shared", "account-1", limits)[
    Symbol.asyncIterator
  ]()
  const firstChunk = first.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  const secondChunk = second.next()
  await waitFor(() => MockWebSocket.instances[1]?.sent.length === 1)
  const thirdChunk = third.next()

  await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)

  MockWebSocket.instances[1]?.completeLatestResponse()
  await secondChunk
  await second.next()
  await waitFor(() => MockWebSocket.instances[2]?.sent.length === 1)

  MockWebSocket.instances[2]?.completeLatestResponse()
  await thirdChunk
  await third.next()
  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunk
  await first.next()
})

test("pooled websocket measures string queue limits as UTF-8 bytes", async () => {
  MockWebSocket.autoComplete = false
  const stream = createDirectWebSocketStream(
    "utf8",
    "account-1",
    createResourceLimits({ maxFrameBytes: 3 }),
  )[Symbol.asyncIterator]()
  const firstChunk = stream.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage("éé")

  const error = await captureError(() => firstChunk)
  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketQueueOverflowError,
  )
  expect(
    (
      error as InstanceType<
        typeof responsesWebSocketModule.PooledWebSocketQueueOverflowError
      >
    ).frameBytes,
  ).toBe(4)
})

test("pooled websocket caps aggregate queued UTF-8 bytes", async () => {
  MockWebSocket.autoComplete = false
  const stream = createDirectWebSocketStream(
    "utf8-queue",
    "account-1",
    createResourceLimits({
      maxFrameBytes: 8,
      maxQueuedBytes: 3,
      maxQueuedFrames: 8,
    }),
  )[Symbol.asyncIterator]()
  const firstChunk = stream.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage("é")
  MockWebSocket.instances[0]?.emitMessage("é")

  const error = await captureError(() => firstChunk)
  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketQueueOverflowError,
  )
  expect(
    error as InstanceType<
      typeof responsesWebSocketModule.PooledWebSocketQueueOverflowError
    >,
  ).toMatchObject({
    frameBytes: 2,
    queuedBytes: 2,
    queuedFrames: 1,
    sendState: "frame-seen",
  })
  expect(await stream.next()).toEqual({ done: true, value: undefined })
})

test("pooled websocket measures binary views by byteLength", async () => {
  MockWebSocket.autoComplete = false
  const stream = createDirectWebSocketStream(
    "binary",
    "account-1",
    createResourceLimits({ maxFrameBytes: 4 }),
  )[Symbol.asyncIterator]()
  const firstChunk = stream.next()
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(new Uint8Array(5))

  const error = await captureError(() => firstChunk)
  expect(error).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketQueueOverflowError,
  )
  expect(
    (
      error as InstanceType<
        typeof responsesWebSocketModule.PooledWebSocketQueueOverflowError
      >
    ).frameBytes,
  ).toBe(5)
})

test("pooled websocket reports fresh, immediate, and logical-idle reuse safely", async () => {
  let logicalNow = 0
  Date.now = () => logicalNow
  const diagnostics: Array<Record<string, unknown>> = []
  consola.debug = ((message: unknown, payload?: unknown) => {
    if (
      message === "responses.websocket"
      && typeof payload === "object"
      && payload !== null
    ) {
      diagnostics.push(payload as Record<string, unknown>)
    }
  }) as typeof consola.debug
  const limits = createResourceLimits()

  await collectDirectWebSocketStream("stable", "account-1", limits)
  await collectDirectWebSocketStream("stable", "account-1", limits)
  logicalNow = 12_000
  await collectDirectWebSocketStream("stable", "account-1", limits)

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(3)
  const requests = diagnostics.filter(
    (diagnostic) => diagnostic.event === "request_started",
  )
  expect(requests.map((request) => request.reused)).toEqual([false, true, true])
  expect(requests.map((request) => request.connectionAgeMs)).toEqual([
    0, 0, 12_000,
  ])
  expect(requests.map((request) => request.requestFrameBytes)).toEqual([
    20, 20, 20,
  ])
  expect(requests.every((request) => request.pooled === true)).toBe(true)

  MockWebSocket.instances[0]?.close(1006, "private conversation text", false)
  const closeDiagnostic = diagnostics.find(
    (diagnostic) => diagnostic.event === "connection_closed",
  )
  expect(closeDiagnostic).toMatchObject({
    closeCode: 1006,
    closeReason: "provided",
    wasClean: false,
  })
  expect(JSON.stringify(closeDiagnostic)).not.toContain("private conversation")
})

test("pooled websocket clear hook forces the next request onto a fresh connection", async () => {
  const limits = createResourceLimits()
  await collectDirectWebSocketStream("stable", "account-1", limits)

  expect(
    responsesWebSocketModule.clearPooledWebSocketConnections("network_change"),
  ).toBe(1)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)

  await collectDirectWebSocketStream("stable", "account-1", limits)
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("pooled websocket clear hook closes a connecting socket before releasing capacity", async () => {
  MockWebSocket.neverOpen = true
  const limits = createResourceLimits({ globalConnectionLimit: 1 })
  const connecting = createDirectWebSocketStream(
    "connecting",
    "account-1",
    limits,
  )[Symbol.asyncIterator]()
  const connectingChunk = connecting.next()
  await waitFor(() => MockWebSocket.instances.length === 1)

  expect(
    responsesWebSocketModule.clearPooledWebSocketConnections("proxy_change"),
  ).toBe(1)
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(
    responsesWebSocketModule.getPooledWebSocketDiagnostics().connections,
  ).toBe(0)
  expect(await captureError(() => connectingChunk)).toBeInstanceOf(
    responsesWebSocketModule.PooledWebSocketRequestError,
  )

  MockWebSocket.neverOpen = false
  await collectDirectWebSocketStream("fresh", "account-1", limits)
  expect(MockWebSocket.instances).toHaveLength(2)
})

test("pooled websocket idle TTL releases socket and capacity deterministically", async () => {
  const idleTimeoutMs = 12_345
  const idleTimer = { unref: () => idleTimer }
  let expireIdle: (() => void) | null = null
  ;(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    handler: () => void,
    timeout?: number,
  ) => {
    if (timeout === idleTimeoutMs) {
      expireIdle = handler
      return idleTimer as unknown as ReturnType<typeof setTimeout>
    }
    return originalSetTimeout(handler, timeout)
  }) as typeof setTimeout
  ;(
    globalThis as unknown as { clearTimeout: typeof clearTimeout }
  ).clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    if (timer === (idleTimer as unknown as ReturnType<typeof setTimeout>)) {
      expireIdle = null
      return
    }
    originalClearTimeout(timer)
  }) as typeof clearTimeout

  await collectDirectWebSocketStream(
    "ttl-session",
    "account-1",
    createResourceLimits({ idleTimeoutMs }),
  )
  expect(
    responsesWebSocketModule.getPooledWebSocketDiagnostics(),
  ).toMatchObject({
    activeRequests: 0,
    connections: 1,
    idleConnections: 1,
    pooledConnections: 1,
  })
  expect(expireIdle).toBeFunction()

  const expiration = expireIdle as unknown as (() => void) | null
  if (!expiration) {
    throw new Error("Idle timer was not scheduled")
  }
  expiration()

  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(
    responsesWebSocketModule.getPooledWebSocketDiagnostics(),
  ).toMatchObject({
    activeRequests: 0,
    connections: 0,
    dedicatedConnections: 0,
    idleConnections: 0,
    pooledConnections: 0,
    queuedBytes: 0,
    queuedFrames: 0,
  })
})

for (const burstSize of [10_000, 100_000]) {
  test(`pooled websocket bounds and cleans up a ${burstSize}-frame slow-consumer burst`, async () => {
    MockWebSocket.autoComplete = false
    const before = responsesWebSocketModule.getPooledWebSocketDiagnostics()
    const stream = createDirectWebSocketStream(
      `burst-${burstSize}`,
      "account-1",
      createResourceLimits({
        maxQueuedBytes: 4096,
        maxQueuedFrames: 64,
      }),
    )[Symbol.asyncIterator]()
    const firstChunk = stream.next()
    await waitFor(() => MockWebSocket.instances.at(-1)?.sent.length === 1)
    const websocket = MockWebSocket.instances.at(-1)

    for (let index = 0; index < burstSize; index += 1) {
      websocket?.emitMessage(`frame-${index}`)
    }

    const error = await captureError(() => firstChunk)
    const after = responsesWebSocketModule.getPooledWebSocketDiagnostics()
    expect(error).toBeInstanceOf(
      responsesWebSocketModule.PooledWebSocketQueueOverflowError,
    )
    expect(
      (
        error as InstanceType<
          typeof responsesWebSocketModule.PooledWebSocketQueueOverflowError
        >
      ).sendState,
    ).toBe("frame-seen")
    expect(after.overflows - before.overflows).toBe(1)
    expect(after.queuedBytes).toBe(0)
    expect(after.queuedFrames).toBe(0)
    expect(after.activeRequests).toBe(0)
    expect(after.connections).toBe(0)
    expect(websocket?.readyState).toBe(MockWebSocket.CLOSED)
  })
}

test("Copilot safe stream emits exactly one content-safe terminal error on queue overflow", async () => {
  MockWebSocket.autoComplete = false
  const response = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId: "safe-overflow",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  for (let index = 0; index <= 4096; index += 1) {
    MockWebSocket.instances[0]?.emitMessage(`private-frame-${index}`)
  }
  const chunks = await chunksPromise

  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(JSON.parse(chunks[0]?.data ?? "null")).toMatchObject({
    message: "Responses websocket receive queue exceeded its configured limit",
    type: "error",
  })
  expect(chunks[0]?.data).not.toContain("private-frame")
  expect(
    responsesTransportHealthModule.getResponsesWebSocketTransportHealthDiagnostics()
      .active,
  ).toBe(false)
  expect(
    responsesWebSocketModule.getPooledWebSocketDiagnostics(),
  ).toMatchObject({
    activeRequests: 0,
    connections: 0,
    dedicatedConnections: 0,
    idleConnections: 0,
    pooledConnections: 0,
    queuedBytes: 0,
    queuedFrames: 0,
  })
})

test("Responses websocket pool does not reuse a connection after an upstream error event", async () => {
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
  const firstChunksPromise = collectStreamChunks(
    firstResponse as AsyncIterable<unknown>,
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "internal_error",
        message: "internal server error",
      },
      type: "error",
    }),
  )
  const firstChunks = await firstChunksPromise

  const secondPromise = collectResponsesStream("request-1")
  await waitFor(
    () =>
      MockWebSocket.instances.reduce(
        (total, websocket) => total + websocket.sent.length,
        0,
      ) === 2,
  )
  MockWebSocket.instances.at(-1)?.completeLatestResponse()
  await secondPromise

  expect(firstChunks).toHaveLength(1)
  expect(firstChunks[0]?.event).toBe("error")
  expect(MockWebSocket.instances).toHaveLength(2)
})

test("Responses websocket falls back before sending on a pooled connection that closes after a terminal event", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-stale-pool-fallback",
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
  const firstChunksPromise = collectStreamChunks(
    firstResponse as AsyncIterable<unknown>,
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.completeLatestResponse()
  await firstChunksPromise

  originalSetTimeout(() => MockWebSocket.instances[0]?.close(), 0)
  const secondResponse = await createResponses(
    {
      input: "hello again",
      model: "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    },
  )
  const secondChunks = await collectStreamChunks(
    secondResponse as AsyncIterable<unknown>,
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(secondChunks).toHaveLength(1)
  expect(secondChunks[0]?.event).toBe("response.completed")
})

test("Responses websocket retries an initial internal error over the admitted HTTP body", async () => {
  MockWebSocket.autoComplete = false
  const serializationStages: Array<string> = []
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-internal-error-retry",
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
      requestId: "initial-internal-error",
      transport: "websocket",
      vision: false,
      wireSerializationObserver: {
        onSerialization: (stage) => serializationStages.push(stage),
      },
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitMessage(
    JSON.stringify({
      error: {
        code: "internal_error",
        message: "internal server error",
      },
      type: "error",
    }),
  )
  const chunks = await chunksPromise
  const admitted = admitResponsesWirePayload(
    prepareResponsesWirePayload({
      input: "hello",
      model: "gpt-test",
      stream: true,
    }),
    "user",
    "websocket",
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockWebSocket.instances[0]?.sent[0]).toBe(admitted.websocketFrame!)
  expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(admitted.httpBody)
  expect(serializationStages).toEqual(["http_body", "websocket_frame"])
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("response.completed")
  expect(chunks[0]?.data).toContain("resp-http-internal-error-retry")

  MockWebSocket.autoComplete = true
  await collectResponsesStream("after-internal-error-retry", {
    allowHttpFallback: true,
    reasoningRecoverySessionId: "after-internal-error-retry",
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket does not retry a prompt token limit error", async () => {
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
      requestId: "prompt-token-limit",
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
        message: "prompt token count of 329922 exceeds the limit of 272000",
      },
      type: "error",
    }),
  )
  const chunks = await chunksPromise

  expect(fetchMock).not.toHaveBeenCalled()
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    "prompt token count of 329922 exceeds the limit of 272000",
  )
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
  expect(
    responsesTransportHealthModule.getResponsesWebSocketTransportHealthDiagnostics()
      .active,
  ).toBe(false)
})

test("Responses websocket does not fall back after sending without seeing a frame", async () => {
  MockWebSocket.autoComplete = false
  const reportTermination = mock(originalStreamLifecycleReporter)
  streamLifecycleDependencies.reportTermination = reportTermination
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
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

  expect(fetchMock).not.toHaveBeenCalled()
  expect(reportTermination).toHaveBeenCalledTimes(1)
  expect(reportTermination.mock.calls[0]?.[0].diagnostics).toMatchObject({
    eventCount: 0,
    retryCount: 0,
    terminalSeen: false,
    transport: "websocket",
  })
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Responses websocket ended without a terminal response"',
  )
})

test("Responses websocket network interruption fails once and sends the next request over HTTP", async () => {
  const stableSession = "stable-network-session"
  await collectResponsesStream("network-warmup", {
    reasoningRecoverySessionId: stableSession,
  })
  expect(MockWebSocket.instances).toHaveLength(1)
  await collectResponsesStream("network-other-warmup", {
    reasoningRecoverySessionId: "other-network-session",
  })
  expect(MockWebSocket.instances).toHaveLength(2)

  MockWebSocket.autoComplete = false
  const reportTermination = mock(originalStreamLifecycleReporter)
  streamLifecycleDependencies.reportTermination = reportTermination
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-after-network-interruption",
            ),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch

  const interruptedResponse = await createResponses(
    { input: "continue", model: "gpt-test", stream: true },
    {
      allowHttpFallback: true,
      initiator: "user",
      reasoningRecoverySessionId: stableSession,
      requestId: "network-interrupted",
      transport: "websocket",
      vision: false,
    },
  )
  const interruptedChunks = collectStreamChunks(
    interruptedResponse as AsyncIterable<unknown>,
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 2)
  MockWebSocket.instances[0]?.close(1006, "network changed", false)
  const chunks = await interruptedChunks

  expect(fetchMock).not.toHaveBeenCalled()
  expect(reportTermination).toHaveBeenCalledTimes(1)
  expect(
    (reportTermination.mock.results[0]?.value as { kind?: unknown }).kind,
  ).toBe("upstream_disconnect")
  expect(reportTermination.mock.calls[0]?.[0].diagnostics).toMatchObject({
    eventCount: 0,
    retryCount: 0,
    terminalSeen: false,
    transport: "websocket",
  })
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(MockWebSocket.instances[1]?.readyState).toBe(MockWebSocket.CLOSED)

  MockWebSocket.autoComplete = true
  await collectResponsesStream("network-no-http-capability", {
    allowHttpFallback: false,
    reasoningRecoverySessionId: "websocket-only-session",
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(MockWebSocket.instances).toHaveLength(3)

  const httpOnlyResponse = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId: "network-http-only",
      transport: "http",
      vision: false,
    },
  )
  await collectStreamChunks(httpOnlyResponse as AsyncIterable<unknown>)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(MockWebSocket.instances).toHaveLength(3)

  const recoveredPayload = prepareResponsesWirePayload({
    input: "hello",
    model: "gpt-test",
    stream: true,
  })
  const websocketArtifact = admitResponsesWirePayload(
    recoveredPayload,
    "user",
    "websocket",
  )
  const recoveredResponse = await createResponses(recoveredPayload, {
    allowHttpFallback: true,
    initiator: "user",
    reasoningRecoverySessionId: stableSession,
    requestId: "network-fresh",
    transport: "websocket",
    vision: false,
    wireArtifact: websocketArtifact,
  })
  const recoveredChunks = await collectStreamChunks(
    recoveredResponse as AsyncIterable<unknown>,
  )
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(websocketArtifact.httpBody)
  expect(MockWebSocket.instances).toHaveLength(3)
  expect(recoveredChunks[0]?.data).toContain(
    "resp-http-after-network-interruption",
  )

  Date.now = () =>
    originalDateNow()
    + responsesTransportHealthModule.DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS
    + 1
  await collectResponsesStream("network-cooldown-expired", {
    allowHttpFallback: true,
    reasoningRecoverySessionId: stableSession,
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(MockWebSocket.instances).toHaveLength(4)
  expect(MockWebSocket.instances[3]?.sent).toHaveLength(1)
})

test("Responses websocket uses one cooldown snapshot when converting an admitted artifact", async () => {
  const now = 1_000
  responsesTransportHealthModule.responsesWebSocketTransportHealthDependencies.now =
    () => now
  responsesTransportHealthModule.enterResponsesWebSocketTransportCooldown(
    "network_change",
  )

  let healthReads = 0
  responsesTransportHealthModule.responsesWebSocketTransportHealthDependencies.now =
    () => {
      healthReads += 1
      return healthReads === 1 ?
          now + 1
        : now
            + responsesTransportHealthModule.DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS
            + 1
    }
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            response: createResponsesResult(
              "gpt-test",
              "resp-http-single-health-snapshot",
            ),
            sequence_number: 1,
            type: "response.completed",
          })}`,
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    ),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  const payload = prepareResponsesWirePayload({
    input: "hello",
    model: "gpt-test",
    stream: true,
  })
  const websocketArtifact = admitResponsesWirePayload(
    payload,
    "user",
    "websocket",
  )

  const response = await createResponses(payload, {
    allowHttpFallback: true,
    initiator: "user",
    requestId: "single-health-snapshot",
    transport: "websocket",
    vision: false,
    wireArtifact: websocketArtifact,
  })
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(healthReads).toBe(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(websocketArtifact.httpBody)
  expect(MockWebSocket.instances).toHaveLength(0)
  expect(chunks[0]?.data).toContain("resp-http-single-health-snapshot")
})

test("Responses websocket degradation keeps unrelated active streams alive", async () => {
  MockWebSocket.autoComplete = false

  const activeResponse = await createResponses(
    { input: "long-running", model: "gpt-test", stream: true },
    {
      allowHttpFallback: true,
      initiator: "user",
      reasoningRecoverySessionId: "active-network-session",
      requestId: "active-network-request",
      transport: "websocket",
      vision: false,
    },
  )
  const activeChunksPromise = collectStreamChunks(
    activeResponse as AsyncIterable<unknown>,
  )
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)

  const interruptedResponse = await createResponses(
    { input: "interrupted", model: "gpt-test", stream: true },
    {
      allowHttpFallback: true,
      initiator: "user",
      reasoningRecoverySessionId: "interrupted-network-session",
      requestId: "interrupted-network-request",
      transport: "websocket",
      vision: false,
    },
  )
  const interruptedChunksPromise = collectStreamChunks(
    interruptedResponse as AsyncIterable<unknown>,
  )
  await waitFor(() => MockWebSocket.instances[1]?.sent.length === 1)
  MockWebSocket.instances[1]?.close(1006, "network changed", false)

  const interruptedChunks = await interruptedChunksPromise
  expect(interruptedChunks.at(-1)?.event).toBe("error")
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.OPEN)

  MockWebSocket.instances[0]?.completeLatestResponse()
  const activeChunks = await activeChunksPromise
  expect(activeChunks.at(-1)?.event).toBe("response.completed")
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

test("Responses websocket recovery does not retry an HTTP body reset", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(reasoningByRequest).toEqual([[]])
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain('"message":"terminated"')
})

test("Responses HTTP does not retry when the stream ends before the first event", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"http stream ended without a terminal event"',
  )
})

test("Responses HTTP does not retry when the connection resets before the first event", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain('"message":"terminated"')
})

test("Responses HTTP does not retry when the connection resets before headers", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain('"message":"fetch failed"')
})

test("Responses HTTP emits a terminal error after one pre-header reset", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain("fetch failed")
})

test("Responses HTTP disconnect diagnostics keep retry count at zero", async () => {
  const reportTermination = mock(originalStreamLifecycleReporter)
  streamLifecycleDependencies.reportTermination = reportTermination
  const fetchMock = mock(() => {
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
      requestId: "http-zero-retry-diagnostics",
      transport: "http",
      vision: false,
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(reportTermination).toHaveBeenCalledTimes(1)
  expect(reportTermination.mock.calls[0]?.[0].diagnostics).toMatchObject({
    eventCount: 0,
    retryCount: 0,
    terminalSeen: false,
    transport: "http",
  })
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain('"message":"terminated"')
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
  const serializationStages: Array<string> = []
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
      wireSerializationObserver: {
        onSerialization: (stage) => serializationStages.push(stage),
      },
    },
  )
  const chunks = await collectStreamChunks(response as AsyncIterable<unknown>)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(
    parseRequestBody(fetchMock.mock.calls[0]?.[1]).input.map(
      (item) => item.type,
    ),
  ).toEqual(["reasoning", "message"])
  expect(
    parseRequestBody(fetchMock.mock.calls[1]?.[1]).input.map(
      (item) => item.type,
    ),
  ).toEqual(["message"])
  expect(fetchMock.mock.calls[0]?.[1]?.body).not.toBe(
    fetchMock.mock.calls[1]?.[1]?.body,
  )
  expect(serializationStages).toEqual(["http_body", "recovery_http_body"])
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

  MockWebSocket.autoComplete = true
  await collectResponsesStream("request-after-caller-abort", {
    allowHttpFallback: true,
    reasoningRecoverySessionId: "session-after-caller-abort",
  })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket accepts a string abort reason without retrying", async () => {
  MockWebSocket.autoComplete = false
  const fetchMock = mock(() =>
    Promise.resolve(new Response("unexpected HTTP fallback")),
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
  const controller = new AbortController()
  const response = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      allowHttpFallback: true,
      initiator: "user",
      requestId: "string-abort-reason",
      signal: controller.signal,
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  controller.abort("client disconnected")

  const chunks = await chunksPromise
  expect(fetchMock).not.toHaveBeenCalled()
  expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
  expect(chunks).toHaveLength(0)
})

test("Responses websocket pool separates different request IDs", async () => {
  await collectResponsesStream("request-1")
  await collectResponsesStream("request-2")

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket pool reuses a stable session across request IDs", async () => {
  await collectResponsesStream("request-1", {
    reasoningRecoverySessionId: "stable-session",
  })
  await collectResponsesStream("request-2", {
    reasoningRecoverySessionId: "stable-session",
  })

  expect(MockWebSocket.instances).toHaveLength(1)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(2)
})

test("Responses websocket pool isolates different stable sessions", async () => {
  await collectResponsesStream("request-1", {
    reasoningRecoverySessionId: "stable-session-1",
  })
  await collectResponsesStream("request-2", {
    reasoningRecoverySessionId: "stable-session-2",
  })

  expect(MockWebSocket.instances).toHaveLength(2)
  expect(MockWebSocket.instances[0]?.sent).toHaveLength(1)
  expect(MockWebSocket.instances[1]?.sent).toHaveLength(1)
})

test("Responses websocket pool isolates token, model, and subagent identity", async () => {
  const sessionId = "stable-session"
  await collectResponsesStream("request-1", {
    reasoningRecoverySessionId: sessionId,
  })

  state.copilotToken = "other-token"
  await collectResponsesStream("request-2", {
    reasoningRecoverySessionId: sessionId,
  })
  await collectResponsesStream("request-3", {
    model: "gpt-other",
    reasoningRecoverySessionId: sessionId,
  })
  await collectResponsesStream("request-4", {
    reasoningRecoverySessionId: sessionId,
    subagentMarker: {
      agent_id: "agent-1",
      agent_type: "review",
      session_id: "subagent-thread",
    },
  })

  expect(MockWebSocket.instances).toHaveLength(4)
  for (const websocket of MockWebSocket.instances) {
    expect(websocket.sent).toHaveLength(1)
  }
})

test("Responses websocket capacity stays on the same account across Copilot token refresh", () => {
  const payload = { input: "hello", model: "gpt-test", stream: true }
  state.copilotToken = "short-lived-token-1"
  const first = copilotResponsesModule.prepareResponsesWebSocketRequest(
    admitResponsesWirePayload(
      prepareResponsesWirePayload(payload),
      "user",
      "websocket",
    ),
    {},
    { requestId: "request-1" },
  )
  state.copilotToken = "short-lived-token-2"
  const second = copilotResponsesModule.prepareResponsesWebSocketRequest(
    admitResponsesWirePayload(
      prepareResponsesWirePayload(payload),
      "user",
      "websocket",
    ),
    {},
    { requestId: "request-1" },
  )

  expect(second.identity.capacityKey).toBe(first.identity.capacityKey)
  expect(second.identity.poolKey).not.toBe(first.identity.poolKey)
})

test("Responses websocket pool isolates subagent sessions with reused agent IDs", async () => {
  const common = {
    reasoningRecoverySessionId: "stable-root-session",
    subagentMarker: {
      agent_id: "reused-agent",
      agent_type: "review",
      session_id: "subagent-session-1",
    },
  }
  await collectResponsesStream("request-1", common)
  await collectResponsesStream("request-2", {
    ...common,
    subagentMarker: {
      ...common.subagentMarker,
      session_id: "subagent-session-2",
    },
  })

  expect(MockWebSocket.instances).toHaveLength(2)
})

test("Responses websocket pool isolates vision handshake state", async () => {
  const reasoningRecoverySessionId = "stable-session"
  await collectResponsesStream("request-1", {
    reasoningRecoverySessionId,
    vision: false,
  })
  await collectResponsesStream("request-2", {
    reasoningRecoverySessionId,
    vision: true,
  })

  expect(MockWebSocket.instances).toHaveLength(2)
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

test("Responses websocket concurrent stable-session streams use dedicated connections", async () => {
  MockWebSocket.autoComplete = false

  const firstResponse = await createResponses(
    {
      input: "hello",
      model: "gpt-test",
      stream: true,
    },
    {
      initiator: "user",
      reasoningRecoverySessionId: "stable-session",
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
      reasoningRecoverySessionId: "stable-session",
      requestId: "request-2",
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

test("Responses websocket stream failure normalizes an event message fallback", async () => {
  MockWebSocket.autoComplete = false
  const response = await createResponses(
    { input: "hello", model: "gpt-test", stream: true },
    {
      initiator: "user",
      requestId: "event-message-fallback",
      transport: "websocket",
      vision: false,
    },
  )
  const chunksPromise = collectStreamChunks(response as AsyncIterable<unknown>)
  await waitFor(() => MockWebSocket.instances[0]?.sent.length === 1)
  MockWebSocket.instances[0]?.emitError({ message: "transport unavailable" })

  const chunks = await chunksPromise
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.event).toBe("error")
  expect(chunks[0]?.data).toContain(
    '"message":"Responses websocket stream error: transport unavailable"',
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

const createResourceLimits = (
  overrides: Partial<ResponsesWebSocketResourceLimits> = {},
): ResponsesWebSocketResourceLimits => ({
  ...DEFAULT_RESPONSES_WEBSOCKET_RESOURCE_LIMITS,
  ...overrides,
})

const createDirectWebSocketStream = (
  poolKey: string,
  capacityKey: string,
  resourceLimits: ResponsesWebSocketResourceLimits,
): AsyncIterable<string> =>
  responsesWebSocketModule.createPooledWebSocketStream(
    {
      headers: {},
      identity: responsesWebSocketModule.createPooledWebSocketIdentity({
        accountFingerprint: capacityKey,
        origin: "https://api.githubcopilot.com",
        poolScope: [poolKey],
        provider: "test",
      }),
      payload: { model: "gpt-test" },
      resourceLimits,
      url: "wss://api.githubcopilot.com/responses",
    },
    {
      createChunk: (data) => data,
      isTerminalChunk: (data) => data.includes('"response.completed"'),
      openErrorMessage: "test websocket open error",
      streamErrorMessage: "test websocket stream error",
      terminalChunkMissingMessage: "test websocket terminal missing",
    },
  )

const collectDirectWebSocketStream = async (
  poolKey: string,
  capacityKey: string,
  resourceLimits: ResponsesWebSocketResourceLimits,
): Promise<void> => {
  for await (const _chunk of createDirectWebSocketStream(
    poolKey,
    capacityKey,
    resourceLimits,
  )) {
    // consume stream
  }
}

const collectDirectWebSocketIdentity = async (
  identity: import("../src/services/responses-websocket").PooledWebSocketIdentity,
  resourceLimits: ResponsesWebSocketResourceLimits,
): Promise<void> => {
  const request = {
    headers: {},
    identity,
    payload: { model: "gpt-test" },
    resourceLimits,
    url: "wss://api.githubcopilot.com/responses",
  }
  for await (const _chunk of responsesWebSocketModule.createPooledWebSocketStream(
    request,
    {
      createChunk: (data) => data,
      isTerminalChunk: (data) => data.includes('"response.completed"'),
      openErrorMessage: "test websocket open error",
      streamErrorMessage: "test websocket stream error",
      terminalChunkMissingMessage: "test websocket terminal missing",
    },
  )) {
    // consume stream
  }
}

const collectResponsesStream = async (
  requestId: string,
  options: {
    allowHttpFallback?: boolean
    model?: string
    reasoningRecoverySessionId?: string
    subagentMarker?: {
      agent_id: string
      agent_type: string
      session_id: string
    } | null
    vision?: boolean
  } = {},
): Promise<Array<{ data?: string; event?: string; id?: string | number }>> => {
  const response = await createResponses(
    {
      input: "hello",
      model: options.model ?? "gpt-test",
      stream: true,
    },
    {
      allowHttpFallback: options.allowHttpFallback,
      initiator: "user",
      reasoningRecoverySessionId: options.reasoningRecoverySessionId,
      requestId,
      subagentMarker: options.subagentMarker,
      transport: "websocket",
      vision: options.vision ?? false,
    },
  )

  return collectStreamChunks(response as AsyncIterable<unknown>)
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
