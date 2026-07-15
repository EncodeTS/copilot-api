import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { isMessagesApiEnabled, resolveMappedModel } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { parseProviderModelAlias } from "~/lib/provider-model"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"
import { hasTrailingAssistantPrefill } from "./responses-translation"

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
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { tryHandleWebSearch } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  const requestedModel = anthropicPayload.model
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  const webSearchResult = await tryHandleWebSearch(c, anthropicPayload, {
    logger,
    forwardToProvider: (ctx, payload, provider) =>
      handleProviderMessagesForProvider(ctx, { payload, provider }),
  })
  if (webSearchResult) return webSearchResult

  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderMessagesForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  normalizeSystemMessages(anthropicPayload)

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  let sessionId = getRootSessionId(anthropicPayload, c)

  // claude code and opencode compact / auto-continue detection
  const compactType = getCompactType(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  if (compactType) {
    logger.debug("Compact request type:", compactType)
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  const useMessagesApi = shouldUseMessagesApi(selectedModel)
  const useResponsesApi =
    !useMessagesApi
    && shouldUseResponsesApi(selectedModel, compactType, anthropicPayload)
  if (
    !useMessagesApi
    && !useResponsesApi
    && anthropicPayload.tool_choice?.type === "tool"
    && anthropicPayload.tool_choice.name === IDE_EXECUTE_CODE_TOOL
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
  sanitizeIdeTools(anthropicPayload, {
    preserveExecuteCode: useMessagesApi || useResponsesApi,
  })

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (useMessagesApi) {
    return await messagesFlowHandlers.handleWithMessagesApi(
      c,
      anthropicPayload,
      {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        signal: c.req.raw.signal,
        compactType,
        logger,
      },
    )
  }

  if (useResponsesApi) {
    return await messagesFlowHandlers.handleWithResponsesApi(
      c,
      anthropicPayload,
      {
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        signal: c.req.raw.signal,
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
      selectedModel,
      requestId,
      sessionId,
      signal: c.req.raw.signal,
      compactType,
      logger,
    },
  )
}

const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
  compactType: ReturnType<typeof getCompactType>,
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
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
