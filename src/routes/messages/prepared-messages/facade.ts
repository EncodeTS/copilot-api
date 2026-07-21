import type { CompactType } from "~/lib/compact"
import { deepFreeze } from "~/lib/deep-freeze"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { normalizeSdkModelId } from "~/lib/models"
import { createFallbackModel } from "~/lib/provider-model"
import type { SubagentMarker } from "~/lib/subagent"
import { getTokenCount } from "~/lib/tokenizer"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  handlePreparedChatCompletions,
  handlePreparedMessagesApi,
  handlePreparedResponsesApi,
  messagesApiFlowDependencies,
  type FlowBaseOptions,
  type MessagesApiFlowDependencies,
} from "~/routes/messages/api-flows"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { prepareCopilotChatCompletionsPayload } from "~/routes/messages/copilot-chat-payload"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import {
  getCompactType,
  IDE_EXECUTE_CODE_TOOL,
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
} from "~/routes/messages/preprocess"
import type { MessagesRequestContext } from "~/routes/messages/request-context"
import {
  hasTrailingAssistantPrefill,
  translateAnthropicMessagesToResponsesPayload,
} from "~/routes/messages/responses-translation"
import { parseSubagentMarkerFromFirstUser } from "~/routes/messages/subagent-marker"
import {
  passthroughWebSearchCarrierSanitizer,
  type WebSearchCarrierSanitizer,
} from "~/routes/messages/web-search/carrier-sanitizer"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
} from "~/routes/responses/utils"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import { countMessagesTokens } from "~/services/copilot/create-messages"
import type {
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  PreparedMessagesInvalidRequestError,
  PreparedMessagesUnsupportedModelError,
} from "./errors"
import {
  resolvePreparedMessagesModel,
  type PreparedMessagesPolicySnapshot,
} from "./policy"
import { estimateResponsesInputTokens } from "./token-estimation"

const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"
const logger = createHandlerLogger("prepared-messages")

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

export interface PreparedMessagesFacade {
  count: (
    context: MessagesRequestContext,
    payload: AnthropicMessagesPayload,
  ) => Promise<PreparedMessagesCountResult>
  generate: (
    context: MessagesRequestContext,
    payload: AnthropicMessagesPayload,
  ) => Promise<Response>
}

type ChatFlow = typeof handlePreparedChatCompletions
type MessagesFlow = typeof handlePreparedMessagesApi
type ResponsesFlow = typeof handlePreparedResponsesApi

export interface PreparedMessagesComposition {
  carrierSanitizer?: WebSearchCarrierSanitizer
  countCopilotMessagesTokens?: typeof countMessagesTokens
  estimateResponsesInputTokens?: typeof estimateResponsesInputTokens
  flowDependencies?: MessagesApiFlowDependencies
  getTokenCount?: typeof getTokenCount
  handleWithChatCompletions?: ChatFlow
  handleWithMessagesApi?: MessagesFlow
  handleWithResponsesApi?: ResponsesFlow
}

interface PreparedCommon {
  compactType?: CompactType
  endpointModel?: Model
  requestIdentityPayload: AnthropicMessagesPayload
  sourcePayload: AnthropicMessagesPayload
  subagentMarker?: SubagentMarker | null
  tokenizerModel: Model
}

type PreparedPlan =
  | (PreparedCommon & {
      countPayload: ChatCompletionsPayload
      countSourcePayload: AnthropicMessagesPayload
      kind: "chat_completions"
      payload: ChatCompletionsPayload
    })
  | (PreparedCommon & {
      fallbackSnapshot: AnthropicMessagesPayload
      kind: "messages"
      payload: AnthropicMessagesPayload
    })
  | (PreparedCommon & {
      endpointModel: Model
      kind: "responses"
      payload: ResponsesPayload
      transport: ResponsesTransport
    })

