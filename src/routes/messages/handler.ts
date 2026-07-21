import type { Context } from "hono"

import { createHandlerLogger, debugJson } from "~/lib/logger"
import { normalizeMessageReasoningEffort } from "~/lib/reasoning-effort"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { routeProviderModelAlias } from "~/routes/provider/model-router"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  preparedMessages,
  type PreparedMessagesFacade,
} from "./prepared-messages/facade"
import {
  preparedMessagesPolicy,
  resolvePreparedMessagesModel,
  type PreparedMessagesPolicyPort,
} from "./prepared-messages/policy"
import { createMessagesRequestContext } from "./request-context"
import { tryHandleWebSearch } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface MessagesHandlerComposition {
  preparedMessages: PreparedMessagesFacade
  preparedMessagesPolicy: PreparedMessagesPolicyPort
}

const defaultMessagesHandlerComposition = Object.freeze({
  preparedMessages,
  preparedMessagesPolicy,
})

export async function handleCompletion(
  c: Context,
  composition: MessagesHandlerComposition = defaultMessagesHandlerComposition,
) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const outputConfig: unknown = anthropicPayload.output_config
  if (isRecord(outputConfig) && Object.hasOwn(outputConfig, "effort")) {
    const effort = normalizeMessageReasoningEffort(outputConfig.effort)
    if (!effort) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Unsupported Messages output_config.effort",
          },
        },
        400,
      )
    }
    anthropicPayload.output_config = {
      ...anthropicPayload.output_config,
      effort,
    }
  }

  const messagesRequestContext = createMessagesRequestContext(
    c,
    anthropicPayload,
    composition.preparedMessagesPolicy.snapshot(anthropicPayload.model),
  )
  const requestedModel = anthropicPayload.model
  anthropicPayload.model = resolvePreparedMessagesModel(
    messagesRequestContext.policy,
    anthropicPayload.model,
  )
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  // Explicit provider intent is resolved against the provider's effective
  // protocol before the global Web Search fallback is considered.
  const providerResponse = await routeProviderModelAlias(c, {
    endpoint: "messages",
    payload: anthropicPayload,
  })
  if (providerResponse) return providerResponse

  const webSearchResult = await tryHandleWebSearch(c, anthropicPayload, {
    logger,
    forwardToProvider: (ctx, payload, provider) =>
      handleProviderMessagesForProvider(ctx, { payload, provider }),
  })
  if (webSearchResult) return webSearchResult

  debugJson(logger, "Anthropic request payload:", anthropicPayload)
  return await composition.preparedMessages.generate(
    messagesRequestContext,
    anthropicPayload,
  )
}
