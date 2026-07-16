import type { CompactType } from "~/lib/compact"
import { isMessagesApiEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { findEndpointModel } from "~/lib/models"
import { createFallbackModel } from "~/lib/provider-model"
import type { SubagentMarker } from "~/lib/subagent"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
} from "~/routes/responses/utils"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import type { AnthropicMessagesPayload } from "../anthropic-types"
import { prepareCopilotChatCompletionsPayload } from "../copilot-chat-payload"
import { translateToOpenAI } from "../non-stream-translation"
import {
  getCompactType,
  IDE_EXECUTE_CODE_TOOL,
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
} from "../preprocess"
import {
  hasTrailingAssistantPrefill,
  translateAnthropicMessagesToResponsesPayload,
} from "../responses-translation"
import { parseSubagentMarkerFromFirstUser } from "../subagent-marker"

const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const preparedBrand = Symbol("PreparedCopilotMessagesRequest")

export interface PreparedCopilotMessagesRequest {
  readonly [preparedBrand]: true
}

interface PreparedCommon {
  compactType?: CompactType
  endpointModel?: Model
  requestIdentityPayload: AnthropicMessagesPayload
  sourcePayload: AnthropicMessagesPayload
  subagentMarker?: SubagentMarker | null
  tokenizerModel: Model
}

export type PreparedCopilotMessagesPlan =
  | (PreparedCommon & {
      countPayload: ChatCompletionsPayload
      countSourcePayload: AnthropicMessagesPayload
      kind: "chat_completions"
      payload: ChatCompletionsPayload
    })
  | (PreparedCommon & {
      kind: "messages"
      fallbackPayload: ChatCompletionsPayload
      payload: AnthropicMessagesPayload
    })
  | (PreparedCommon & {
      endpointModel: Model
      kind: "responses"
      payload: ResponsesPayload
      transport: "http" | "websocket"
    })

const plans = new WeakMap<object, PreparedCopilotMessagesPlan>()

export const preparedMessagesCoreDependencies = {
  findEndpointModel,
  isMessagesApiEnabled,
}

export const prepareCopilotMessagesRequest = (
  input: AnthropicMessagesPayload,
): PreparedCopilotMessagesRequest => {
  const sourcePayload = structuredClone(input)
  normalizeSystemMessages(sourcePayload)
  const subagentMarker = parseSubagentMarkerFromFirstUser(sourcePayload)

  const endpointModel = preparedMessagesCoreDependencies.findEndpointModel(
    sourcePayload.model,
  )
  const tokenizerModel =
    endpointModel ?? createFallbackModel(sourcePayload.model.trim())
  const compactType = getCompactType(sourcePayload)
  const kind = selectFlow(endpointModel, compactType, sourcePayload)

  if (
    kind === "chat_completions"
    && sourcePayload.tool_choice?.type === "tool"
    && sourcePayload.tool_choice.name === IDE_EXECUTE_CODE_TOOL
  ) {
    throw invalidRequestError(
      "mcp__ide__executeCode is not supported by the Chat Completions fallback.",
    )
  }
  if (kind === "responses" && hasTrailingAssistantPrefill(sourcePayload)) {
    throw invalidRequestError(
      "Assistant prefill is not supported by the Responses API bridge.",
    )
  }

  sanitizeIdeTools(sourcePayload, {
    preserveExecuteCode: kind !== "chat_completions",
  })
  const requestIdentityPayload = structuredClone(sourcePayload)
  sourcePayload.model = endpointModel?.id ?? sourcePayload.model

  const common: PreparedCommon = {
    compactType,
    endpointModel,
    requestIdentityPayload,
    sourcePayload,
    subagentMarker,
    tokenizerModel,
  }
  let plan: PreparedCopilotMessagesPlan

  if (kind === "messages") {
    prepareMessagesApiPayload(sourcePayload, endpointModel)
    const fallbackPayload = translateToOpenAI(structuredClone(sourcePayload))
    plan = {
      ...common,
      kind,
      fallbackPayload,
      payload: sourcePayload,
    }
  } else if (kind === "responses") {
    if (!endpointModel) {
      throw new Error("Responses flow selected without a Copilot Model")
    }
    const transport = getResponsesTransportForModel(endpointModel, {
      compactType,
    })
    if (!transport) {
      throw new Error("Responses flow selected without a supported transport")
    }
    const payload = translateAnthropicMessagesToResponsesPayload(
      sourcePayload,
      subagentMarker?.agent_id,
    )
    const contextManagementDecision = applyResponsesApiContextManagement(
      payload,
      endpointModel.capabilities.limits,
      { source: "messages" },
    )
    if (contextManagementDecision.shouldPruneInput) {
      compactInputByLatestCompaction(payload)
    }
    plan = {
      ...common,
      endpointModel,
      kind,
      payload,
      transport,
    }
  } else {
    const payload = translateToOpenAI(sourcePayload, {
      validateReasoningEffort: true,
      reasoningEffortSupport:
        endpointModel?.capabilities.supports.reasoning_effort,
    })
    prepareCopilotChatCompletionsPayload(payload)
    const countSourcePayload =
      endpointModel ? sourcePayload : (
        {
          ...structuredClone(sourcePayload),
          model: tokenizerModel.id,
        }
      )
    const countPayload =
      endpointModel ? payload : (
        translateToOpenAI(countSourcePayload, {
          validateReasoningEffort: true,
          reasoningEffortSupport: undefined,
        })
      )
    if (!endpointModel) {
      prepareCopilotChatCompletionsPayload(countPayload)
    }
    plan = {
      ...common,
      countPayload,
      countSourcePayload,
      kind,
      payload,
    }
  }

  const prepared = Object.freeze({
    [preparedBrand]: true as const,
  })
  plans.set(prepared, plan)
  return prepared
}

export const getPreparedCopilotMessagesPlan = (
  prepared: PreparedCopilotMessagesRequest,
): PreparedCopilotMessagesPlan => {
  const plan = plans.get(prepared)
  if (!plan) throw new TypeError("Unknown Prepared Copilot Messages request")
  return plan
}

const selectFlow = (
  selectedModel: Model | undefined,
  compactType: CompactType | undefined,
  payload: AnthropicMessagesPayload,
): PreparedCopilotMessagesPlan["kind"] => {
  if (
    preparedMessagesCoreDependencies.isMessagesApiEnabled()
    && selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT)
  ) {
    return "messages"
  }
  if (
    !(
      hasTrailingAssistantPrefill(payload)
      && selectedModel?.supported_endpoints?.includes(CHAT_COMPLETIONS_ENDPOINT)
    )
    && getResponsesTransportForModel(selectedModel, { compactType })
  ) {
    return "responses"
  }
  return "chat_completions"
}

const invalidRequestError = (message: string): HTTPError =>
  new HTTPError(
    message,
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message,
        },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 400,
      },
    ),
  )
