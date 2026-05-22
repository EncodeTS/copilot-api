/* eslint-disable max-lines */
import consola from "consola"
import { events } from "fetch-event-stream"
import { createHash } from "node:crypto"
import { WebSocket } from "undici"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError, logUpstreamError } from "~/lib/error"
import { getProxyEnvDispatcher } from "~/lib/proxy"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  reasoning?: Reasoning | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable>
  service_tier?: string | null // NOTE: Unsupported by GitHub Copilot
  [key: string]: unknown
}

export type ToolChoiceOptions = "none" | "auto" | "required"
export type ToolSearchExecution = "client" | "server"

export interface ToolChoiceFunction {
  name: string
  type: "function"
}

export type Tool =
  | FunctionTool
  | ToolSearchTool
  | NamespaceTool
  | Record<string, unknown>

export interface FunctionTool {
  name: string
  parameters: { [key: string]: unknown } | null
  strict: boolean | null
  type: "function"
  description?: string | null
  defer_loading?: boolean | null
}

export interface ToolSearchTool {
  type: "tool_search"
  execution?: ToolSearchExecution | null
  description?: string | null
  parameters?: { [key: string]: unknown } | null
}

export interface NamespaceTool {
  type: "namespace"
  name: string
  description?: string | null
  tools: Array<FunctionTool>
}

export type ResponseIncludable =
  | "file_search_call.results"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"

export interface Reasoning {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
  summary?: "auto" | "concise" | "detailed" | null
}

export interface ResponseContextManagementCompactionItem {
  type: "compaction"
  compact_threshold: number
}

export type ResponseContextManagementItem =
  ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: "commentary" | "final_answer"
}

export interface ResponseFunctionToolCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchCallItem {
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseToolSearchOutputItem {
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseInputReasoning {
  id?: string
  type: "reasoning"
  summary: Array<{
    type: "summary_text"
    text: string
  }>
  encrypted_content: string
}

export interface ResponseInputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseToolSearchCallItem
  | ResponseToolSearchOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  type: "input_text" | "output_text"
  text: string
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto"
}

export interface ResponseInputFile {
  type: "input_file"
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  usage?: ResponseUsage | null
  error: ResponseError | null
  incomplete_details: IncompleteDetails | null
  instructions: string | null
  metadata: Metadata | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<Tool>
  top_p: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputToolSearchCall
  | ResponseOutputToolSearchOutput
  | ResponseOutputCompaction

export interface ResponseOutputMessage {
  id: string
  type: "message"
  role: "assistant"
  status: "completed" | "in_progress" | "incomplete"
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: "reasoning"
  summary?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: "completed" | "in_progress" | "incomplete"
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  status?: "in_progress" | "completed" | "incomplete"
  namespace?: string | null
}

export interface ResponseOutputToolSearchCall {
  id?: string
  type: "tool_search_call"
  call_id: string
  arguments: Record<string, unknown> | string
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputToolSearchOutput {
  id?: string
  type: "tool_search_output"
  call_id: string
  tools: Array<Tool>
  execution?: ToolSearchExecution | null
  status?: "in_progress" | "completed" | "incomplete"
}

export interface ResponseOutputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export type ResponseOutputContentBlock =
  | ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: "refusal"
  refusal: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseErrorEvent {
  code: string | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.delta"
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  arguments: string
  item_id: string
  name: string
  output_index: number
  sequence_number: number
  type: "response.function_call_arguments.done"
}

export interface ResponseFailedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.failed"
}

export interface ResponseOutputItemAddedEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.added"
}

export interface ResponseOutputItemDoneEvent {
  item: ResponseOutputItem
  output_index: number
  sequence_number: number
  type: "response.output_item.done"
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_text.delta"
}

export interface ResponseReasoningSummaryTextDoneEvent {
  item_id: string
  output_index: number
  sequence_number: number
  summary_index: number
  text: string
  type: "response.reasoning_summary_text.done"
}

export interface ResponseTextDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.delta"
}

export interface ResponseTextDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  text: string
  type: "response.output_text.done"
}

export type ResponsesStream = ReturnType<typeof events>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream
export type ResponsesTransport = "http" | "websocket"

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
}

