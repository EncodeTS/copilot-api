import type { Context } from "hono"

import consola from "consola"

import { resolveMappedModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getRootSessionId } from "~/lib/utils"
import { routeProviderModelAlias } from "~/routes/provider/model-router"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  countPreparedCopilotMessages,
  prepareCopilotMessagesRequest,
  preparedMessagesCountDependencies,
} from "./prepared-messages"
import { preparedMessagesCoreDependencies } from "./prepared-messages/core"

export {
  estimateResponsesInputTokens,
  ResponsesTokenEstimateLimitError,
} from "./prepared-messages/token-estimation"
import { ResponsesTokenEstimateLimitError } from "./prepared-messages/token-estimation"

export const countTokensHandlerDependencies = {
  get countCopilotMessagesTokens() {
    return preparedMessagesCountDependencies.countCopilotMessagesTokens
  },
  set countCopilotMessagesTokens(
    value: typeof preparedMessagesCountDependencies.countCopilotMessagesTokens,
  ) {
    preparedMessagesCountDependencies.countCopilotMessagesTokens = value
  },
  get estimateResponsesInputTokens() {
    return preparedMessagesCountDependencies.estimateResponsesInputTokens
  },
  set estimateResponsesInputTokens(
    value: typeof preparedMessagesCountDependencies.estimateResponsesInputTokens,
  ) {
    preparedMessagesCountDependencies.estimateResponsesInputTokens = value
  },
  get findEndpointModel() {
    return preparedMessagesCoreDependencies.findEndpointModel
  },
  set findEndpointModel(
    value: typeof preparedMessagesCoreDependencies.findEndpointModel,
  ) {
    preparedMessagesCoreDependencies.findEndpointModel = value
  },
  get getTokenCount() {
    return preparedMessagesCountDependencies.getTokenCount
  },
  set getTokenCount(
    value: typeof preparedMessagesCountDependencies.getTokenCount,
  ) {
    preparedMessagesCountDependencies.getTokenCount = value
  },
  get hasEndpointModelCatalog() {
    return preparedMessagesCountDependencies.hasEndpointModelCatalog
  },
  set hasEndpointModelCatalog(
    value: typeof preparedMessagesCountDependencies.hasEndpointModelCatalog,
  ) {
    preparedMessagesCountDependencies.hasEndpointModelCatalog = value
  },
  get isMessagesApiEnabled() {
    return preparedMessagesCoreDependencies.isMessagesApiEnabled
  },
  set isMessagesApiEnabled(
    value: typeof preparedMessagesCoreDependencies.isMessagesApiEnabled,
  ) {
    preparedMessagesCoreDependencies.isMessagesApiEnabled = value
  },
}

const tokenEstimateLimitError = (
  error: ResponsesTokenEstimateLimitError,
): HTTPError =>
  new HTTPError(
    error.message,
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: error.message,
        },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 400,
      },
    ),
  )

export async function handleCountTokens(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)

  const providerResponse = await routeProviderModelAlias(c, {
    endpoint: "count_tokens",
    payload: anthropicPayload,
  })
  if (providerResponse) return providerResponse

  let result
  try {
    result = await countPreparedCopilotMessages(
      prepareCopilotMessagesRequest(anthropicPayload),
      {
        anthropicBetaHeader: c.req.header("anthropic-beta"),
        sessionId: getRootSessionId(anthropicPayload, c),
        signal: c.req.raw.signal,
      },
    )
  } catch (error) {
    if (error instanceof ResponsesTokenEstimateLimitError) {
      throw tokenEstimateLimitError(error)
    }
    throw error
  }

  if (result.mode === "estimate") {
    consola.info("Estimated token count:", result.inputTokens)
    c.header("x-copilot-api-token-count-mode", "estimate")
  } else {
    consola.info("Token count (Copilot Messages API):", result.inputTokens)
  }
  return c.json({ input_tokens: result.inputTokens })
}
