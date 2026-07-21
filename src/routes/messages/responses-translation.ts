import {
  BRIDGE_TOOL_SEARCH_NAME,
  formatToolSearchBridgeArguments,
  isBridgeToolSearchName,
  isDeferredToolName,
  listDeferredToolNames,
  normalizeToolSearchBridgeArguments,
  parseMcpToolSearchSentinel,
  selectDeferredToolsByNames,
  shouldEnableResponsesToolSearch,
} from "~/lib/tool-search"
import {
  getExtraPromptForModel,
  getReasoningEffortForModel,
  isGpt56OrAbove,
} from "~/lib/config"
import { requestContext } from "~/lib/request-context"
import { normalizeResponsesUsage } from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  type ResponsesPayload,
  type ResponseInputCompaction,
  type ResponseInputContent,
  type ResponseInputFile,
  type ResponseInputImage,
  type ResponseInputItem,
  type ResponseInputMessage,
  type ResponseInputReasoning,
  type ResponseInputText,
  type ResponsesResult,
  type ResponseOutputContentBlock,
  type ResponseOutputCompaction,
  type ResponseOutputFunctionCall,
  type ResponseOutputToolSearchCall,
  type ResponseOutputItem,
  type ResponseOutputReasoning,
  type ResponseReasoningBlock,
  type ResponseOutputRefusal,
  type ResponseOutputText,
  type ResponseFunctionToolCallItem,
  type ResponseFunctionCallOutputItem,
  type ResponseToolSearchCallItem,
  type ResponseToolSearchOutputItem,
  type Tool,
  type ToolChoiceFunction,
  type ToolChoiceOptions,
} from "~/services/copilot/create-responses"

import {
  isAnthropicDocumentBlock,
  isAnthropicDocumentContainerBlock,
  isAnthropicFileDocumentBlock,
  isAnthropicFileImageBlock,
  isAnthropicCustomTool,
  isAnthropicImageBlock,
  isAnthropicTextBlock,
  isAnthropicToolReferenceBlock,
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicCustomTool,
  type AnthropicDocumentBlock,
  type AnthropicFileDocumentBlock,
  type AnthropicFileImageBlock,
  type AnthropicResponse,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultContentBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { createMessagesInvalidRequestError } from "./invalid-request-error"
import {
  decodeVersionedReasoningCarrier,
  encodeVersionedReasoningCarrier,
  parseLegacyOpenAIReasoningCarrierSignature,
  type ReasoningCarrierEndpoint,
} from "./reasoning-carrier"
import {
  normalizeMessageReasoningEffort,
  type GatewayReasoningEffort,
} from "~/lib/reasoning-effort"
import { normalizeToolSchema } from "./non-stream-translation"
import { assertResponsesResultUsable } from "./responses-result"
import { parseFunctionCallArguments } from "./tool-arguments"
import { validateAnthropicToolResultContent } from "./tool-result-content"
import type { RestoredWebSearchTurn } from "./web-search/carrier-sanitizer"

const MESSAGE_TYPE = "message"
const COMPACTION_SIGNATURE_PREFIX = "cm1#"
const COMPACTION_SIGNATURE_SEPARATOR = "@"

export const THINKING_TEXT = "Thinking..."
export const REASONING_SUMMARY_SEPARATOR = "\u00a0\n\n"
const REASONING_SUMMARY_SEPARATOR_PATTERN = /\u00a0\n\n|\u2063\n\n/

interface ResponsesTranslationPolicy {
  extraPrompt?: string
  reasoningEffort?: GatewayReasoningEffort
  restoredWebSearchTurns?: ReadonlyArray<RestoredWebSearchTurn>
}

const resolveReasoningEffort = (
  payload: AnthropicMessagesPayload,
  policy: ResponsesTranslationPolicy,
) =>
  normalizeMessageReasoningEffort(payload.output_config?.effort)
  ?? policy.reasoningEffort
  ?? getReasoningEffortForModel(payload.model)

export const hasTrailingAssistantPrefill = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const lastMessage = payload.messages.at(-1)
  if (!lastMessage || lastMessage.role !== "assistant") {
    return false
  }

  if (typeof lastMessage.content === "string") {
    return lastMessage.content.length > 0
  }

  return (
    Array.isArray(lastMessage.content)
    && lastMessage.content.some(
      (block) => block.type === "text" && block.text.length > 0,
    )
  )
}

const buildPromptCacheKey = (
  basePromptCacheKey: string | null,
  subagentAgentId?: string | null,
): string | null => {
  if (!basePromptCacheKey) {
    return null
  }

  const normalizedSubagentAgentId = subagentAgentId?.trim() || null
  if (!normalizedSubagentAgentId) {
    return basePromptCacheKey
  }

  return `${basePromptCacheKey}:agent:${normalizedSubagentAgentId}`
}