const RESPONSES_WEBSOCKET_IDLE_TIMEOUT_MS = 60_000

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
    transport = "http",
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, requestId, vision),
    "x-initiator": initiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  prepareForCompact(headers, compactType)

  // service_tier is not supported by github copilot
  payload.service_tier = undefined

  consola.log(`<-- model: ${payload.model}`)

  if (transport === "websocket") {
    const websocketRequest = prepareResponsesWebSocketRequest(
      payload,
      headers,
      {
        requestId,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(websocketRequest)

    if (payload.stream) {
      return stream
    }

    return await consumeResponsesWebSocketStream(stream)
  }

  return await createHttpResponses(payload, headers, requestId)
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  requestId: string,
): Promise<CreateResponsesReturn> => {
  const response = await globalThis.fetch(
    `${copilotBaseUrl(state)}/responses`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    const debugResponse = await logUpstreamError("POST /responses", response, {
      requestId: requestId,
      model: payload.model,
      stream: Boolean(payload.stream),
      tools: payload.tools?.length ?? 0,
      reasoning: payload.reasoning?.effort,
    })
    throw new HTTPError("Failed to create responses", debugResponse)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}

type ResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
  initiator: "agent" | "user"
}

interface ResponsesWebSocketRequest {
  headers: Record<string, string>
  poolKey: string
  payload: ResponsesWebSocketPayload
}

type ResponsesWebSocketErrorEvent = Parameters<
  NonNullable<InstanceType<typeof WebSocket>["onerror"]>
>[0]

export const prepareResponsesWebSocketRequest = (
  payload: ResponsesPayload,
  preparedHeaders: Record<string, string>,
  options: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
  }
}

