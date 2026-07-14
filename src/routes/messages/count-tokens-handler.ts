import type { Context } from "hono"

import consola from "consola"

import {
  getClaudeTokenMultiplier,
  isMessagesApiEnabled,
  resolveMappedModel,
} from "~/lib/config"
import {
  createFallbackModel,
  parseProviderModelAlias,
} from "~/lib/provider-model"
import { HTTPError } from "~/lib/error"
import { getTextTokenCount, getTokenCount } from "~/lib/tokenizer"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import { handleProviderCountTokensForProvider } from "~/routes/provider/messages/count-tokens-handler"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
} from "~/routes/responses/utils"
import { countMessagesTokens } from "~/services/copilot/create-messages"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import { type Model } from "~/services/copilot/get-models"

import { findEndpointModel } from "~/lib/models"
import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"
import {
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
} from "./preprocess"
import { translateAnthropicMessagesToResponsesPayload } from "./responses-translation"

const RESPONSES_ESTIMATE_SAFETY_FACTOR = 1.02

export const estimateResponsesInputTokens = async (
  payload: ResponsesPayload,
  selectedModel: Model,
): Promise<number> => {
  const tokenBearingPayload = {
    context_management: payload.context_management,
    input: payload.input,
    instructions: payload.instructions,
    parallel_tool_calls: payload.parallel_tool_calls,
    reasoning: payload.reasoning,
    text: payload.text,
    tool_choice: payload.tool_choice,
    tools: payload.tools,
  }
  const structuralTokens = await getTextTokenCount(
    JSON.stringify(tokenBearingPayload),
    selectedModel,
  )
  return Math.ceil(structuralTokens * RESPONSES_ESTIMATE_SAFETY_FACTOR)
}

export const countTokensHandlerDependencies = {
  countCopilotMessagesTokens: countMessagesTokens,
  estimateResponsesInputTokens,
  findEndpointModel,
  getTokenCount,
  isMessagesApiEnabled,
}

export const resolveCountTokensModel = (
  modelId: string,
  findModel: (sdkModelId: string) => Model | undefined = findEndpointModel,
): { fallback: boolean; model: Model } => {
  const selectedModel = findModel(modelId)
  if (selectedModel) {
    return {
      fallback: false,
      model: selectedModel,
    }
  }

  return {
    fallback: true,
    model: createFallbackModel(modelId.trim()),
  }
}

export async function handleCountTokens(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  normalizeSystemMessages(anthropicPayload)

  const providerModelAlias = parseProviderModelAlias(anthropicPayload.model)
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderCountTokensForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
    })
  }

  const anthropicBeta = c.req.header("anthropic-beta")

  const requestedModel = anthropicPayload.model
  const resolve = resolveCountTokensModel(
    requestedModel,
    countTokensHandlerDependencies.findEndpointModel,
  )
  const selectedModel = resolve.model
  anthropicPayload.model = selectedModel.id
  let messagesCountUnavailable = false
  const useNativeMessagesApi =
    countTokensHandlerDependencies.isMessagesApiEnabled()
    && selectedModel.supported_endpoints?.includes("/v1/messages")

  if (useNativeMessagesApi) {
    sanitizeIdeTools(anthropicPayload, { preserveExecuteCode: true })
    prepareMessagesApiPayload(anthropicPayload, selectedModel)
    const sessionId = getRootSessionId(anthropicPayload, c)
    try {
      const result =
        await countTokensHandlerDependencies.countCopilotMessagesTokens(
          anthropicPayload,
          anthropicBeta,
          {
            requestId: generateRequestIdFromPayload(
              anthropicPayload,
              sessionId,
            ),
            sessionId,
          },
        )
      consola.info("Token count (Copilot Messages API):", result.input_tokens)
      return c.json(result)
    } catch (error) {
      if (
        !(error instanceof HTTPError)
        || (error.response.status !== 404 && error.response.status !== 501)
      ) {
        throw error
      }
      messagesCountUnavailable = true
      consola.warn(
        `Copilot Messages count endpoint unavailable (${error.response.status}); using a local estimate`,
      )
    }
  }

  if (!useNativeMessagesApi) {
    sanitizeIdeTools(anthropicPayload)
  }

  if (
    !messagesCountUnavailable
    && getResponsesTransportForModel(selectedModel)
  ) {
    const responsesPayload =
      translateAnthropicMessagesToResponsesPayload(anthropicPayload)
    const decision = applyResponsesApiContextManagement(
      responsesPayload,
      selectedModel.capabilities.limits,
      { source: "messages" },
    )
    if (decision.shouldPruneInput) {
      compactInputByLatestCompaction(responsesPayload)
    }
    const inputTokens =
      await countTokensHandlerDependencies.estimateResponsesInputTokens(
        responsesPayload,
        selectedModel,
      )
    consola.info("Estimated token count (Responses payload):", inputTokens)
    c.header("x-copilot-api-token-count-mode", "estimate")
    return c.json({ input_tokens: inputTokens })
  }

  // Fallback: local tokenizer estimation for non-Messages models.

  const openAIPayload = translateToOpenAI(anthropicPayload)

  if (resolve.fallback) {
    consola.warn(
      `Model '${requestedModel}' not found, using o200k_base fallback tokenizer`,
    )
  }

  const tokenCount = await countTokensHandlerDependencies.getTokenCount(
    openAIPayload,
    selectedModel,
  )

  if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
    let addToolSystemPromptCount = false
    if (anthropicBeta) {
      const toolsLength = anthropicPayload.tools.length
      addToolSystemPromptCount = !anthropicPayload.tools.some(
        (tool) =>
          tool.name.startsWith("mcp__")
          || (tool.name === "Skill" && toolsLength === 1),
      )
    }
    if (addToolSystemPromptCount) {
      if (anthropicPayload.model.startsWith("claude")) {
        // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
        tokenCount.input = tokenCount.input + 346
      } else if (anthropicPayload.model.startsWith("grok")) {
        tokenCount.input = tokenCount.input + 120
      }
    }
  }

  let finalTokenCount = tokenCount.input + tokenCount.output
  if (anthropicPayload.model.startsWith("claude")) {
    finalTokenCount = Math.round(finalTokenCount * getClaudeTokenMultiplier())
  }

  consola.info("Token count:", finalTokenCount)

  c.header("x-copilot-api-token-count-mode", "estimate")
  return c.json({
    input_tokens: finalTokenCount,
  })
}
