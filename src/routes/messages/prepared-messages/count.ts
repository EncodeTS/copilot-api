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

export type PreparedMessagesCountResult =
  | {
      mode: "authoritative"
      response: Awaited<ReturnType<typeof countMessagesTokens>>
    }
  | {
      fallbackStatus?: 404 | 501
      inputTokens: number
      mode: "estimate"
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
    let fallbackStatus: 404 | 501 | undefined
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
        mode: "authoritative",
        response: result,
      }
    } catch (error) {
      if (
        !(error instanceof HTTPError)
        || (error.response.status !== 404 && error.response.status !== 501)
      ) {
        throw error
      }
      fallbackStatus = error.response.status
    }

    return {
      fallbackStatus,
      inputTokens: await estimateChatPayload(
        plan.fallbackPayload,
        plan.sourcePayload,
        plan.tokenizerModel,
        options.anthropicBetaHeader,
        options.signal,
      ),
      mode: "estimate",
    }
  }

  return {
    inputTokens: await estimateChatPayload(
      plan.countPayload,
      plan.countSourcePayload,
      plan.tokenizerModel,
      options.anthropicBetaHeader,
      options.signal,
    ),
    mode: "estimate",
  }
}

const estimateChatPayload = async (
  payload: ChatCompletionsPayload,
  source: {
    model: string
    tools?: AnthropicMessagesPayload["tools"]
  },
  model: Parameters<typeof getTokenCount>[1],
  anthropicBetaHeader?: string,
  signal?: AbortSignal,
): Promise<number> => {
  signal?.throwIfAborted()
  const tokenCount = await preparedMessagesCountDependencies.getTokenCount(
    payload,
    model,
    { signal },
  )
  signal?.throwIfAborted()
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