export const translateAnthropicMessagesToResponsesPayload = (
  payload: AnthropicMessagesPayload,
  subagentAgentId?: string | null,
  carrierTarget: ReasoningCarrierEndpoint = {
    model: payload.model,
    provider: "copilot",
  },
  policy: ResponsesTranslationPolicy = {},
): ResponsesPayload => {
  const input: Array<ResponseInputItem> = []
  const exactRestoredItems = new WeakSet<object>()
  const applyPhase = shouldApplyPhase(payload.model)
  const toolSearchEnabled = shouldEnableResponsesToolSearch({
    model: payload.model,
    tools: payload.tools,
  })
  const translationState: TranslationState = {
    carrierTarget,
    originalTools: payload.tools ?? [],
    toolSearchEnabled,
    toolUseNameById: new Map(),
  }

  const restoredTurnsByMessageIndex = new Map(
    (policy.restoredWebSearchTurns ?? []).map((turn) => [
      turn.messageIndex,
      turn,
    ]),
  )
  for (const [messageIndex, message] of (
    payload.messages as Array<AnthropicMessage>
  ).entries()) {
    const restored = restoredTurnsByMessageIndex.get(messageIndex)
    if (restored) {
      if (message.role !== "assistant") {
        throw createMessagesInvalidRequestError(
          "Restored Web Search history must replace an assistant message.",
        )
      }
      const restoredItems = structuredClone(
        restored.outputItems,
      ) as Array<ResponseInputItem>
      for (const item of restoredItems) {
        if (typeof item === "object" && item !== null) {
          exactRestoredItems.add(item)
        }
      }
      input.push(...restoredItems)
      restoredTurnsByMessageIndex.delete(messageIndex)
      continue
    }
    input.push(
      ...translateMessage(message, payload.model, applyPhase, translationState),
    )
  }
  if (restoredTurnsByMessageIndex.size > 0) {
    throw createMessagesInvalidRequestError(
      "Restored Web Search history references a missing message.",
    )
  }

  const hasExplicitCacheBreakpoints = retainLatestPromptCacheBreakpoints(
    input,
    isGpt56OrAbove(payload.model) ? 3 : 0,
    exactRestoredItems,
  )

  const hasOriginalTools =
    Array.isArray(payload.tools) && payload.tools.length > 0
  const translatedTools = convertAnthropicTools(
    payload.tools,
    toolSearchEnabled,
  )
  const toolChoice = convertAnthropicToolChoice(
    payload.tool_choice,
    toolSearchEnabled,
  )
  const outputFormat = payload.output_config?.format

  // Remove safetyIdentifier to align with vscode copilot
  const { sessionId: metadataPromptCacheKey } = parseUserIdMetadata(
    payload.metadata?.user_id,
  )

  const requestStore = requestContext.getStore()
  const sessionAffinity = requestStore?.sessionAffinity?.trim() || null
  const basePromptCacheKey = metadataPromptCacheKey ?? sessionAffinity
  const promptCacheKey = buildPromptCacheKey(
    basePromptCacheKey,
    subagentAgentId,
  )

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input,
    instructions: translateSystemPrompt(
      payload.system,
      payload.model,
      policy.extraPrompt,
    ),
    temperature: payload.temperature ?? 1,
    top_p: payload.top_p ?? null,
    max_output_tokens: payload.max_tokens,
    tools: translatedTools,
    ...(hasOriginalTools ? { tool_choice: toolChoice } : {}),
    metadata: payload.metadata ? { ...payload.metadata } : null,
    ...(hasExplicitCacheBreakpoints ?
      {
        prompt_cache_options: {
          mode: "implicit" as const,
          ttl: "30m" as const,
        },
      }
    : {}),
    //prompt_cache_retention: "24h",  not work in gpt-5.4
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: !payload.tool_choice?.disable_parallel_tool_use,
    reasoning: {
      effort:
        payload.thinking?.type === "disabled" ?
          "none"
        : resolveReasoningEffort(payload, policy),
      summary: "auto",
      context: isSupportAllTurns(payload) ? "all_turns" : "auto",
    },
    include: ["reasoning.encrypted_content"],
    ...(outputFormat ?
      {
        text: {
          format: {
            type: "json_schema" as const,
            name: "anthropic_output",
            strict: true,
            schema: outputFormat.schema,
          },
        },
      }
    : {}),
  }

  if (hasOriginalTools || (isGpt56OrAbove(payload.model) && promptCacheKey)) {
    responsesPayload.prompt_cache_key = promptCacheKey
  }

  return responsesPayload
}

const retainLatestPromptCacheBreakpoints = (
  input: Array<ResponseInputItem>,
  limit: number,
  exactRestoredItems: WeakSet<object> = new WeakSet(),
): boolean => {
  const markedBlocks: Array<Record<string, unknown>> = []

  for (const item of input) {
    if (!isRecord(item)) continue
    if (exactRestoredItems.has(item)) continue

    const content =
      Array.isArray(item.content) ? item.content
      : Array.isArray(item.output) ? item.output
      : []

    for (const block of content) {
      if (
        isRecord(block)
        && isRecord(block.prompt_cache_breakpoint)
        && block.prompt_cache_breakpoint.mode === "explicit"
      ) {
        markedBlocks.push(block)
      }
    }
  }

  for (const block of markedBlocks.slice(
    0,
    Math.max(0, markedBlocks.length - limit),
  )) {
    delete block.prompt_cache_breakpoint
  }

  return markedBlocks.length > 0 && limit > 0
}

interface TranslationState {
  carrierTarget: ReasoningCarrierEndpoint
  originalTools: Array<AnthropicTool>
  toolSearchEnabled: boolean
  toolUseNameById: Map<string, string>
}

type CompactionCarrier = {
  id: string
  encrypted_content: string
}