type DestinationDecision =
  | { kind: "chat_completions" }
  | { kind: "messages" }
  | {
      endpointModel: Model
      kind: "responses"
      transport: ResponsesTransport
    }

interface PreparedMessagesDependencies {
  carrierSanitizer: WebSearchCarrierSanitizer
  countCopilotMessagesTokens: typeof countMessagesTokens
  estimateResponsesInputTokens: typeof estimateResponsesInputTokens
  flowDependencies: Readonly<MessagesApiFlowDependencies>
  getTokenCount: typeof getTokenCount
  handleWithChatCompletions: ChatFlow
  handleWithMessagesApi: MessagesFlow
  handleWithResponsesApi: ResponsesFlow
}

export const createPreparedMessagesFacade = (
  composition: PreparedMessagesComposition = {},
): PreparedMessagesFacade => {
  const dependencies = Object.freeze<PreparedMessagesDependencies>({
    carrierSanitizer: Object.freeze({
      ...(composition.carrierSanitizer ?? passthroughWebSearchCarrierSanitizer),
    }),
    countCopilotMessagesTokens:
      composition.countCopilotMessagesTokens ?? countMessagesTokens,
    estimateResponsesInputTokens:
      composition.estimateResponsesInputTokens ?? estimateResponsesInputTokens,
    flowDependencies: Object.freeze({
      ...(composition.flowDependencies ?? messagesApiFlowDependencies),
    }),
    getTokenCount: composition.getTokenCount ?? getTokenCount,
    handleWithChatCompletions:
      composition.handleWithChatCompletions ?? handlePreparedChatCompletions,
    handleWithMessagesApi:
      composition.handleWithMessagesApi ?? handlePreparedMessagesApi,
    handleWithResponsesApi:
      composition.handleWithResponsesApi ?? handlePreparedResponsesApi,
  })

  const facade: PreparedMessagesFacade = {
    count: async (context, payload) => {
      const { policy } = context
      const mappedPayload = mapPayloadModel(payload, policy)
      if (
        !findEndpointModel(policy.models, mappedPayload.model)
        && policy.catalogLoaded
      ) {
        throw new PreparedMessagesUnsupportedModelError(mappedPayload.model)
      }
      const plan = preparePlan(mappedPayload, policy, dependencies)
      return await countPreparedPlan(context, plan, policy, dependencies)
    },
    generate: async (context, payload) => {
      const { policy } = context
      const mappedPayload = mapPayloadModel(payload, policy)
      return await generatePreparedPlan(
        context,
        preparePlan(mappedPayload, policy, dependencies),
        dependencies,
      )
    },
  }
  return Object.freeze(facade)
}

export const preparedMessages = createPreparedMessagesFacade()

const mapPayloadModel = (
  payload: AnthropicMessagesPayload,
  policy: PreparedMessagesPolicySnapshot,
): AnthropicMessagesPayload => {
  const mapped = structuredClone(payload)
  mapped.model = resolvePreparedMessagesModel(policy, mapped.model)
  return mapped
}

