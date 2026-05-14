import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { COMPACT_REQUEST } from "~/lib/compact"
import { getSmallModel, isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  getCompactType,
  mergeToolResultForClaude,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderMessagesForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  await checkRateLimit(state)

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  sanitizeIdeTools(anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact / auto-continue detection
  const compactType = getCompactType(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && compactType === 0) {
    anthropicPayload.model = getSmallModel()
  }

  if (compactType) {
    logger.debug("Compact request type:", compactType)
  }

  stripToolReferenceTurnBoundary(anthropicPayload)

  // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
  // (caused by skill invocations, edit hooks, plan or to do reminders)
  // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
  // not only for claude, but also for opencode
  // compact requests still run this processing, except for the final compact message itself
  mergeToolResultForClaude(anthropicPayload, {
    skipLastMessage: compactType === COMPACT_REQUEST,
  })

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (shouldUseMessagesApi(selectedModel)) {
    return await messagesFlowHandlers.handleWithMessagesApi(
      c,
      anthropicPayload,
      {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
      },
    )
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await messagesFlowHandlers.handleWithResponsesApi(
      c,
      anthropicPayload,
      {
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
      },
    )
  }

  return await messagesFlowHandlers.handleWithChatCompletions(
    c,
    anthropicPayload,
    {
      subagentMarker,
      requestId,
      sessionId,
      compactType,
      logger,
    },
  )
}

const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return Boolean(getResponsesTransportForModel(selectedModel))
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
