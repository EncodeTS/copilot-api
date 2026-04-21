import type { Context } from "hono"

import consola from "consola"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { COMPACT_REQUEST } from "~/lib/compact"
import { getSmallModel, isMessagesApiEnabled } from "~/lib/config"
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
import {
  getCompactType,
  mergeToolResultForClaude,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

const CONTEXT_1M_BETA = "context-1m-2025-08-07"

const formatThinking = (
  thinking: AnthropicMessagesPayload["thinking"],
): string => {
  if (thinking?.type === "enabled") {
    return `enabled(${thinking.budget_tokens ?? "?"})`
  }
  return thinking?.type ?? "none"
}

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
  compactType: number
}): void => {
  const { requestedModel, payload, selectedModel, compactType } = options
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
        + ` | compact=${compactType}`,
    )
  }
}

const applyWarmupSmallModel = (
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
  compactType: number,
): void => {
  const noTools = !payload.tools || payload.tools.length === 0
  if (anthropicBeta && noTools && compactType === 0) {
    payload.model = getSmallModel()
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const anthropicBeta = c.req.header("anthropic-beta")
  consola.info(
    `[req] model=${anthropicPayload.model}`
      + ` | thinking=${formatThinking(anthropicPayload.thinking)}`
      + ` | effort=${anthropicPayload.output_config?.effort ?? "unset"}`
      + ` | stream=${anthropicPayload.stream ?? false}`
      + ` | tools=${anthropicPayload.tools?.length ?? 0}`
      + ` | context1m=${anthropicBeta?.includes(CONTEXT_1M_BETA) ?? false}`,
  )
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
  logger.debug("Anthropic Beta header:", anthropicBeta)
  applyWarmupSmallModel(anthropicPayload, anthropicBeta, compactType)

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

  const { selectedModel, requestedModel } = resolveModel(
    anthropicPayload,
    anthropicBeta,
  )
  logRoute({
    requestedModel,
    payload: anthropicPayload,
    selectedModel,
    compactType,
  })

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
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
