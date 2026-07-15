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
import { state } from "~/lib/state"
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

const RESPONSES_ESTIMATE_SAFETY_FACTOR = 1.07
const RESPONSES_ESTIMATE_MAX_NODES = 10_000
const RESPONSES_ESTIMATE_MAX_DEPTH = 128

interface SemanticTokenStats {
  objectCount: number
  tokens: number
}

interface SemanticTokenTraversal {
  depthLimit: number
  nodeLimit: number
  nodesVisited: number
  signal?: AbortSignal
}

export class ResponsesTokenEstimateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesTokenEstimateLimitError"
  }
}

const enterSemanticTokenNode = (
  traversal: SemanticTokenTraversal,
  depth: number,
): void => {
  traversal.signal?.throwIfAborted()
  if (depth > traversal.depthLimit) {
    throw new ResponsesTokenEstimateLimitError(
      `Responses token estimate exceeds the maximum depth of ${traversal.depthLimit}`,
    )
  }
  traversal.nodesVisited += 1
  if (traversal.nodesVisited > traversal.nodeLimit) {
    throw new ResponsesTokenEstimateLimitError(
      `Responses token estimate exceeds the maximum node count of ${traversal.nodeLimit}`,
    )
  }
}

const countSemanticTokens = async (
  value: unknown,
  selectedModel: Model,
  includeStructure = false,
  traversal: SemanticTokenTraversal,
  depth = 0,
): Promise<SemanticTokenStats> => {
  enterSemanticTokenNode(traversal, depth)
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return {
      objectCount: 0,
      tokens: await getTextTokenCount(String(value), selectedModel),
    }
  }
  if (Array.isArray(value)) {
    const total = { objectCount: 0, tokens: 0 }
    for (const item of value) {
      const stats = await countSemanticTokens(
        item,
        selectedModel,
        includeStructure,
        traversal,
        depth + 1,
      )
      total.objectCount += stats.objectCount
      total.tokens += stats.tokens
    }
    return total
  }
  if (typeof value !== "object" || value === null) {
    return { objectCount: 0, tokens: 0 }
  }

  let objectCount = includeStructure ? 1 : 0
  let tokens = 0
  for (const [key, child] of Object.entries(value)) {
    const childIncludesStructure =
      includeStructure
      // Tool and structured-output schemas are prompt material: retain their
      // field names and one boundary token per object, but not JSON punctuation.
      || key === "parameters"
      || key === "schema"
      || key === "tools"
    if (includeStructure) {
      tokens += await getTextTokenCount(key, selectedModel)
    }
    const childStats = await countSemanticTokens(
      child,
      selectedModel,
      childIncludesStructure,
      traversal,
      depth + 1,
    )
    objectCount += childStats.objectCount
    tokens += childStats.tokens
  }
  return { objectCount, tokens }
}

export const estimateResponsesInputTokens = async (
  payload: ResponsesPayload,
  selectedModel: Model,
  options: { signal?: AbortSignal } = {},
): Promise<number> => {
  const traversal: SemanticTokenTraversal = {
    depthLimit: RESPONSES_ESTIMATE_MAX_DEPTH,
    nodeLimit: RESPONSES_ESTIMATE_MAX_NODES,
    nodesVisited: 0,
    signal: options.signal,
  }
  const fields: Array<[unknown, boolean?]> = [
    [payload.context_management],
    [payload.input],
    [payload.instructions],
    [payload.parallel_tool_calls],
    [payload.reasoning],
    [payload.text, true],
    [payload.tool_choice, true],
    [payload.tools, true],
  ]
  const semanticFields: Array<SemanticTokenStats> = []
  for (const [value, includeStructure] of fields) {
    semanticFields.push(
      await countSemanticTokens(
        value,
        selectedModel,
        includeStructure,
        traversal,
      ),
    )
  }
  const semanticTokens = semanticFields.reduce(
    (total, field) => total + field.tokens + field.objectCount,
    0,
  )
  // Copilot does not expose /responses/input_tokens. This is deliberately a
  // conservative local estimate of token-bearing values and schema structure,
  // not a claim of official OpenAI/Copilot token-count parity.
  return Math.ceil(semanticTokens * RESPONSES_ESTIMATE_SAFETY_FACTOR)
}

export const countTokensHandlerDependencies = {
  countCopilotMessagesTokens: countMessagesTokens,
  estimateResponsesInputTokens,
  findEndpointModel,
  getTokenCount,
  hasEndpointModelCatalog: () => state.models !== undefined,
  isMessagesApiEnabled,
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
  if (
    resolve.fallback
    && countTokensHandlerDependencies.hasEndpointModelCatalog()
  ) {
    throw unsupportedCatalogModelError(requestedModel)
  }
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
            signal: c.req.raw.signal,
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
    let inputTokens: number
    try {
      inputTokens =
        await countTokensHandlerDependencies.estimateResponsesInputTokens(
          responsesPayload,
          selectedModel,
          { signal: c.req.raw.signal },
        )
    } catch (error) {
      if (error instanceof ResponsesTokenEstimateLimitError) {
        throw tokenEstimateLimitError(error)
      }
      throw error
    }
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
