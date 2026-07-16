import { getClaudeTokenMultiplier } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { generateRequestIdFromPayload } from "~/lib/utils"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import { countMessagesTokens } from "~/services/copilot/create-messages"

import type { AnthropicMessagesPayload } from "../anthropic-types"
import type { PreparedCopilotMessagesRequest } from "./core"
import { getPreparedCopilotMessagesPlan } from "./core"
import { estimateResponsesInputTokens } from "./token-estimation"

export interface PreparedMessagesCountResult {
  inputTokens: number
  mode: "authoritative" | "estimate"
}

export const preparedMessagesCountDependencies = {
  countCopilotMessagesTokens: countMessagesTokens,
  estimateResponsesInputTokens,
  getTokenCount,
  hasEndpointModelCatalog: () => state.models !== undefined,
}

export const countPreparedCopilotMessages = async (
  prepared: PreparedCopilotMessagesRequest,
  options: {
    anthropicBetaHeader?: string
    requestId?: string
    sessionId?: string
    signal?: AbortSignal
  } = {},
): Promise<PreparedMessagesCountResult> => {
  const plan = getPreparedCopilotMessagesPlan(prepared)
  if (
    plan.usedFallbackModel
    && preparedMessagesCountDependencies.hasEndpointModelCatalog()
  ) {
    throw unsupportedCatalogModelError(plan.sourcePayload.model)
  }
  if (plan.kind === "responses") {
    return {
      inputTokens:
        await preparedMessagesCountDependencies.estimateResponsesInputTokens(
          plan.payload,
          plan.endpointModel,
          { signal: options.signal },
        ),
      mode: "estimate",
    }
  }
  if (plan.kind === "messages") {
    try {
      const result =
        await preparedMessagesCountDependencies.countCopilotMessagesTokens(
          plan.payload,
          options.anthropicBetaHeader,
          {
            requestId:
              options.requestId
              ?? generateRequestIdFromPayload(plan.payload, options.sessionId),
            sessionId: options.sessionId,
            signal: options.signal,
          },
        )
      return {
        inputTokens: result.input_tokens,
        mode: "authoritative",
      }
    } catch (error) {
      if (
        !(error instanceof HTTPError)
        || (error.response.status !== 404 && error.response.status !== 501)
      ) {
        throw error
      }
    }

    return {
      inputTokens: await estimateChatPayload(
        plan.fallbackPayload,
        plan.sourcePayload,
        plan.tokenizerModel,
        options.anthropicBetaHeader,
      ),
      mode: "estimate",
    }
  }

  return {
    inputTokens: await estimateChatPayload(
      plan.payload,
      plan.sourcePayload,
      plan.tokenizerModel,
      options.anthropicBetaHeader,
    ),
    mode: "estimate",
  }
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

const estimateChatPayload = async (
  payload: ChatCompletionsPayload,
  source: {
    model: string
    tools?: AnthropicMessagesPayload["tools"]
  },
  model: Parameters<typeof getTokenCount>[1],
  anthropicBetaHeader?: string,
): Promise<number> => {
  const tokenCount = await preparedMessagesCountDependencies.getTokenCount(
    payload,
    model,
  )
  if (source.tools && source.tools.length > 0 && anthropicBetaHeader) {
    const toolsLength = source.tools.length
    const addToolSystemPromptCount = !source.tools.some(
      (tool) =>
        tool.name.startsWith("mcp__")
        || (tool.name === "Skill" && toolsLength === 1),
    )
    if (addToolSystemPromptCount) {
      if (source.model.startsWith("claude")) {
        tokenCount.input += 346
      } else if (source.model.startsWith("grok")) {
        tokenCount.input += 120
      }
    }
  }
  let finalTokenCount = tokenCount.input + tokenCount.output
  if (source.model.startsWith("claude")) {
    finalTokenCount = Math.round(finalTokenCount * getClaudeTokenMultiplier())
  }
  return finalTokenCount
}