export const encodeCompactionCarrierSignature = (
  compaction: CompactionCarrier,
): string => {
  return `${COMPACTION_SIGNATURE_PREFIX}${compaction.encrypted_content}${COMPACTION_SIGNATURE_SEPARATOR}${compaction.id}`
}

export const decodeCompactionCarrierSignature = (
  signature: string,
): CompactionCarrier | undefined => {
  if (signature.startsWith(COMPACTION_SIGNATURE_PREFIX)) {
    const raw = signature.slice(COMPACTION_SIGNATURE_PREFIX.length)
    const separatorIndex = raw.indexOf(COMPACTION_SIGNATURE_SEPARATOR)

    if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
      return undefined
    }

    const encrypted_content = raw.slice(0, separatorIndex)
    const id = raw.slice(separatorIndex + 1)

    if (!encrypted_content) {
      return undefined
    }

    return {
      id,
      encrypted_content,
    }
  }

  return undefined
}

export const encodeReasoningCarrierSignature = (
  reasoning: ResponseOutputReasoning,
  source: ReasoningCarrierEndpoint,
): string | undefined => {
  if (!reasoning.encrypted_content || !reasoning.id) {
    return undefined
  }

  return encodeVersionedReasoningCarrier(reasoning, source)
}

const translateMessage = (
  message: AnthropicMessage,
  model: string,
  applyPhase: boolean,
  state: TranslationState,
): Array<ResponseInputItem> => {
  if (message.role === "user") {
    return translateUserMessage(message, state)
  }

  return translateAssistantMessage(message, model, applyPhase, state)
}

const translateUserMessage = (
  message: AnthropicUserMessage,
  state: TranslationState,
): Array<ResponseInputItem> => {
  if (typeof message.content === "string") {
    return [createMessage("user", message.content)]
  }

  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === "tool_result") {
      flushPendingContent(pendingContent, items, { role: "user" })
      items.push(createToolCallOutput(block, state))
      continue
    }

    const converted = translateUserContentBlock(block)
    if (converted.length > 0) {
      pendingContent.push(...converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: "user" })

  return items
}

const translateAssistantMessage = (
  message: AnthropicAssistantMessage,
  model: string,
  applyPhase: boolean,
  state: TranslationState,
): Array<ResponseInputItem> => {
  const assistantPhase = resolveAssistantPhase(
    model,
    message.content,
    applyPhase,
  )

  if (typeof message.content === "string") {
    return [createMessage("assistant", message.content, assistantPhase)]
  }

  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === "tool_use") {
      state.toolUseNameById.set(block.id, block.name)
      flushPendingContent(pendingContent, items, {
        role: "assistant",
        phase: assistantPhase,
      })
      items.push(createToolCall(block, state))
      continue
    }

    if (block.type === "thinking" && block.signature) {
      const compactionContent = createCompactionContent(block)
      if (compactionContent) {
        flushPendingContent(pendingContent, items, {
          role: "assistant",
          phase: assistantPhase,
        })
        items.push(compactionContent)
        continue
      }

      const reasoningContent = createReasoningContent(
        block,
        state.carrierTarget,
      )
      if (reasoningContent) {
        flushPendingContent(pendingContent, items, {
          role: "assistant",
          phase: assistantPhase,
        })
        items.push(reasoningContent)
        continue
      }
    }

    const converted = translateAssistantContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, {
    role: "assistant",
    phase: assistantPhase,
  })

  return items
}

const translateUserContentBlock = (
  block: AnthropicUserContentBlock,
): Array<ResponseInputContent> => {
  switch (block.type) {
    case "text": {
      return [createTextContent(block.text, Boolean(block.cache_control))]
    }
    case "image": {
      return [convertCanonicalImageBlock(block, Boolean(block.cache_control))]
    }
    case "document": {
      return [
        convertCanonicalDocumentBlock(block, Boolean(block.cache_control)),
      ]
    }
    default: {
      return []
    }
  }
}

const convertCanonicalImageBlock = (
  block: unknown,
  cacheBreakpoint = false,
): ResponseInputImage => {
  const candidate = block as AnthropicToolResultContentBlock
  if (isAnthropicImageBlock(candidate)) {
    return createImageContent(candidate, cacheBreakpoint)
  }
  if (isAnthropicFileImageBlock(block)) {
    return createFileImageContent(block, cacheBreakpoint)
  }
  throw createMessagesInvalidRequestError(
    "Malformed Anthropic image source is not supported by the Responses translation path.",
  )
}

const convertCanonicalDocumentBlock = (
  block: unknown,
  cacheBreakpoint = false,
): ResponseInputFile => {
  const candidate = block as AnthropicToolResultContentBlock
  if (isAnthropicDocumentBlock(candidate)) {
    return createFileContent(candidate, cacheBreakpoint)
  }
  if (isAnthropicFileDocumentBlock(block)) {
    return createFileDocumentContent(block, cacheBreakpoint)
  }
  if (isAnthropicDocumentContainerBlock(block)) {
    throw createMessagesInvalidRequestError(
      "Anthropic document text/content sources are not supported by the Responses translation path.",
    )
  }
  throw createMessagesInvalidRequestError(
    "Malformed Anthropic document source is not supported by the Responses translation path.",
  )
}

const translateAssistantContentBlock = (
  block: AnthropicAssistantContentBlock,
): ResponseInputContent | undefined => {
  switch (block.type) {
    case "text": {
      return createOutPutTextContent(block)
    }
    default: {
      return undefined
    }
  }
}

