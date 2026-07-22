import type { Context } from "hono"

import consola from "consola"

import { routeProviderModelAlias } from "~/routes/provider/model-router"

import { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import {
  preparedMessages,
  type PreparedMessagesFacade,
} from "~/routes/messages/prepared-messages/facade"
import {
  preparedMessagesPolicy,
  resolvePreparedMessagesModel,
  type PreparedMessagesPolicyPort,
} from "~/routes/messages/prepared-messages/policy"
import { createMessagesRequestContext } from "~/routes/messages/request-context"

export {
  estimateResponsesInputTokens,
  ResponsesTokenEstimateLimitError,
} from "~/routes/messages/prepared-messages/token-estimation"
interface CountTokensHandlerComposition {
  preparedMessages: PreparedMessagesFacade
  preparedMessagesPolicy: PreparedMessagesPolicyPort
}

const defaultCountTokensHandlerComposition = Object.freeze({
  preparedMessages,
  preparedMessagesPolicy,
})

export async function handleCountTokens(
  c: Context,
  composition: CountTokensHandlerComposition = defaultCountTokensHandlerComposition,
) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const messagesRequestContext = createMessagesRequestContext(
    c,
    anthropicPayload,
    composition.preparedMessagesPolicy.snapshot(anthropicPayload.model),
  )
  anthropicPayload.model = resolvePreparedMessagesModel(
    messagesRequestContext.policy,
    anthropicPayload.model,
  )

  const providerResponse = await routeProviderModelAlias(c, {
    endpoint: "count_tokens",
    payload: anthropicPayload,
  })
  if (providerResponse) return providerResponse

  const result = await composition.preparedMessages.count(
    messagesRequestContext,
    anthropicPayload,
  )

  if (result.mode === "authoritative") {
    consola.info(
      "Token count (Copilot Messages API):",
      result.response.input_tokens,
    )
    return c.json(result.response)
  }

  if (result.fallbackStatus) {
    consola.warn(
      `Copilot Messages count endpoint unavailable (${result.fallbackStatus}); using a local estimate`,
    )
  }
  consola.info("Estimated token count:", result.inputTokens)
  c.header("x-copilot-api-token-count-mode", "estimate")
  return c.json({ input_tokens: result.inputTokens })
}
