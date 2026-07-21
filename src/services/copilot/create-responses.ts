import consola from "consola"
import { events, type ServerSentEventMessage } from "fetch-event-stream"
import { createHash } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
  resolveInteractionInitiator,
} from "~/lib/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import { getResponsesWebSocketResourceLimits } from "~/lib/config"
import {
  logCopilotRateLimits,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { logDiagnosticEvent } from "~/lib/logger"
import type { GatewayReasoningEffort } from "~/lib/reasoning-effort"
import { responsesDiagnosticsLogger } from "~/lib/responses-diagnostic-logger"
import { isResponsesStreamTerminalData } from "~/lib/responses-stream-protocol"
import {
  createResponsesTransportErrorDiagnostic,
  createResponsesUpstreamErrorDiagnostic,
  summarizeResponsesPayload,
} from "~/lib/responses-diagnostics"
import {
  createStreamRetryBudget,
  reportStreamTermination,
  RetryableStreamTransportError,
  StreamLifecycleError,
  superviseStream,
  type StreamRetryBudget,
} from "~/lib/stream-lifecycle"
import {
  fetchWithUpstreamLifecycle,
  UpstreamLifecycleTimeoutError,
  type UpstreamFetch,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createPooledWebSocketIdentity,
  createWebSocketUrl,
  isWebSocketNotSentError,
  type PooledWebSocketRequest,
} from "~/services/responses-websocket"
import { projectResponsesWebSocketChunk } from "~/services/responses-websocket-chunk"
import {
  createReasoningRecoveryScope,
  responsesReasoningRecoveryRegistry,
  type ReasoningRecoveryScope,
} from "~/services/copilot/responses-reasoning-recovery-registry"
import {
  admitResponsesWirePayload,
  isResponsesWireArtifact,
  prepareResponsesWirePayload,
  prepareResponsesWirePayloadWithSummary,
  type ResponsesWireArtifact,
  type ResponsesWireSerializationObserver,
} from "~/services/copilot/responses-wire-artifact"

const CONNECTION_OWNERSHIP_ERROR =
  "input item does not belong to this connection"

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem>
  tools?: Array<Tool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  max_tool_calls?: number | null
  metadata?: Metadata | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_options?: {
    mode: "implicit" | "explicit"
    ttl?: "30m" | null
  } | null
  prompt_cache_retention?: "in_memory" | "24h" | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  reasoning?: Reasoning | null
  text?: {
    format?: {
      type: "json_schema"
      name: string
      strict: boolean
      schema: { [key: string]: unknown }
    } | null
    [key: string]: unknown
  } | null
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
  | "web_search_call.results"
  | "web_search_call.action.sources"
  | "message.input_image.image_url"
  | "computer_call_output.output.image_url"
  | "reasoning.encrypted_content"
  | "code_interpreter_call.outputs"
  | "message.output_text.logprobs"

export interface Reasoning {
  effort?: GatewayReasoningEffort | null
  summary?: "auto" | "concise" | "detailed" | null
  context?: "auto" | "current_turn" | "all_turns" | null
}

export interface ResponseContextManagementCompactionItem {
  type: "compaction"
  compact_threshold: number
}

export type ResponseContextManagementItem =
  ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  id?: string
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
  summary?: Array<ResponseReasoningBlock>
  encrypted_content: string
  [key: string]: unknown
}

export interface ResponseInputCompaction {
  id: string
  type: "compaction"
  encrypted_content: string
}

export interface ResponseInputCompactionTrigger {
  type: "compaction_trigger"
}

export interface ResponseInputAdditionalTools {
  id?: string
  role: "developer"
  tools: Array<Tool>
  type: "additional_tools"
}

export interface ResponseInputComputerCallOutput {
  type: "computer_call_output"
  call_id: string
  output: ResponseComputerCallOutputScreenshot
  id?: string | null
  status?: "in_progress" | "completed" | "incomplete" | null
}

export interface ResponseComputerCallOutputScreenshot {
  type: "computer_screenshot"
  file_id?: string | null
  image_url?: string | null
}

export interface ResponseInputImageGenerationCall {
  id: string
  type: "image_generation_call"
  result: string | null
  status: "in_progress" | "completed" | "generating" | "failed"
}