const flushPendingContent = (
  pendingContent: Array<ResponseInputContent>,
  target: Array<ResponseInputItem>,
  message: Pick<ResponseInputMessage, "role" | "phase">,
) => {
  if (pendingContent.length === 0) {
    return
  }

  const messageContent = [...pendingContent]

  target.push(createMessage(message.role, messageContent, message.phase))
  pendingContent.length = 0
}

const createMessage = (
  role: ResponseInputMessage["role"],
  content: string | Array<ResponseInputContent>,
  phase?: ResponseInputMessage["phase"],
): ResponseInputMessage => ({
  type: MESSAGE_TYPE,
  role,
  content,
  ...(role === "assistant" && phase ? { phase } : {}),
})

const resolveAssistantPhase = (
  _model: string,
  content: AnthropicAssistantMessage["content"],
  applyPhase: boolean,
): ResponseInputMessage["phase"] | undefined => {
  if (!applyPhase) {
    return undefined
  }

  if (typeof content === "string") {
    return "final_answer"
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const hasText = content.some((block) => block.type === "text")
  if (!hasText) {
    return undefined
  }

  const hasToolUse = content.some((block) => block.type === "tool_use")
  return hasToolUse ? "commentary" : "final_answer"
}

const shouldApplyPhase = (_model: string): boolean => {
  return true
}

const createTextContent = (
  text: string,
  cacheBreakpoint = false,
): ResponseInputText => ({
  type: "input_text",
  text,
  ...(cacheBreakpoint ?
    { prompt_cache_breakpoint: { mode: "explicit" as const } }
  : {}),
})

const createOutPutTextContent = (
  block: AnthropicTextBlock,
): ResponseInputText => {
  const rawCitations: unknown = block.citations
  if (rawCitations !== undefined && !Array.isArray(rawCitations)) {
    throw createMessagesInvalidRequestError(
      "Anthropic Web Search citations must be an array.",
    )
  }
  const citations = rawCitations ?? []
  if (citations.length > 1_024 || block.text.length > 1024 * 1024) {
    throw createMessagesInvalidRequestError(
      "Anthropic Web Search citations exceed the local safety limit.",
    )
  }
  const annotations: NonNullable<ResponseInputText["annotations"]> = []
  let nextSearchIndex = 0
  let citationCharacters = 0
  for (const citation of citations) {
    if (
      !isRecord(citation)
      || citation.type !== "web_search_result_location"
      || typeof citation.cited_text !== "string"
      || !citation.cited_text
      || typeof citation.url !== "string"
      || !citation.url
      || typeof citation.title !== "string"
      || !citation.title
      || Object.hasOwn(citation, "encrypted_index")
      || Object.keys(citation).some(
        (key) => !["cited_text", "title", "type", "url"].includes(key),
      )
    ) {
      throw createMessagesInvalidRequestError(
        "Anthropic Web Search citation is malformed.",
      )
    }
    citationCharacters +=
      citation.cited_text.length + citation.url.length + citation.title.length
    if (citationCharacters > 1024 * 1024) {
      throw createMessagesInvalidRequestError(
        "Anthropic Web Search citations exceed the local safety limit.",
      )
    }
    let startIndex = block.text.indexOf(citation.cited_text, nextSearchIndex)
    if (startIndex < 0) startIndex = block.text.indexOf(citation.cited_text)
    if (startIndex < 0) {
      throw createMessagesInvalidRequestError(
        "Anthropic Web Search citation does not match its text block.",
      )
    }
    const endIndex = startIndex + citation.cited_text.length
    nextSearchIndex = endIndex
    annotations.push({
      type: "url_citation",
      start_index: startIndex,
      end_index: endIndex,
      url: citation.url,
      title: citation.title,
    })
  }
  return {
    type: "output_text",
    text: block.text,
    ...(annotations.length > 0 && { annotations }),
  }
}

const createImageContent = (
  block: AnthropicImageBlock,
  cacheBreakpoint = false,
): ResponseInputImage => {
  const imageUrl =
    block.source.type === "url" ?
      block.source.url
    : `data:${block.source.media_type};base64,${block.source.data}`

  return {
    type: "input_image",
    image_url: imageUrl,
    detail: "auto",
    ...(cacheBreakpoint ?
      { prompt_cache_breakpoint: { mode: "explicit" as const } }
    : {}),
  }
}

const createFileImageContent = (
  block: AnthropicFileImageBlock,
  cacheBreakpoint = false,
): ResponseInputImage => ({
  type: "input_image",
  file_id: block.source.file_id,
  detail: "auto",
  ...(cacheBreakpoint ?
    { prompt_cache_breakpoint: { mode: "explicit" as const } }
  : {}),
})

const createFileContent = (
  block: AnthropicDocumentBlock,
  cacheBreakpoint = false,
): ResponseInputFile => {
  const cache =
    cacheBreakpoint ?
      { prompt_cache_breakpoint: { mode: "explicit" as const } }
    : {}

  if (block.source.type === "url") {
    return {
      type: "input_file",
      file_url: block.source.url,
      ...cache,
    }
  }

  return {
    type: "input_file",
    file_data: `data:${block.source.media_type};base64,${block.source.data}`,
    filename: block.title ?? "document.pdf",
    ...cache,
  }
}

const createFileDocumentContent = (
  block: AnthropicFileDocumentBlock,
  cacheBreakpoint = false,
): ResponseInputFile => ({
  type: "input_file",
  file_id: block.source.file_id,
  ...(cacheBreakpoint ?
    { prompt_cache_breakpoint: { mode: "explicit" as const } }
  : {}),
})

const createReasoningContent = (
  block: AnthropicThinkingBlock,
  carrierTarget: ReasoningCarrierEndpoint,
): ResponseInputReasoning | undefined => {
  const versionedCarrier = decodeReasoningCarrierSignature(
    block.signature,
    carrierTarget,
  )
  if (versionedCarrier) {
    return versionedCarrier
  }

  // align with vscode-copilot-chat extractThinkingData, should add id
  // https://github.com/microsoft/vscode/blob/1.128.0/extensions/copilot/src/platform/endpoint/node/responsesApi.ts#L651
  const carrier = parseLegacyOpenAIReasoningCarrierSignature(block.signature)
  if (!carrier) {
    return undefined
  }

  const { encryptedContent, id } = carrier
  const thinking = block.thinking === THINKING_TEXT ? "" : block.thinking

  return {
    id,
    type: "reasoning",
    summary: createReasoningSummary(thinking),
    encrypted_content: encryptedContent,
  }
}

const createReasoningSummary = (
  thinking: string,
): ResponseInputReasoning["summary"] => {
  if (thinking.length === 0) {
    return []
  }

  if (!REASONING_SUMMARY_SEPARATOR_PATTERN.test(thinking)) {
    return [{ type: "summary_text", text: thinking }]
  }

  return thinking.split(REASONING_SUMMARY_SEPARATOR_PATTERN).map((text) => ({
    type: "summary_text",
    text,
  }))
}

const createCompactionContent = (
  block: AnthropicThinkingBlock,
): ResponseInputCompaction | undefined => {
  const compaction = decodeCompactionCarrierSignature(block.signature)
  if (!compaction) {
    return undefined
  }

  return {
    id: compaction.id,
    type: "compaction",
    encrypted_content: compaction.encrypted_content,
  }
}

const decodeReasoningCarrierSignature = (
  signature: string,
  carrierTarget: ReasoningCarrierEndpoint,
): ResponseInputReasoning | undefined => {
  const carrier = decodeVersionedReasoningCarrier(signature)
  if (!carrier) {
    return undefined
  }
  if (
    carrier.source
    && (carrier.source.provider !== carrierTarget.provider
      || carrier.source.model !== carrierTarget.model)
  ) {
    return undefined
  }

  const value = carrier.item
  try {
    if (
      !isRecord(value)
      || value.type !== "reasoning"
      || typeof value.id !== "string"
      || value.id.length === 0
      || typeof value.encrypted_content !== "string"
      || value.encrypted_content.length === 0
      || !isValidReasoningSummary(value.summary)
      || !isValidReasoningStatus(value.status)
    ) {
      return undefined
    }

    return value as ResponseInputReasoning
  } catch {
    return undefined
  }
}

const isValidReasoningSummary = (summary: unknown): boolean =>
  summary === undefined
  || (Array.isArray(summary)
    && summary.every(
      (block) =>
        isRecord(block)
        && typeof block.type === "string"
        && block.type.length > 0
        && (block.text === undefined || typeof block.text === "string"),
    ))

const isValidReasoningStatus = (status: unknown): boolean =>
  status === undefined
  || status === "completed"
  || status === "in_progress"
  || status === "incomplete"

const createFunctionToolCall = (
  block: AnthropicToolUseBlock,
  state: TranslationState,
): ResponseFunctionToolCallItem => ({
  type: "function_call",
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: "completed",
  ...(state.toolSearchEnabled && isDeferredToolName(block.name) ?
    { namespace: block.name }
  : {}),
})

const createToolSearchCall = (
  block: AnthropicToolUseBlock,
): ResponseToolSearchCallItem => ({
  type: "tool_search_call",
  call_id: block.id,
  arguments: normalizeToolSearchBridgeArguments(block.input),
  execution: "client",
  status: "completed",
})

const createToolCall = (
  block: AnthropicToolUseBlock,
  state: TranslationState,
): ResponseFunctionToolCallItem | ResponseToolSearchCallItem => {
  if (state.toolSearchEnabled && isBridgeToolSearchName(block.name)) {
    return createToolSearchCall(block)
  }

  return createFunctionToolCall(block, state)
}

const createFunctionCallOutput = (
  block: AnthropicToolResultBlock,
): ResponseFunctionCallOutputItem => ({
  type: "function_call_output",
  call_id: block.tool_use_id,
  output: convertToolResultContent(block.content, Boolean(block.cache_control)),
  status: block.is_error ? "incomplete" : "completed",
})

const createToolCallOutput = (
  block: AnthropicToolResultBlock,
  state: TranslationState,
): ResponseFunctionCallOutputItem | ResponseToolSearchOutputItem => {
  validateAnthropicToolResultContent(block.content)

  const toolUseName = state.toolUseNameById.get(block.tool_use_id)
  if (state.toolSearchEnabled && isBridgeToolSearchName(toolUseName ?? "")) {
    return createToolSearchOutput(block, state.originalTools)
  }

  return createFunctionCallOutput(block)
}

const createToolSearchOutput = (
  block: AnthropicToolResultBlock,
  originalTools: Array<AnthropicTool>,
): ResponseToolSearchOutputItem => {
  const referencedToolNames = resolveToolSearchReferencedToolNames(
    block.content,
    originalTools,
  )

  return {
    type: "tool_search_output",
    call_id: block.tool_use_id,
    tools: referencedToolNames.map((toolName) =>
      convertDeferredToolToNamespace(
        resolveDeferredTool(toolName, originalTools),
      ),
    ),
    execution: "client",
    status: block.is_error ? "incomplete" : "completed",
  }
}

const resolveToolSearchReferencedToolNames = (
  content: string | Array<AnthropicToolResultContentBlock>,
  originalTools: Array<AnthropicTool>,
): Array<string> => {
  const explicitReferences = extractToolReferenceNames(content)
  if (explicitReferences.length > 0) {
    return uniqueToolNames(explicitReferences)
  }

  const sentinel = extractMcpToolSearchSentinel(content)
  if (sentinel) {
    return selectDeferredToolsByNames(sentinel.names, originalTools).map(
      (tool) => tool.name,
    )
  }

  return []
}

const extractToolReferenceNames = (
  content: string | Array<AnthropicToolResultContentBlock>,
): Array<string> => {
  if (!Array.isArray(content)) {
    return []
  }

  return content.flatMap((block) =>
    isAnthropicToolReferenceBlock(block) ? [block.tool_name] : [],
  )
}

const extractMcpToolSearchSentinel = (
  content: string | Array<AnthropicToolResultContentBlock>,
) => {
  if (typeof content === "string") {
    return parseMcpToolSearchSentinel(content)
  }

  for (const block of content) {
    if (!isAnthropicTextBlock(block)) {
      continue
    }

    const sentinel = parseMcpToolSearchSentinel(block.text)
    if (sentinel) {
      return sentinel
    }
  }

  return null
}

const resolveDeferredTool = (
  toolName: string,
  originalTools: Array<AnthropicTool>,
): AnthropicCustomTool => {
  const tool = originalTools.find((candidate) => candidate.name === toolName)
  if (tool && isAnthropicCustomTool(tool) && isDeferredToolName(tool.name)) {
    return tool
  }

  throw createMessagesInvalidRequestError(
    `Tool reference '${toolName}' has no corresponding deferred tool definition`,
  )
}

const uniqueToolNames = (toolNames: Array<string>): Array<string> => [
  ...new Set(toolNames),
]

const translateSystemPrompt = (
  system: string | Array<AnthropicTextBlock> | undefined,
  model: string,
  configuredExtraPrompt?: string,
): string | null => {
  if (!system) {
    return null
  }

  const extraPrompt = configuredExtraPrompt ?? getExtraPromptForModel(model)

  if (typeof system === "string") {
    return system + extraPrompt
  }

  const text = system
    .map((block, index) => {
      if (index === 0) {
        return block.text + "\n\n" + extraPrompt + "\n\n"
      }
      return block.text
    })
    .join(" ")
  return text.length > 0 ? text : null
}

const convertAnthropicTools = (
  tools: Array<AnthropicTool> | undefined,
  toolSearchEnabled: boolean,
): Array<Tool> | null => {
  if (!tools) {
    return null
  }

  if (tools.length === 0) return []

  const converted: Array<Tool> = []
  let addedToolSearch = false
  const customTools = tools.filter(isAnthropicCustomTool)
  const searchableToolNames =
    toolSearchEnabled ? listDeferredToolNames(customTools) : []

  for (const tool of customTools) {
    if (isBridgeToolSearchName(tool.name)) {
      if (toolSearchEnabled && !addedToolSearch) {
        converted.push(createResponsesToolSearchDefinition(searchableToolNames))
        addedToolSearch = true
      }
      continue
    }

    if (toolSearchEnabled && isDeferredToolName(tool.name)) {
      converted.push(convertDeferredToolToNamespace(tool))
      continue
    }

    converted.push(convertToolToFunction(tool))
  }

  return converted
}

const createResponsesToolSearchDefinition = (
  searchableToolNames: Array<string>,
): Tool => ({
  type: "tool_search",
  execution: "client",
  description:
    "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        description: "Exact deferred tool names to load.",
        items: {
          type: "string",
          enum: searchableToolNames,
        },
        minItems: 1,
      },
    },
    required: ["names"],
    additionalProperties: false,
  },
})

