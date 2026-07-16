import type { Context } from "hono"

import { resolveMappedModel } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { handleProviderMessagesForProvider } from "~/routes/provider/messages/handler"
import { routeProviderModelAlias } from "~/routes/provider/model-router"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import { handleCopilotMessages } from "./translation-orchestrator"
import { tryHandleWebSearch } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")

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

  const providerResponse = await routeProviderModelAlias(c, {
    endpoint: "messages",
    payload: anthropicPayload,
  })
  if (providerResponse) return providerResponse

  debugJson(logger, "Anthropic request payload:", anthropicPayload)
  return await handleCopilotMessages(c, anthropicPayload)
}