export interface ResponseInputCodeInterpreterCall {
  id: string
  type: "code_interpreter_call"
  code: string | null
  container_id: string
  outputs: Array<ResponseCodeInterpreterOutput> | null
  status: "in_progress" | "completed" | "incomplete" | "interpreting" | "failed"
}

export type ResponseCodeInterpreterOutput =
  | { type: "logs"; logs: string }
  | { type: "image"; url: string }

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseToolSearchCallItem
  | ResponseToolSearchOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | ResponseInputCompactionTrigger
  | ResponseInputAdditionalTools
  | ResponseInputComputerCallOutput
  | ResponseInputImageGenerationCall
  | ResponseInputCodeInterpreterCall
  | Record<string, unknown>

export type ResponseInputContent =
  | ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  type: "input_text" | "output_text"
  text: string
  prompt_cache_breakpoint?: { mode: "explicit" } | null
}

export interface ResponseInputImage {
  type: "input_image"
  image_url?: string | null
  file_id?: string | null
  detail: "low" | "high" | "auto" | "original"
  prompt_cache_breakpoint?: { mode: "explicit" } | null
}

export interface ResponseInputFile {
  type: "input_file"
  detail?: "auto" | "low" | "high"
  file_data?: string | null
  file_id?: string | null
  filename?: string | null
  file_url?: string | null
  prompt_cache_breakpoint?: { mode: "explicit" } | null
}

export interface ResponsesResult {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  copilot_usage?: CopilotUsage | null
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

export interface CopilotUsage {
  total_nano_aiu?: number | null
}

export type Metadata = { [key: string]: string }

export interface IncompleteDetails {
  reason?: "max_output_tokens" | "content_filter"
}

export interface ResponseError {
  code: string | null
  message: string
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputToolSearchCall
  | ResponseOutputToolSearchOutput
  | ResponseOutputWebSearchCall
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
  [key: string]: unknown
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

export interface ResponseOutputWebSearchCall {
  id?: string
  type: "web_search_call"
  action?: {
    query?: string
    queries?: Array<string>
    sources?: Array<{ type?: "url"; url: string }>
    type?: string
    url?: string
    pattern?: string
  }
  status?: "in_progress" | "searching" | "completed" | "failed"
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
    cache_write_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent =
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseContentPartAddedEvent
  | ResponseOutputTextAnnotationAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseWebSearchCallInProgressEvent
  | ResponseWebSearchCallSearchingEvent
  | ResponseWebSearchCallCompletedEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseRefusalDeltaEvent
  | ResponseRefusalDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.completed"
}

export interface ResponseIncompleteEvent {
  copilot_usage?: CopilotUsage | null
  response: ResponsesResult
  sequence_number: number
  type: "response.incomplete"
}

export interface ResponseCreatedEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.created"
}

export interface ResponseInProgressEvent {
  response: ResponsesResult
  sequence_number: number
  type: "response.in_progress"
}

export interface ResponseErrorEvent {
  code: string | null
  copilot_usage?: CopilotUsage | null
  message: string
  param: string | null
  sequence_number: number
  type: "error"
  error?: {
    type?: string | null
    code: string | null
    message: string
  }
  status_code?: number
  headers?: Record<string, string>
  usage?: ResponseUsage | null
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
  copilot_usage?: CopilotUsage | null
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

export interface ResponseContentPartAddedEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.added"
}

export interface ResponseOutputTextAnnotationAddedEvent {
  annotation: unknown
  annotation_index?: number
  content_index: number
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.output_text.annotation.added"
}

export interface ResponseContentPartDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  part: ResponseOutputContentBlock
  sequence_number: number
  type: "response.content_part.done"
}

export interface ResponseWebSearchCallInProgressEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.in_progress"
}

export interface ResponseWebSearchCallSearchingEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.searching"
}

export interface ResponseWebSearchCallCompletedEvent {
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.web_search_call.completed"
}

export interface ResponseReasoningSummaryPartAddedEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.added"
}