const preparePlan = (
  input: AnthropicMessagesPayload,
  policy: PreparedMessagesPolicySnapshot,
  dependencies: PreparedMessagesDependencies,
): PreparedPlan => {
  const sourcePayload = structuredClone(input)
  normalizeSystemMessages(sourcePayload)
  const subagentMarker = parseSubagentMarkerFromFirstUser(sourcePayload)
  const endpointModel = findEndpointModel(policy.models, sourcePayload.model)
  const tokenizerModel =
    endpointModel ?? createFallbackModel(sourcePayload.model.trim())
  const compactType = getCompactType(sourcePayload)
  const destination = selectFlow(
    endpointModel,
    compactType,
    sourcePayload,
    policy,
  )
  const { kind } = destination

  if (
    kind === "chat_completions"
    && sourcePayload.tool_choice?.type === "tool"
    && sourcePayload.tool_choice.name === IDE_EXECUTE_CODE_TOOL
  ) {
    throw new PreparedMessagesInvalidRequestError(
      "mcp__ide__executeCode is not supported by the Chat Completions fallback.",
    )
  }
  if (kind === "responses" && hasTrailingAssistantPrefill(sourcePayload)) {
    throw new PreparedMessagesInvalidRequestError(
      "Assistant prefill is not supported by the Responses API bridge.",
    )
  }

  dependencies.carrierSanitizer.sanitize(sourcePayload, kind)
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

  if (kind === "messages") {
    prepareMessagesApiPayload(sourcePayload, endpointModel, {
      reasoningEffort: policy.reasoningEffort,
    })
    const snapshot = deepFreeze(sourcePayload)
    return {
      ...common,
      fallbackSnapshot: snapshot,
      kind,
      payload: snapshot,
      sourcePayload: snapshot,
    }
  }

  if (kind === "responses") {
    const { endpointModel: responsesModel, transport } = destination
    const payload = translateAnthropicMessagesToResponsesPayload(
      sourcePayload,
      subagentMarker?.agent_id,
      undefined,
      {
        extraPrompt: policy.extraPrompt,
        reasoningEffort: policy.reasoningEffort,
      },
    )
    const configuredThreshold =
      policy.modelResponsesApiCompactThresholds[payload.model]
    const contextManagementDecision = applyResponsesApiContextManagement(
      payload,
      responsesModel.capabilities.limits,
      {
        contextManagementEnabled: policy.contextManagementMessages,
        modelCompactThreshold:
          (
            typeof configuredThreshold === "number"
            && Number.isFinite(configuredThreshold)
            && configuredThreshold > 0
          ) ?
            configuredThreshold
          : null,
        source: "messages",
      },
    )
    if (contextManagementDecision.shouldPruneInput) {
      compactInputByLatestCompaction(payload)
    }
    return {
      ...common,
      endpointModel: responsesModel,
      kind,
      payload,
      transport,
    }
  }

  const payload = translateToOpenAI(sourcePayload, {
    model: endpointModel ?? null,
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
        model: null,
        validateReasoningEffort: true,
        reasoningEffortSupport: undefined,
      })
    )
  if (!endpointModel) {
    prepareCopilotChatCompletionsPayload(countPayload)
  }
  return {
    ...common,
    countPayload,
    countSourcePayload,
    kind,
    payload,
  }
}

const generatePreparedPlan = async (
  context: MessagesRequestContext,
  plan: PreparedPlan,
  dependencies: PreparedMessagesDependencies,
): Promise<Response> => {
  const { sourcePayload, subagentMarker } = plan
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const reasoningRecoverySessionId = context.reasoningRecoverySessionId
  let sessionId = reasoningRecoverySessionId
  const requestId = generateRequestIdFromPayload(
    plan.requestIdentityPayload,
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)
  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  const options: FlowBaseOptions & {
    anthropicBetaHeader?: string
    selectedModel?: Model
  } = {
    anthropicBetaHeader: context.anthropicBetaHeader,
    compactType: plan.compactType,
    logger,
    reasoningRecoverySessionId,
    requestId,
    selectedModel: plan.endpointModel,
    sessionId,
    signal: context.signal,
    subagentMarker,
  }

  if (plan.kind === "messages") {
    return await dependencies.handleWithMessagesApi(
      context.response,
      plan.payload,
      options,
      dependencies.flowDependencies,
    )
  }
  if (plan.kind === "responses") {
    return await dependencies.handleWithResponsesApi(
      context.response,
      sourcePayload,
      options,
      plan.payload,
      plan.transport,
      dependencies.flowDependencies,
    )
  }
  return await dependencies.handleWithChatCompletions(
    context.response,
    sourcePayload,
    options,
    plan.payload,
    dependencies.flowDependencies,
  )
}

