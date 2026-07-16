import type { Context } from "hono"

import consola from "consola"

import { resolveMappedModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getRootSessionId } from "~/lib/utils"
import { routeProviderModelAlias } from "~/routes/provider/model-router"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  countPreparedCopilotMessages,
  preparedMessagesCountDependencies,
} from "./prepared-messages/count"
import {
  prepareCopilotMessagesRequest,
  preparedMessagesCoreDependencies,
} from "./prepared-messages/core"

export {
  estimateResponsesInputTokens,
  ResponsesTokenEstimateLimitError,
} from "./prepared-messages/token-estimation"
import { ResponsesTokenEstimateLimitError } from "./prepared-messages/token-estimation"

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

  if (
    !preparedMessagesCoreDependencies.findEndpointModel(anthropicPayload.model)
    && preparedMessagesCountDependencies.hasEndpointModelCatalog()
  ) {
    throw unsupportedCatalogModelError(anthropicPayload.model)
  }

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

const unsupportedCatalogModelError = (model: string): HTTPError =>
  new HTTPError(
    "Requested model is absent from the current Copilot model catalog",
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `The requested model is not supported by the current Copilot model catalog: ${model}`,
        },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 400,
      },
    ),
  )