export interface ResponseReasoningSummaryPartDoneEvent {
  item_id: string
  output_index: number
  part: ResponseReasoningBlock
  sequence_number: number
  summary_index: number
  type: "response.reasoning_summary_part.done"
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

export interface ResponseRefusalDeltaEvent {
  content_index: number
  delta: string
  item_id: string
  output_index: number
  sequence_number: number
  type: "response.refusal.delta"
}

export interface ResponseRefusalDoneEvent {
  content_index: number
  item_id: string
  output_index: number
  refusal: string
  sequence_number: number
  type: "response.refusal.done"
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

export type ResponsesStream = AsyncIterable<ServerSentEventMessage>
export type CreateResponsesReturn = ResponsesResult | ResponsesStream
export type ResponsesTransport = "http" | "websocket"

type ResponsesStreamChunk = {
  data?: string
  event?: string
  id?: string | number
}

interface ResponsesRequestOptions {
  allowHttpFallback?: boolean
  fetcher?: UpstreamFetch
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId: string
  reasoningRecoverySessionId?: string
  sessionId?: string
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
  compactType?: CompactType
  transport?: ResponsesTransport
  wireArtifact?: ResponsesWireArtifact
  wireSerializationObserver?: ResponsesWireSerializationObserver
}

const resolveResponsesTransport = (
  payload: ResponsesPayload,
  requestedTransport: ResponsesTransport,
  compactType?: CompactType,
): ResponsesTransport =>
  payload.stream !== true || compactType === COMPACT_REQUEST ?
    "http"
  : requestedTransport

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    allowHttpFallback = false,
    fetcher,
    initiator: requestedInitiator,
    subagentMarker,
    requestId,
    reasoningRecoverySessionId,
    sessionId,
    signal,
    timeouts,
    compactType,
    transport = "http",
    wireArtifact,
    wireSerializationObserver,
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  const initiator = resolveInteractionInitiator({
    compactType,
    initiator: requestedInitiator,
    isSubagent: Boolean(subagentMarker),
  })

  if (wireArtifact) {
    if (!isResponsesWireArtifact(wireArtifact)) {
      throw new TypeError("Invalid Responses wire artifact")
    }
    if (wireArtifact.summary.initiator !== initiator) {
      throw new TypeError(
        "Responses wire artifact initiator does not match the request",
      )
    }
    payload = wireArtifact.payload
    const actualTransport = resolveResponsesTransport(
      payload,
      transport,
      compactType,
    )
    if (wireArtifact.transport !== actualTransport) {
      throw new TypeError(
        "Responses wire artifact transport does not match the request",
      )
    }
  }
  const preparationReasoningRecoveryScope = createReasoningRecoveryScope({
    agentId: subagentMarker?.agent_id,
    agentType: subagentMarker?.agent_type,
    model: payload.model,
    sessionId: reasoningRecoverySessionId ?? subagentMarker?.session_id,
  })
  if (!wireArtifact) {
    const preparation = prepareResponsesWirePayloadWithSummary(payload, {
      reasoningRecoveryScope: preparationReasoningRecoveryScope,
    })
    if (preparation.removedReasoningItems > 0) {
      consola.debug("responses.reasoning_history_prefilter", {
        model: payload.model,
        reason: "known_incompatible_reasoning_history",
        removedReasoningItems: preparation.removedReasoningItems,
        subagent: Boolean(subagentMarker),
      })
    }
    payload = preparation.payload
    wireArtifact = admitResponsesWirePayload(
      payload,
      initiator,
      resolveResponsesTransport(payload, transport, compactType),
      { observer: wireSerializationObserver },
    )
    payload = wireArtifact.payload
  }
  const reasoningRecoveryScope = createReasoningRecoveryScope({
    agentId: subagentMarker?.agent_id,
    agentType: subagentMarker?.agent_type,
    model: wireArtifact.payload.model,
    sessionId: reasoningRecoverySessionId ?? subagentMarker?.session_id,
  })
  const transportRetryBudget =
    payload.stream === true ? createStreamRetryBudget() : undefined