const convertToolToFunction = (tool: AnthropicCustomTool): Tool => ({
  type: "function",
  name: tool.name,
  parameters: normalizeToolSchema(tool.input_schema),
  strict: false,
  ...(tool.description ? { description: tool.description } : {}),
})

const convertDeferredToolToNamespace = (tool: AnthropicCustomTool): Tool => ({
  type: "namespace",
  name: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  tools: [
    {
      type: "function",
      name: tool.name,
      parameters: normalizeToolSchema(tool.input_schema),
      strict: false,
      defer_loading: true,
      ...(tool.description ? { description: tool.description } : {}),
    },
  ],
})

const convertAnthropicToolChoice = (
  choice: AnthropicMessagesPayload["tool_choice"],
  toolSearchEnabled: boolean,
): ToolChoiceOptions | ToolChoiceFunction => {
  if (!choice) {
    return "auto"
  }

  switch (choice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (
        toolSearchEnabled
        && choice.name
        && isBridgeToolSearchName(choice.name)
      ) {
        return "auto"
      }
      return choice.name ? { type: "function", name: choice.name } : "auto"
    }
    case "none": {
      return "none"
    }
    default: {
      return "auto"
    }
  }
}

interface ResponsesToAnthropicOptions {
  carrierSource?: ReasoningCarrierEndpoint
  toolSearchName?: string
  hasToolCall?: boolean
  includeThinking?: boolean
}