export const buildResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  {
    requestId,
    subagentMarker,
  }: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): string => {
  const tokenFingerprint =
    state.copilotToken ?
      createHash("sha256").update(state.copilotToken).digest("hex").slice(0, 16)
    : "missing-token"
  const subagentKey =
    subagentMarker ?
      [
        subagentMarker.session_id,
        subagentMarker.agent_id,
        subagentMarker.agent_type,
      ].join(":")
    : "main"

  return [tokenFingerprint, payload.model, requestId, subagentKey]
    .map((part) => encodePoolKeyPart(part))
    .join("|")
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
): ResponsesStream => runResponsesWebSocketRequest(request)

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesWebSocketPayload => {
  const websocketPayload: ResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload["background"]
  delete websocketPayload.service_tier

  return websocketPayload
}

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/responses`)

  if (url.protocol === "https:") {
    url.protocol = "wss:"
  } else if (url.protocol === "http:") {
    url.protocol = "ws:"
  }

  return url.toString()
}

const responsesWebSocketPool = new Map<string, ResponsesWebSocketEntry>()
const responsesWebSocketActiveRequests = new Map<string, number>()

interface ResponsesWebSocketEntry {
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  requestCount: number
  websocketPromise: Promise<InstanceType<typeof WebSocket>>
}

const isResponsesWebSocketEntryClosed = (
  entry: ResponsesWebSocketEntry,
): boolean => entry.closed

interface ResponsesWebSocketRequestTarget {
  entry: ResponsesWebSocketEntry
  pooled: boolean
}

const runResponsesWebSocketRequest = async function* (
  request: ResponsesWebSocketRequest,
): ResponsesStream {
  const { entry, pooled } = getResponsesWebSocketRequestTarget(request)
  const release = acquireResponsesWebSocketEntry(request.poolKey, entry, pooled)

  try {
    const websocket = await getReadyResponsesWebSocket(
      request.poolKey,
      entry,
      pooled,
    )
    websocket.send(JSON.stringify(request.payload))

    for await (const data of createWebSocketMessageStream(websocket)) {
      const chunk = createResponsesWebSocketStreamChunk(data)
      yield chunk

      if (isTerminalResponsesStreamChunk(chunk)) {
        return
      }
    }

    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw new Error("Responses websocket ended without a terminal response")
  } catch (error) {
    removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    throw toError(error)
  } finally {
    release()
  }
}

const getResponsesWebSocketRequestTarget = (
  request: ResponsesWebSocketRequest,
): ResponsesWebSocketRequestTarget => {
  if (getResponsesWebSocketActiveRequestCount(request.poolKey) > 0) {
    return {
      entry: createResponsesWebSocketEntry(request),
      pooled: false,
    }
  }

  const existing = responsesWebSocketPool.get(request.poolKey)
  if (existing && !existing.closed) {
    clearResponsesWebSocketIdleTimer(existing)
    return {
      entry: existing,
      pooled: true,
    }
  }

  const entry = createResponsesWebSocketEntry(request)
  responsesWebSocketPool.set(request.poolKey, entry)
  return {
    entry,
    pooled: true,
  }
}

const createResponsesWebSocketEntry = (
  request: ResponsesWebSocketRequest,
): ResponsesWebSocketEntry => {
  const entry: ResponsesWebSocketEntry = {
    closed: false,
    idleTimer: null,
    requestCount: 0,
    websocketPromise: openResponsesWebSocket({
      headers: request.headers,
      url: buildResponsesWebSocketUrl(copilotBaseUrl(state)),
    }),
  }

  entry.websocketPromise
    .then((websocket) => {
      websocket.addEventListener("close", () => {
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
      websocket.addEventListener("error", () => {
        removeResponsesWebSocketPoolEntry(request.poolKey, entry)
      })
    })
    .catch(() => {
      removeResponsesWebSocketPoolEntry(request.poolKey, entry)
    })

  return entry
}

const acquireResponsesWebSocketEntry = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
  pooled: boolean,
): (() => void) => {
  clearResponsesWebSocketIdleTimer(entry)
  incrementResponsesWebSocketActiveRequestCount(poolKey)
  entry.requestCount += 1

  let released = false
  return () => {
    if (released) {
      return
    }

    released = true
    entry.requestCount -= 1

    decrementResponsesWebSocketActiveRequestCount(poolKey)
    if (entry.closed || entry.requestCount > 0) {
      return
    }

    if (pooled && responsesWebSocketPool.get(poolKey) === entry) {
      scheduleResponsesWebSocketIdleClose(poolKey, entry)
      return
    }

    removeResponsesWebSocketPoolEntry(poolKey, entry)
  }
}

const getReadyResponsesWebSocket = async (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
  pooled: boolean,
): Promise<InstanceType<typeof WebSocket>> => {
  if (entry.closed) {
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  const websocket = await entry.websocketPromise
  if (
    isResponsesWebSocketEntryClosed(entry)
    || (pooled && responsesWebSocketPool.get(poolKey) !== entry)
  ) {
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  if (websocket.readyState !== WebSocket.OPEN) {
    removeResponsesWebSocketPoolEntry(poolKey, entry)
    throw new Error(
      "Responses websocket became unavailable before the request started",
    )
  }

  return websocket
}

const scheduleResponsesWebSocketIdleClose = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
): void => {
  clearResponsesWebSocketIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    removeResponsesWebSocketPoolEntry(poolKey, entry)
  }, RESPONSES_WEBSOCKET_IDLE_TIMEOUT_MS)
  unrefTimer(entry.idleTimer)
}

const clearResponsesWebSocketIdleTimer = (
  entry: ResponsesWebSocketEntry,
): void => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

const getResponsesWebSocketActiveRequestCount = (poolKey: string): number =>
  responsesWebSocketActiveRequests.get(poolKey) ?? 0

const incrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  responsesWebSocketActiveRequests.set(
    poolKey,
    getResponsesWebSocketActiveRequestCount(poolKey) + 1,
  )
}

const decrementResponsesWebSocketActiveRequestCount = (
  poolKey: string,
): void => {
  const nextCount = getResponsesWebSocketActiveRequestCount(poolKey) - 1
  if (nextCount <= 0) {
    responsesWebSocketActiveRequests.delete(poolKey)
    return
  }

  responsesWebSocketActiveRequests.set(poolKey, nextCount)
}

const removeResponsesWebSocketPoolEntry = (
  poolKey: string,
  entry: ResponsesWebSocketEntry,
): void => {
  if (responsesWebSocketPool.get(poolKey) === entry) {
    responsesWebSocketPool.delete(poolKey)
  }

  if (entry.closed) {
    return
  }

  entry.closed = true
  clearResponsesWebSocketIdleTimer(entry)
  entry.websocketPromise.then(closeResponsesWebSocket).catch(() => {})
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object"
    && "unref" in timer
    && typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

const createResponsesWebSocketError = (
  message: string,
  event?: Pick<ResponsesWebSocketErrorEvent, "error" | "message">,
): Error => {
  const reason = event?.error ?? event?.message
  if (reason === undefined || reason === "") {
    return new Error(message)
  }

  const cause = toError(reason)
  return new Error(`${message}: ${cause.message}`, { cause })
}

const openResponsesWebSocket = async ({
  headers,
  url,
}: {
  headers: Record<string, string>
  url: string
}): Promise<InstanceType<typeof WebSocket>> =>
  await new Promise((resolve, reject) => {
    const dispatcher = getProxyEnvDispatcher()
    const init = dispatcher ? { dispatcher, headers } : { headers }
    const websocket = new WebSocket(url, init)

    const cleanup = () => {
      websocket.removeEventListener("open", onOpen)
      websocket.removeEventListener("error", onError)
    }

    const onOpen = () => {
      cleanup()
      resolve(websocket)
    }

    const onError = (event: ResponsesWebSocketErrorEvent) => {
      cleanup()
      reject(
        createResponsesWebSocketError(
          "Failed to create responses websocket",
          event,
        ),
      )
    }

    websocket.addEventListener("open", onOpen)
    websocket.addEventListener("error", onError)
  })

const createWebSocketMessageStream = async function* (
  websocket: InstanceType<typeof WebSocket>,
): AsyncIterable<string> {
  const queue: Array<Promise<string>> = []
  const streamState: {
    closed: boolean
    error: Error | null
    notify: (() => void) | null
  } = {
    closed: false,
    error: null,
    notify: null,
  }

  const wake = () => {
    streamState.notify?.()
    streamState.notify = null
  }

  const onMessage = (event: { data: unknown }) => {
    queue.push(normalizeWebSocketMessageData(event.data))
    wake()
  }

  const onClose = () => {
    streamState.closed = true
    wake()
  }

  const onError = (event: ResponsesWebSocketErrorEvent) => {
    streamState.error = createResponsesWebSocketError(
      "Responses websocket stream error",
      event,
    )
    wake()
  }

  websocket.addEventListener("message", onMessage)
  websocket.addEventListener("close", onClose)
  websocket.addEventListener("error", onError)

  try {
    while (true) {
      const item = queue.shift()
      if (item) {
        yield await item
        continue
      }

      if (streamState.error) {
        throw toError(streamState.error)
      }

      if (streamState.closed) {
        break
      }

      await new Promise<void>((resolve) => {
        streamState.notify = resolve
      })
    }
  } finally {
    websocket.removeEventListener("message", onMessage)
    websocket.removeEventListener("close", onClose)
    websocket.removeEventListener("error", onError)
  }
}

const normalizeWebSocketMessageData = async (
  data: unknown,
): Promise<string> => {
  if (typeof data === "string") {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }

  if (ArrayBuffer.isView(data)) {
    const view = data
    return new TextDecoder().decode(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    )
  }

  if (isTextReadable(data)) {
    return await data.text()
  }

  return String(data)
}

const isTextReadable = (
  value: unknown,
): value is { text: () => Promise<string> } => {
  if (!value || typeof value !== "object" || !("text" in value)) {
    return false
  }

  return typeof (value as { text?: unknown }).text === "function"
}

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }

  return new Error(String(value))
}

const getHeaderValue = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalizedHeaderName = headerName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return match?.[1]
}

const encodePoolKeyPart = (value: string): string => encodeURIComponent(value)

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
      id?: unknown
      type?: unknown
    }
    if (parsed.type === "response.completed") {
      logCopilotQuotaSnapshots(parsed.copilot_quota_snapshots)
    }
    return {
      data: JSON.stringify(parsed),
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}

const isTerminalResponsesStreamChunk = (chunk: { data?: string }): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
  }
}

const consumeResponsesWebSocketStream = async (
  stream: ResponsesStream,
): Promise<ResponsesResult> => {
  for await (const chunk of stream) {
    if (!chunk.data || chunk.data === "[DONE]") {
      continue
    }

    const event = JSON.parse(chunk.data) as ResponseStreamEvent
    if (event.type === "error") {
      throw new Error(event.message)
    }

    if (
      event.type === "response.completed"
      || event.type === "response.failed"
      || event.type === "response.incomplete"
    ) {
      return event.response
    }
  }

  throw new Error("Responses websocket ended without a terminal response")
}

const closeResponsesWebSocket = (
  websocket: InstanceType<typeof WebSocket>,
): void => {
  if (
    websocket.readyState === WebSocket.CONNECTING
    || websocket.readyState === WebSocket.OPEN
  ) {
    websocket.close()
  }
}
