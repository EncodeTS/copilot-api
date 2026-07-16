import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  getCompactType,
  IDE_EXECUTE_CODE_TOOL,
  normalizeSystemMessages,
  sanitizeIdeTools,
} from "./preprocess"
import { hasTrailingAssistantPrefill } from "./responses-translation"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const logger = createHandlerLogger("messages-translation-orchestrator")

interface CopilotMessagesOptions {
  anthropicBetaHeader?: string
  compactType?: CompactType
  logger: ConsolaInstance
  reasoningRecoverySessionId?: string
  requestId: string
  selectedModel?: Model
  sessionId?: string
  signal?: AbortSignal
  subagentMarker?: SubagentMarker | null
}

export const messagesTranslationDependencies = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export const handleCopilotMessages = async (
  c: Context,
  payload: AnthropicMessagesPayload,
) => {
  normalizeSystemMessages(payload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(payload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const reasoningRecoverySessionId = getRootSessionId(payload, c)
  let sessionId = reasoningRecoverySessionId
  const compactType = getCompactType(payload)
  const anthropicBetaHeader = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBetaHeader)
  if (compactType) {
    logger.debug("Compact request type:", compactType)
  }

  const selectedModel = findEndpointModel(payload.model)
  const flow = selectCopilotMessagesFlow(selectedModel, compactType, payload)

  if (
    flow === "chat_completions"
    && payload.tool_choice?.type === "tool"
    && payload.tool_choice.name === IDE_EXECUTE_CODE_TOOL
  ) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "mcp__ide__executeCode is not supported by the Chat Completions fallback.",
        },
      },
      400,
    )
  }

  sanitizeIdeTools(payload, {
    preserveExecuteCode: flow !== "chat_completions",
  })

  const requestId = generateRequestIdFromPayload(payload, sessionId)
  logger.debug("Generated request ID:", requestId)
  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  payload.model = selectedModel?.id ?? payload.model
  const options: CopilotMessagesOptions = {
    anthropicBetaHeader,
    compactType,
    logger,
    reasoningRecoverySessionId,
    requestId,
    selectedModel,
    sessionId,
    signal: c.req.raw.signal,
    subagentMarker,
  }

  if (flow === "messages") {
    return await messagesTranslationDependencies.handleWithMessagesApi(
      c,
      payload,
      options,
    )
  }
  if (flow === "responses") {
    return await messagesTranslationDependencies.handleWithResponsesApi(
      c,
      payload,
      options,
    )
  }
  return await messagesTranslationDependencies.handleWithChatCompletions(
    c,
    payload,
    options,
  )
}

const selectCopilotMessagesFlow = (
  selectedModel: Model | undefined,
  compactType: CompactType | undefined,
  payload: AnthropicMessagesPayload,
): "chat_completions" | "messages" | "responses" => {
  if (shouldUseMessagesApi(selectedModel)) return "messages"
  if (shouldUseResponsesApi(selectedModel, compactType, payload)) {
    return "responses"
  }
  return "chat_completions"
}

const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
  compactType: CompactType | undefined,
  payload: AnthropicMessagesPayload,
): boolean => {
  if (
    hasTrailingAssistantPrefill(payload)
    && selectedModel?.supported_endpoints?.includes(CHAT_COMPLETIONS_ENDPOINT)
  ) {
    return false
  }

  return Boolean(getResponsesTransportForModel(selectedModel, { compactType }))
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  if (!isMessagesApiEnabled()) return false
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