export const translateResponsesResultToAnthropic = (
  response: ResponsesResult,
  options?: ResponsesToAnthropicOptions,
): AnthropicResponse => {
  assertResponsesResultUsable(response)
  const resolvedOptions = {
    ...options,
    carrierSource: options?.carrierSource ?? {
      model: response.model,
      provider: "copilot",
    },
  }
  const contentBlocks = mapOutputToAnthropicContent(
    response.output,
    resolvedOptions,
  )
  const usage = mapResponsesUsageToAnthropic(response.usage)
  let anthropicContent = fallbackContentBlocks(response.output_text)
  if (contentBlocks.length > 0) {
    anthropicContent = contentBlocks
  }

  const stopReason = mapResponsesStopReasonToAnthropic(
    response,
    resolvedOptions,
  )

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: anthropicContent,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}

const mapOutputToAnthropicContent = (
  output: Array<ResponseOutputItem>,
  options?: ResponsesToAnthropicOptions,
): Array<AnthropicAssistantContentBlock> => {
  const contentBlocks: Array<AnthropicAssistantContentBlock> = []
  if (!output) {
    output = []
  }
  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        if (options?.includeThinking === false) {
          break
        }
        const thinkingText = extractReasoningText(item)
        if (thinkingText.length > 0) {
          contentBlocks.push({
            type: "thinking",
            thinking: thinkingText,
            signature:
              encodeReasoningCarrierSignature(
                item,
                options?.carrierSource ?? {
                  model: "unknown",
                  provider: "copilot",
                },
              ) ?? "",
          })
        }
        break
      }
      case "function_call": {
        const toolUseBlock = createToolUseContentBlock(item)
        if (toolUseBlock) {
          contentBlocks.push(toolUseBlock)
        }
        break
      }
      case "tool_search_call": {
        const toolUseBlock = createToolSearchUseContentBlock(
          item,
          options?.toolSearchName,
        )
        if (toolUseBlock) {
          contentBlocks.push(toolUseBlock)
        }
        break
      }
      case "tool_search_output": {
        break
      }
      case "message": {
        const combinedText = combineMessageTextContent(item.content)
        if (combinedText.length > 0) {
          contentBlocks.push({ type: "text", text: combinedText })
        }
        break
      }
      case "compaction": {
        if (options?.includeThinking === false) {
          break
        }
        const compactionBlock = createCompactionThinkingBlock(item)
        if (compactionBlock) {
          contentBlocks.push(compactionBlock)
        }
        break
      }
      default: {
        // Future compatibility for unrecognized output item types.
        const combinedText = combineMessageTextContent(
          (item as { content?: Array<ResponseOutputContentBlock> }).content,
        )
        if (combinedText.length > 0) {
          contentBlocks.push({ type: "text", text: combinedText })
        }
      }
    }
  }

  return contentBlocks
}

