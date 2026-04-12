import type { Context } from "hono"

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { isMessagesApiEnabled } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import { isCompactRequest, stripToolReferenceTurnBoundary } from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const CONTEXT_1M_BETA = "context-1m-2025-08-07"

const resolveModel = (
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): { selectedModel: Model | undefined; requestedModel: string } => {
  const hasContext1m = anthropicBeta?.includes(CONTEXT_1M_BETA)
  const selectedModel = findEndpointModel(
    payload.model,
    hasContext1m ? "-1m" : undefined,
  )
  const requestedModel = payload.model
  payload.model = selectedModel?.id ?? payload.model

  const ctx = requestContext.getStore()
  if (ctx) {
    ctx.modelRoute =
      requestedModel !== payload.model ?
        `${requestedModel} -> ${payload.model}`
      : requestedModel
  }

  return { selectedModel, requestedModel }
}

const logRoute = (options: {
  requestedModel: string
  payload: AnthropicMessagesPayload
  selectedModel: Model | undefined
  isCompact: boolean
}): void => {
  const { requestedModel, payload, selectedModel, isCompact } = options
  if (state.verbose) {
    let apiFlow = "Chat Completions"
    if (shouldUseMessagesApi(selectedModel)) {
      apiFlow = "Messages API"
    } else if (shouldUseResponsesApi(selectedModel)) {
      apiFlow = "Responses API"
    }
    consola.info(
      `[route] model=${requestedModel} -> ${payload.model}`
        + ` | flow=${apiFlow}`
        + ` | compact=${isCompact}`,
    )
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const anthropicBeta = c.req.header("anthropic-beta")
  consola.info(
    `[req] model=${anthropicPayload.model}`
      + ` | thinking=${anthropicPayload.thinking?.type ?? "none"}`
      + ` | effort=${anthropicPayload.output_config?.effort ?? "unset"}`
      + ` | stream=${anthropicPayload.stream ?? false}`
      + ` | tools=${anthropicPayload.tools?.length ?? 0}`
      + ` | context1m=${anthropicBeta?.includes(CONTEXT_1M_BETA) ?? false}`,
  )
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  logger.debug("Anthropic Beta header:", anthropicBeta)

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    stripToolReferenceTurnBoundary(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const { selectedModel, requestedModel } = resolveModel(
    anthropicPayload,
    anthropicBeta,
  )
  logRoute({
    requestedModel,
    payload: anthropicPayload,
    selectedModel,
    isCompact,
  })

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
    logger,
  })
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
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