const countPreparedPlan = async (
  context: MessagesRequestContext,
  plan: PreparedPlan,
  policy: PreparedMessagesPolicySnapshot,
  dependencies: PreparedMessagesDependencies,
): Promise<PreparedMessagesCountResult> => {
  if (plan.kind === "responses") {
    return {
      inputTokens: await dependencies.estimateResponsesInputTokens(
        plan.payload,
        plan.endpointModel,
        { signal: context.signal },
      ),
      mode: "estimate",
    }
  }

  if (plan.kind === "messages") {
    let fallbackStatus: 404 | 501 | undefined
    try {
      const response = await dependencies.countCopilotMessagesTokens(
        plan.payload,
        context.anthropicBetaHeader,
        {
          requestId: generateRequestIdFromPayload(
            plan.payload,
            context.reasoningRecoverySessionId,
          ),
          sessionId: context.reasoningRecoverySessionId,
          signal: context.signal,
        },
      )
      return { mode: "authoritative", response }
    } catch (error) {
      if (
        !(error instanceof HTTPError)
        || (error.response.status !== 404 && error.response.status !== 501)
      ) {
        throw error
      }
      fallbackStatus = error.response.status
    }

    const fallbackPayload = deepFreeze(
      translateToOpenAI(plan.fallbackSnapshot, {
        model: plan.endpointModel ?? null,
      }),
    )
    return {
      fallbackStatus,
      inputTokens: await estimateChatPayload(
        fallbackPayload,
        plan.sourcePayload,
        plan.tokenizerModel,
        context,
        policy.claudeTokenMultiplier,
        dependencies,
      ),
      mode: "estimate",
    }
  }

  return {
    inputTokens: await estimateChatPayload(
      plan.countPayload,
      plan.countSourcePayload,
      plan.tokenizerModel,
      context,
      policy.claudeTokenMultiplier,
      dependencies,
    ),
    mode: "estimate",
  }
}

const estimateChatPayload = async (
  payload: ChatCompletionsPayload,
  source: Pick<AnthropicMessagesPayload, "model" | "tools">,
  model: Model,
  context: MessagesRequestContext,
  claudeTokenMultiplier: number,
  dependencies: PreparedMessagesDependencies,
): Promise<number> => {
  context.signal.throwIfAborted()
  const tokenCount = await dependencies.getTokenCount(payload, model, {
    signal: context.signal,
  })
  context.signal.throwIfAborted()
  if (source.tools && source.tools.length > 0 && context.anthropicBetaHeader) {
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
    finalTokenCount = Math.round(finalTokenCount * claudeTokenMultiplier)
  }
  return finalTokenCount
}

const selectFlow = (
  selectedModel: Model | undefined,
  compactType: CompactType | undefined,
  payload: AnthropicMessagesPayload,
  policy: PreparedMessagesPolicySnapshot,
): DestinationDecision => {
  if (
    policy.useMessagesApi
    && selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT)
  ) {
    return { kind: "messages" }
  }
  const responsesTransport = getResponsesTransportForModel(selectedModel, {
    compactType,
    useWebSocket: policy.useResponsesApiWebSocket,
  })
  if (
    selectedModel
    && responsesTransport
    && !(
      hasTrailingAssistantPrefill(payload)
      && selectedModel?.supported_endpoints?.includes(CHAT_COMPLETIONS_ENDPOINT)
    )
  ) {
    return {
      endpointModel: selectedModel,
      kind: "responses",
      transport: responsesTransport,
    }
  }
  return { kind: "chat_completions" }
}

const findEndpointModel = (
  models: ReadonlyArray<Model>,
  sdkModelId: string,
): Model | undefined => {
  const exactMatch = models.find((model) => model.id === sdkModelId)
  if (exactMatch) return exactMatch

  const normalized = normalizeSdkModelId(sdkModelId)
  if (!normalized) return undefined
  const endpointId = `claude-${normalized.family}-${normalized.version}`
  return models.find((model) => model.id === endpointId)
}