const combineMessageTextContent = (
  content: Array<ResponseOutputContentBlock> | undefined,
): string => {
  if (!Array.isArray(content)) {
    return ""
  }

  let aggregated = ""

  for (const block of content) {
    if (isResponseOutputText(block)) {
      aggregated += block.text
      continue
    }

    if (isResponseOutputRefusal(block)) {
      aggregated += block.refusal
      continue
    }

    if (typeof (block as { text?: unknown }).text === "string") {
      aggregated += (block as { text: string }).text
      continue
    }

    if (typeof (block as { reasoning?: unknown }).reasoning === "string") {
      aggregated += (block as { reasoning: string }).reasoning
      continue
    }
  }

  return aggregated
}

const extractReasoningText = (item: ResponseOutputReasoning): string => {
  const segments: Array<string> = []

  const collectFromBlocks = (blocks?: Array<ResponseReasoningBlock>) => {
    if (!Array.isArray(blocks)) {
      return
    }

    for (const block of blocks) {
      if (typeof block.text === "string") {
        segments.push(block.text)
        continue
      }
    }
  }

  // Compatible with opencode, it will filter out blocks where the thinking text is empty, so we add a default thinking text here
  if (!item.summary || item.summary.length === 0) {
    return THINKING_TEXT
  }

  collectFromBlocks(item.summary)

  return segments.join(REASONING_SUMMARY_SEPARATOR).trim()
}

const createToolUseContentBlock = (
  call: ResponseOutputFunctionCall,
): AnthropicToolUseBlock | null => {
  const toolId = call.call_id
  const toolName = resolveToolUseName(call)
  if (!toolName || !toolId) {
    return null
  }

  const input = parseFunctionCallArguments(call.arguments)

  return {
    type: "tool_use",
    id: toolId,
    name: toolName,
    input,
  }
}

const createToolSearchUseContentBlock = (
  call: ResponseOutputToolSearchCall,
  toolSearchName = BRIDGE_TOOL_SEARCH_NAME,
): AnthropicToolUseBlock | null => {
  const toolId = call.call_id
  if (!toolId) {
    return null
  }

  return {
    type: "tool_use",
    id: toolId,
    name: toolSearchName,
    input: parseToolSearchArguments(call.arguments),
  }
}

