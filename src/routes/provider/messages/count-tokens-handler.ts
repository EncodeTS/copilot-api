import type { Context, Env } from "hono"

import { createHandlerLogger } from "~/lib/logger"
import { resolveProviderModel } from "~/lib/provider-resolver"
import { createFallbackModel } from "~/lib/provider-model"
import { getTokenCount } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"

const logger = createHandlerLogger("provider-count-tokens-handler")

export async function handleProviderCountTokens(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderCountTokensForProvider(c, { payload, provider })
}

export async function handleProviderCountTokensForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  const { payload: anthropicPayload, provider } = options
  normalizeSystemMessages(anthropicPayload)
  const modelId = anthropicPayload.model.trim()

  const resolvedProviderModel = await resolveProviderModel(provider, modelId, {
    signal: c.req.raw.signal,
  })
  if (!resolvedProviderModel) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  const { modelConfig, type } = resolvedProviderModel
  const translationOptions =
    type === "openai-compatible" || type === "openai-responses" ?
      {
        supportPdf: modelConfig?.supportPdf,
        toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
      }
    : undefined

  const openAIPayload = translateToOpenAI(anthropicPayload, translationOptions)

  const selectedModel = createFallbackModel(modelId)

  const tokenCount = await getTokenCount(openAIPayload, selectedModel)
  const finalTokenCount = tokenCount.input + tokenCount.output

  logger.debug("provider.count_tokens.success", {
    provider,
    model: anthropicPayload.model,
    input_tokens: finalTokenCount,
  })

  return c.json({
    input_tokens: finalTokenCount,
  })
}