  const headers: Record<string, string> = {
    ...copilotHeaders(state, requestId, vision),
    "x-initiator": initiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  prepareForCompact(headers, compactType)

  consola.log(`<-- model: ${payload.model}`)

  const effectiveTransport = wireArtifact.transport

  if (state.verbose) {
    const outgoing = summarizeResponsesPayload(payload, {
      includePayloadBytes: false,
    })
    logDiagnosticEvent(
      responsesDiagnosticsLogger,
      "debug",
      "responses.upstream_request",
      {
        assistantMessages: outgoing.roleCounts.assistant,
        compactThreshold: outgoing.compactThreshold,
        compactionItems: outgoing.inputTypeCounts.compaction,
        compactionTriggerItems: outgoing.inputTypeCounts.compaction_trigger,
        contextManagementItems: outgoing.contextManagementItems,
        developerMessages: outgoing.roleCounts.developer,
        functionOutputItems: outgoing.inputTypeCounts.function_call_output,
        inputItems: outgoing.inputItems,
        instructionsBytes: outgoing.instructionsBytes,
        messageItems: outgoing.inputTypeCounts.message,
        model: outgoing.model,
        payloadBytes:
          effectiveTransport === "websocket" ?
            wireArtifact.summary.websocketFrameBytes
          : wireArtifact.summary.httpBodyBytes,
        reasoningItems: outgoing.inputTypeCounts.reasoning,
        requestId,
        sessionId,
        stream: outgoing.stream,
        systemMessages: outgoing.roleCounts.system,
        toolCount: outgoing.toolCount,
        transport: effectiveTransport,
        userMessages: outgoing.roleCounts.user,
        visionItems: outgoing.visionItems,
      },
    )
  }

  if (payload.stream === true && effectiveTransport === "websocket") {
    const websocketRequest = prepareResponsesWebSocketRequest(
      wireArtifact,
      headers,
      {
        reasoningRecoverySessionId,
        requestId,
        signal,
        subagentMarker,
        timeouts,
        vision,
      },
    )
    const websocketStream =
      createPooledResponsesWebSocketStream(websocketRequest)
    const transportStream = createResponsesStreamWithHttpFallback(
      websocketStream,
      {
        allowHttpFallback,
        fetcher,
        headers,
        reasoningRecoveryScope,
        retryBudget: transportRetryBudget,
        signal,
        timeouts,
        wireArtifact,
        wireSerializationObserver,
      },
    )
    return createResponsesSafeStream(transportStream, signal)
  }

  if (payload.stream === true) {
    const httpOptions = {
      fetcher,
      headers,
      reasoningRecoveryScope,
      retryBudget: transportRetryBudget,
      signal,
      timeouts,
      wireArtifact,
      wireSerializationObserver,
    }
    let primaryStream: AsyncIterable<ResponsesStreamChunk>
    try {
      primaryStream = await createHttpResponsesStream(httpOptions)
    } catch (error) {
      if (error instanceof StreamLifecycleError) {
        return createResponsesSafeStream(
          createFailedResponsesStream(error),
          signal,
        )
      }
      throw error
    }
    return createResponsesSafeStream(
      createSupervisedHttpResponsesStream(httpOptions, primaryStream),
      signal,
    )
  }

  return await createHttpResponses(headers, {
    fetcher,
    reasoningRecoveryScope,
    signal,
    timeouts,
    wireArtifact,
    wireSerializationObserver,
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export {
  buildResponsesWebSocketPayload,
  ensureEncryptedReasoningIncluded,
} from "~/services/copilot/responses-wire-artifact"

interface HttpResponsesOptions {
  fetcher?: UpstreamFetch
  reasoningRecoveryAttempted?: boolean
  reasoningRecoveryScope?: ReasoningRecoveryScope | null
  retryBudget?: StreamRetryBudget
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
  wireArtifact: ResponsesWireArtifact
  wireSerializationObserver?: ResponsesWireSerializationObserver
}

interface HttpResponsesStreamOptions extends HttpResponsesOptions {
  headers: Record<string, string>
}

interface WebSocketResponsesStreamOptions extends HttpResponsesStreamOptions {
  allowHttpFallback: boolean
}

interface ResponsesUpstreamFailure {
  code: string | null
  message: string
  status?: number
}

type ResponsesRecoveryReason = "incompatible_reasoning_history"

interface ResponsesReasoningRecoveryPlan {
  payload: ResponsesPayload
  reason: ResponsesRecoveryReason
  rejectedInput: Array<ResponseInputItem>
  removedReasoningItems: number
  sourceTransport: ResponsesTransport
}

const createHttpResponses = async (
  headers: Record<string, string>,
  options: HttpResponsesOptions,
): Promise<CreateResponsesReturn> => {
  const payload = options.wireArtifact.payload
  let response: Response
  try {
    response = await fetchWithUpstreamLifecycle(
      `${copilotBaseUrl(state)}/responses`,
      {
        method: "POST",
        headers,
        body: options.wireArtifact.httpBody,
      },
      {
        fetcher: options.fetcher,
        signal: options.signal,
        timeouts: options.timeouts,
      },
    )
  } catch (error) {
    if (!options.signal?.aborted) {
      logDiagnosticEvent(
        responsesDiagnosticsLogger,
        "error",
        "responses.transport_error",
        createResponsesTransportErrorDiagnostic({
          error,
          payload,
          requestHeaders: headers,
          transport: "http",
        }),
      )
    }
    if (payload.stream === true && options.retryBudget) {
      throw reportStreamTermination({
        diagnostics: {
          elapsedMs: Date.now() - options.retryBudget.startedAt,
          eventCount: 0,
          flow: "responses",
          lastEventType: null,
          retryCount: options.retryBudget.attempted ? 1 : 0,
          terminalSeen: false,
          transport: "http",
        },
        error,
        signal: options.signal,
      })
    }
    throw error
  }

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    const failure = await readResponsesHttpFailure(response)
    const recoveryPlan = planResponsesReasoningHistoryRecovery({
      attempted: options.reasoningRecoveryAttempted ?? false,
      canRetryHttp: true,
      failure,
      forwardedChunk: false,
      payload,
      signalAborted: options.signal?.aborted ?? false,
      sourceTransport: "http",
    })
    const recovery =
      recoveryPlan ?
        await executeResponsesReasoningHistoryRecovery(
          recoveryPlan,
          headers,
          options,
        )
      : null
    if (recovery) {
      return recovery
    }

    logDiagnosticEvent(
      responsesDiagnosticsLogger,
      "error",
      "responses.upstream_error",
      createResponsesUpstreamErrorDiagnostic({
        failure: failure ?? {
          code: null,
          message: "unparsed upstream error",
        },
        payload,
        payloadBytes: options.wireArtifact.summary.httpBodyBytes,
        requestHeaders: headers,
        responseHeaders: response.headers,
        status: response.status,
        transport: "http",
      }),
    )
    throw new HTTPError(
      failure?.message ?
        `Failed to create responses: ${failure.message}`
      : "Failed to create responses",
      response,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}

type ResponsesWebSocketRequest = PooledWebSocketRequest<never>

export const prepareResponsesWebSocketRequest = (
  wireArtifact: ResponsesWireArtifact,
  preparedHeaders: Record<string, string>,
  options: {
    reasoningRecoverySessionId?: string
    requestId: string
    signal?: AbortSignal
    subagentMarker?: SubagentMarker | null
    timeouts?: UpstreamLifecycleTimeouts
    vision?: boolean
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)
  const websocketHeaders = copilotWebSocketHeaders(preparedHeaders)
  if (
    wireArtifact.transport !== "websocket"
    || wireArtifact.websocketFrame === undefined
  ) {
    throw new TypeError(
      "Responses websocket request requires a websocket wire artifact",
    )
  }
  if (wireArtifact.summary.initiator !== initiator) {
    throw new TypeError(
      "Responses websocket headers do not match the admitted initiator",
    )
  }
  const payload = wireArtifact.payload

  return {
    headers: websocketHeaders,
    identity: buildResponsesWebSocketIdentity(payload, {
      ...options,
      websocketHeaders,
    }),
    signal: options.signal,
    timeouts: options.timeouts,
    frame: wireArtifact.websocketFrame,
    resourceLimits: getResponsesWebSocketResourceLimits(),
    url: buildResponsesWebSocketUrl(copilotBaseUrl(state)),
  }
}

export const buildResponsesWebSocketIdentity = (
  payload: ResponsesPayload,
  {
    reasoningRecoverySessionId,
    requestId,
    subagentMarker,
    vision = false,
    websocketHeaders,
  }: {
    reasoningRecoverySessionId?: string
    requestId: string
    subagentMarker?: SubagentMarker | null
    vision?: boolean
    websocketHeaders?: Record<string, string>
  },
) => {
  const accountIdentity =
    state.userName ?? state.githubToken ?? state.copilotToken
  const accountFingerprint =
    accountIdentity ?
      createHash("sha256").update(accountIdentity).digest("hex").slice(0, 16)
    : "missing-account"
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
  const sessionKey = reasoningRecoverySessionId ?? requestId
  const visionKey = vision ? "vision" : "text-only"
  const headerFingerprint =
    createResponsesWebSocketHeaderFingerprint(websocketHeaders)

  return createPooledWebSocketIdentity({
    accountFingerprint,
    origin: copilotBaseUrl(state),
    poolScope: [
      tokenFingerprint,
      payload.model,
      sessionKey,
      subagentKey,
      visionKey,
      headerFingerprint,
    ],
    provider: "copilot",
  })
}

const VOLATILE_WEBSOCKET_POOL_HEADERS = new Set([
  "authorization",
  "x-agent-task-id",
  "x-interaction-id",
  "x-request-id",
])

const createResponsesWebSocketHeaderFingerprint = (
  headers: Record<string, string> | undefined,
): string => {
  if (!headers) return "default-headers"

  const stableHeaders = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !VOLATILE_WEBSOCKET_POOL_HEADERS.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256")
    .update(JSON.stringify(stableHeaders))
    .digest("hex")
    .slice(0, 16)
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
): AsyncIterable<ResponsesStreamChunk> =>
  createPooledWebSocketStream(request, {
    createChunk: createResponsesWebSocketStreamChunk,
    isReusableTerminalChunk: (chunk) => chunk.event !== "error",
    isTerminalChunk: isTerminalResponsesStreamChunk,
    openErrorMessage: "Failed to create responses websocket",
    streamErrorMessage: "Responses websocket stream error",
    terminalChunkMissingMessage:
      "Responses websocket ended without a terminal response",
  })

const createResponsesStreamWithHttpFallback = (
  websocketStream: AsyncIterable<ResponsesStreamChunk>,
  options: WebSocketResponsesStreamOptions,
): AsyncIterable<ResponsesStreamChunk> =>
  superviseStream({
    flow: "responses",
    getEventType: (chunk) => chunk.event ?? null,
    isTerminalEvent: isTerminalResponsesStreamChunk,
    primary: {
      open: () =>
        createRetryableResponsesWebSocketStream(websocketStream, options),
      transport: "websocket",
    },
    retry:
      options.allowHttpFallback ?
        {
          open: () => createHttpResponsesStream(options),
          transport: "http",
        }
      : undefined,
    retryBudget: options.retryBudget,
    signal: options.signal,
  })

const createRetryableResponsesWebSocketStream = async function* (
  websocketStream: AsyncIterable<ResponsesStreamChunk>,
  options: WebSocketResponsesStreamOptions,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  try {
    let forwardedChunk = false
    for await (const chunk of websocketStream) {
      const failure = parseResponsesStreamFailure(chunk)
      const recoveryPlan = planResponsesReasoningHistoryRecovery({
        attempted: false,
        canRetryHttp: options.allowHttpFallback,
        failure,
        forwardedChunk,
        payload: options.wireArtifact.payload,
        signalAborted: options.signal?.aborted ?? false,
        sourceTransport: "websocket",
      })
      const recovery =
        recoveryPlan ?
          await executeResponsesReasoningHistoryRecovery(
            recoveryPlan,
            options.headers,
            {
              reasoningRecoveryScope: options.reasoningRecoveryScope,
              retryBudget: options.retryBudget,
              signal: options.signal,
              timeouts: options.timeouts,
              wireArtifact: options.wireArtifact,
              wireSerializationObserver: options.wireSerializationObserver,
            },
          )
        : null

      if (recovery) {
        if (!isResponsesStream(recovery)) {
          throw new Error(
            "Streaming reasoning recovery returned a non-streaming response",
          )
        }
        yield* recovery
        return
      }

      if (
        options.allowHttpFallback
        && !forwardedChunk
        && !options.signal?.aborted
        && failure?.code === "internal_error"
      ) {
        throw new RetryableStreamTransportError(
          `Responses websocket returned internal_error: ${failure.message}`,
        )
      }

      if (failure) {
        logDiagnosticEvent(
          responsesDiagnosticsLogger,
          "error",
          "responses.upstream_error",
          createResponsesUpstreamErrorDiagnostic({
            failure,
            payload: options.wireArtifact.payload,
            payloadBytes: options.wireArtifact.summary.websocketFrameBytes,
            requestHeaders: options.headers,
            status: failure.status,
            transport: "websocket",
          }),
        )
      }

      forwardedChunk = true
      yield chunk
    }
  } catch (error) {
    if (!options.signal?.aborted) {
      logDiagnosticEvent(
        responsesDiagnosticsLogger,
        "warn",
        "responses.transport_error",
        createResponsesTransportErrorDiagnostic({
          error,
          payload: options.wireArtifact.payload,
          requestHeaders: options.headers,
          transport: "websocket",
        }),
      )
    }
    if (isWebSocketNotSentError(error)) {
      throw new RetryableStreamTransportError(error.message, error)
    }
    throw error
  }
}

const createHttpResponsesStream = async (
  options: HttpResponsesStreamOptions,
): Promise<AsyncIterable<ResponsesStreamChunk>> => {
  const response = await createHttpResponses(options.headers, {
    reasoningRecoveryAttempted: options.reasoningRecoveryAttempted,
    reasoningRecoveryScope: options.reasoningRecoveryScope,
    retryBudget: options.retryBudget,
    signal: options.signal,
    timeouts: options.timeouts,
    wireArtifact: options.wireArtifact,
    wireSerializationObserver: options.wireSerializationObserver,
  })
  if (!isResponsesStream(response)) {
    throw new Error("Streaming HTTP attempt returned a non-streaming response")
  }
  return response
}

const createSupervisedHttpResponsesStream = (
  options: HttpResponsesStreamOptions,
  primaryStream?: AsyncIterable<ResponsesStreamChunk>,
): AsyncIterable<ResponsesStreamChunk> =>
  superviseStream({
    flow: "responses",
    getEventType: (chunk) => chunk.event ?? null,
    isTerminalEvent: isTerminalResponsesStreamChunk,
    primary: {
      open: () => primaryStream ?? createHttpResponsesStream(options),
      transport: "http",
    },
    retryBudget: options.retryBudget,
    signal: options.signal,
  })

const parseResponsesStreamFailure = (
  chunk: ResponsesStreamChunk,
): ResponsesUpstreamFailure | null => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return null
  }

  try {
    return normalizeResponsesUpstreamFailure(JSON.parse(chunk.data))
  } catch {
    return null
  }
}

const readResponsesHttpFailure = async (
  response: Response,
): Promise<ResponsesUpstreamFailure | null> => {
  try {
    const failure = normalizeResponsesUpstreamFailure(
      JSON.parse(await response.clone().text()),
    )
    return failure ? { ...failure, status: response.status } : null
  } catch (error) {
    if (
      error instanceof UpstreamLifecycleTimeoutError
      || (error instanceof Error && error.name === "AbortError")
    ) {
      throw error
    }
    return null
  }
}

const normalizeResponsesUpstreamFailure = (
  value: unknown,
): ResponsesUpstreamFailure | null => {
  if (!isRecord(value)) {
    return null
  }

  const error = isRecord(value.error) ? value.error : value
  if (typeof error.message !== "string" || error.message.length === 0) {
    return null
  }

  return {
    code: typeof error.code === "string" ? error.code : null,
    message: error.message,
  }
}

const planResponsesReasoningHistoryRecovery = ({
  attempted,
  canRetryHttp,
  failure,
  forwardedChunk,
  payload,
  signalAborted,
  sourceTransport,
}: {
  attempted: boolean
  canRetryHttp: boolean
  failure: ResponsesUpstreamFailure | null
  forwardedChunk: boolean
  payload: ResponsesPayload
  signalAborted: boolean
  sourceTransport: ResponsesTransport
}): ResponsesReasoningRecoveryPlan | null => {
  if (
    attempted
    || !canRetryHttp
    || forwardedChunk
    || signalAborted
    || failure?.message !== CONNECTION_OWNERSHIP_ERROR
  ) {
    return null
  }

  const recoveryPayload = withoutHistoricalReasoning(payload)
  if (
    !recoveryPayload
    || !Array.isArray(payload.input)
    || !Array.isArray(recoveryPayload.input)
  ) {
    return null
  }

  return {
    payload: recoveryPayload,
    reason: "incompatible_reasoning_history",
    rejectedInput: payload.input,
    removedReasoningItems: payload.input.length - recoveryPayload.input.length,
    sourceTransport,
  }
}

const executeResponsesReasoningHistoryRecovery = async (
  plan: ResponsesReasoningRecoveryPlan,
  headers: Record<string, string>,
  options: HttpResponsesOptions,
): Promise<CreateResponsesReturn> => {
  responsesReasoningRecoveryRegistry.rememberRejected(
    options.reasoningRecoveryScope ?? null,
    plan.rejectedInput,
  )
  consola.warn("responses.reasoning_history_recovery", {
    reason: plan.reason,
    removedReasoningItems: plan.removedReasoningItems,
    retryTransport: "http",
    sourceTransport: plan.sourceTransport,
  })
  const recoveryPayload = prepareResponsesWirePayload(plan.payload)
  const recoveryWireArtifact = admitResponsesWirePayload(
    recoveryPayload,
    getResponsesWebSocketInitiator(headers),
    "http",
    {
      observer: options.wireSerializationObserver,
      payloadStage: "recovery_http_body",
    },
  )
  const recoveryOptions: HttpResponsesStreamOptions = {
    ...options,
    headers,
    reasoningRecoveryAttempted: true,
    wireArtifact: recoveryWireArtifact,
  }
  if (recoveryWireArtifact.payload.stream === true) {
    if (plan.sourceTransport === "http") {
      const primaryStream = await createHttpResponsesStream(recoveryOptions)
      return createSupervisedHttpResponsesStream(recoveryOptions, primaryStream)
    }
    return createSupervisedHttpResponsesStream(recoveryOptions)
  }
  return await createHttpResponses(headers, recoveryOptions)
}

const createFailedResponsesStream = (
  error: StreamLifecycleError,
): AsyncIterable<ResponsesStreamChunk> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.reject(error),
  }),
})