export const resolveToolUseName = (
  call: Pick<ResponseOutputFunctionCall, "name" | "namespace">,
): string => {
  if (typeof call.namespace === "string" && call.namespace.length > 0) {
    return call.namespace
  }

  return call.name
}

const createCompactionThinkingBlock = (
  item: ResponseOutputCompaction,
): AnthropicAssistantContentBlock | null => {
  if (!item.id || !item.encrypted_content) {
    return null
  }

  return {
    type: "thinking",
    thinking: THINKING_TEXT,
    signature: encodeCompactionCarrierSignature({
      id: item.id,
      encrypted_content: item.encrypted_content,
    }),
  }
}

const parseToolSearchArguments = (
  argumentsValue: Record<string, unknown> | string,
): Record<string, unknown> => {
  return formatToolSearchBridgeArguments(argumentsValue)
}

const fallbackContentBlocks = (
  outputText: string,
): Array<AnthropicAssistantContentBlock> => {
  if (!outputText) {
    return []
  }

  return [
    {
      type: "text",
      text: outputText,
    },
  ]
}

const hasExplicitRefusal = (response: ResponsesResult): boolean =>
  response.output.some(
    (item) =>
      item.type === "message"
      && item.content?.some((block) => block.type === "refusal"),
  )

export const mapResponsesStopReasonToAnthropic = (
  response: ResponsesResult,
  options?: ResponsesToAnthropicOptions,
): AnthropicResponse["stop_reason"] => {
  const { status, incomplete_details: incompleteDetails } = response
  const incompleteReason = (incompleteDetails as { reason?: string } | null)
    ?.reason

  if (status === "completed") {
    if (!response.output || response.output.length === 0) {
      return options?.hasToolCall ? "tool_use" : "end_turn"
    }

    if (
      response.output.some(
        (item) =>
          item.type === "function_call" || item.type === "tool_search_call",
      )
    ) {
      return "tool_use"
    }
    return "end_turn"
  }

  if (status === "incomplete") {
    if (
      incompleteReason === "max_output_tokens"
      || incompleteReason === "max_tokens"
    ) {
      return "max_tokens"
    }
    if (incompleteReason === "content_filter" && hasExplicitRefusal(response)) {
      return "refusal"
    }
  }

  return null
}

export const mapResponsesUsageToAnthropic = (
  usage: ResponsesResult["usage"],
): AnthropicResponse["usage"] => {
  const normalized = normalizeResponsesUsage(usage)
  const hasCachedTokens = Boolean(
    usage?.input_tokens_details
      && Object.hasOwn(usage.input_tokens_details, "cached_tokens"),
  )

  return {
    input_tokens: normalized.input_tokens ?? 0,
    output_tokens: normalized.output_tokens ?? 0,
    ...(hasCachedTokens && {
      cache_read_input_tokens: normalized.cache_read_input_tokens ?? 0,
    }),
    ...(typeof normalized.cache_creation_input_tokens === "number" && {
      cache_creation_input_tokens: normalized.cache_creation_input_tokens,
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isResponseOutputText = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputText =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "output_text"

const isResponseOutputRefusal = (
  block: ResponseOutputContentBlock,
): block is ResponseOutputRefusal =>
  isRecord(block)
  && "type" in block
  && (block as { type?: unknown }).type === "refusal"

const convertToolResultContent = (
  content: string | Array<AnthropicToolResultContentBlock>,
  cacheBreakpoint = false,
): string | Array<ResponseInputContent> => {
  if (typeof content === "string") {
    return cacheBreakpoint ? [createTextContent(content, true)] : content
  }

  const result: Array<ResponseInputContent> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        if (!isAnthropicTextBlock(block)) {
          result.push(createTextContent(JSON.stringify(block)))
          break
        }
        result.push(createTextContent(block.text, Boolean(block.cache_control)))
        break
      }
      case "image": {
        result.push(
          convertCanonicalImageBlock(block, Boolean(block.cache_control)),
        )
        break
      }
      case "document": {
        result.push(
          convertCanonicalDocumentBlock(block, Boolean(block.cache_control)),
        )
        break
      }
      case "tool_reference": {
        if (!isAnthropicToolReferenceBlock(block)) {
          result.push(createTextContent(JSON.stringify(block)))
          break
        }
        result.push(
          createTextContent(
            `Tool ${block.tool_name} loaded`,
            Boolean(block.cache_control),
          ),
        )
        break
      }
      default: {
        result.push(
          createTextContent(
            JSON.stringify(block),
            Boolean((block as { cache_control?: unknown }).cache_control),
          ),
        )
        break
      }
    }
  }

  if (cacheBreakpoint) {
    const lastCacheableBlock = result.findLast(
      (block) =>
        block.type === "input_text"
        || block.type === "input_image"
        || block.type === "input_file",
    )
    if (lastCacheableBlock) {
      lastCacheableBlock.prompt_cache_breakpoint = { mode: "explicit" }
    }
  }
  return result
}

const isSupportAllTurns = (payload: AnthropicMessagesPayload): boolean => {
  if (
    payload.model === "gpt-5.4"
    || payload.model === "gpt-5.4-mini"
    || payload.model === "gpt-5.5"
  ) {
    return true
  }
  return isGpt56OrAbove(payload.model)
}