const withoutHistoricalReasoning = (
  payload: ResponsesPayload,
): ResponsesPayload | null => {
  if (!Array.isArray(payload.input)) {
    return null
  }

  const input = payload.input.filter(
    (item) => !isRecord(item) || item.type !== "reasoning",
  )
  if (input.length === payload.input.length) {
    return null
  }

  return { ...payload, input }
}

const createResponsesSafeStream = async function* (
  source: AsyncIterable<ResponsesStreamChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    if (
      signal?.aborted
      || (error instanceof StreamLifecycleError
        && error.kind === "client_abort")
    ) {
      return
    }
    yield createResponsesErrorServerSentEventChunk(getErrorMessage(error))
  }
}

const isResponsesStream = (value: unknown): value is ResponsesStream =>
  Boolean(value)
  && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  return createWebSocketUrl(`${baseUrl.replace(/\/+$/u, "")}/responses`)
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

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } =>
  projectResponsesWebSocketChunk(data, {
    normalizeError: normalizeCopilotResponsesWebSocketError,
  })

const normalizeCopilotResponsesWebSocketError = (
  event: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isRecord(event.error)) return event
  consola.warn("Copilot responses websocket stream error:", event.error)
  return {
    ...event,
    code: event.error.code,
    message: event.error.message,
  }
}

const isTerminalResponsesStreamChunk = (chunk: { data?: string }): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  return isResponsesStreamTerminalData(chunk.data)
}

const createResponsesErrorServerSentEventChunk = (
  message: string,
): ResponsesStreamChunk => {
  const errorEvent: ResponseErrorEvent = {
    code: null,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}
