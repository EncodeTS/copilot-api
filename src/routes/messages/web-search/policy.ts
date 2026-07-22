import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { HTTPError } from "~/lib/error"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/provider-model"
import { normalizeMessageReasoningEffort } from "~/lib/reasoning-effort"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  isAnthropicCustomTool,
  type AnthropicMessagesPayload,
  type AnthropicTool,
  type AnthropicWebSearchTool,
} from "../anthropic-types"
import type { RestoredWebSearchTurn } from "./carrier-sanitizer"
import { translateAnthropicMessagesToResponsesPayload } from "../responses-translation"
import {
  buildResponsesWebSearchTool,
  type WebSearchToolConfig,
} from "./backend"

const isWebSearchServerTool = (
  tool: AnthropicTool,
): tool is AnthropicWebSearchTool =>
  typeof tool.type === "string"
  && tool.type.startsWith("web_search")
  && !tool.input_schema

/** True when the payload carries an Anthropic server-side web_search tool. */
export const hasWebSearchServerTool = (
  payload: AnthropicMessagesPayload,
): boolean =>
  Array.isArray(payload.tools) && payload.tools.some(isWebSearchServerTool)

/** True when web_search is the only tool in the request. */
export const isWebSearchOnlyRequest = (
  payload: AnthropicMessagesPayload,
): boolean =>
  Array.isArray(payload.tools)
  && payload.tools.length > 0
  && payload.tools.every(isWebSearchServerTool)

export type WebSearchFallbackPlan = {
  downgradeReasons: Array<"dynamic-filtering" | "response-inclusion">
  mode: "direct" | "direct-fallback"
  toolType: string | null
}

const DYNAMIC_FILTERING_WEB_SEARCH_VERSION = 20_260_209

export const resolveWebSearchFallbackPlan = (
  payload: AnthropicMessagesPayload,
): WebSearchFallbackPlan => {
  const tool = payload.tools?.find(isWebSearchServerTool)
  const toolType = tool?.type ?? null
  const versionMatch = /^web_search_(\d{8})$/u.exec(toolType ?? "")
  const version = versionMatch ? Number.parseInt(versionMatch[1], 10) : 0
  const allowedCallers = tool?.allowed_callers
  const dynamicFilteringRequested =
    allowedCallers === undefined ?
      version >= DYNAMIC_FILTERING_WEB_SEARCH_VERSION
    : !allowedCallers.includes("direct")
      || allowedCallers.some((caller) => caller !== "direct")

  const downgradeReasons: WebSearchFallbackPlan["downgradeReasons"] = []
  if (dynamicFilteringRequested) {
    downgradeReasons.push("dynamic-filtering")
    if (tool?.response_inclusion === "excluded") {
      downgradeReasons.push("response-inclusion")
    }
  }

  return {
    downgradeReasons,
    mode: downgradeReasons.length > 0 ? "direct-fallback" : "direct",
    toolType,
  }
}

export const applyWebSearchFallbackHeaders = (
  c: Context,
  payload: AnthropicMessagesPayload,
  logger: ConsolaInstance,
): WebSearchFallbackPlan => {
  const fallbackPlan = resolveWebSearchFallbackPlan(payload)
  c.header("x-copilot-api-web-search-mode", fallbackPlan.mode)
  c.header(
    "x-copilot-api-web-search-carrier",
    "synthetic-without-encrypted-content",
  )
  c.header("x-copilot-api-web-search-stream-mode", "buffered-synthetic-replay")

  if (fallbackPlan.downgradeReasons.length > 0) {
    const downgrade = fallbackPlan.downgradeReasons.join(",")
    c.header("x-copilot-api-web-search-downgrade", downgrade)
    logger.warn(
      "Web search server tool downgraded to direct Responses search",
      {
        downgradeReasons: fallbackPlan.downgradeReasons,
        toolType: fallbackPlan.toolType,
      },
    )
  }

  return fallbackPlan
}

/** A provider route is resolved again against provider type/capability truth. */
export type WebSearchRoute =
  | { kind: "provider"; alias: ProviderModelAlias }
  | { kind: "responses"; model: string }
  | { kind: "unsupported"; message: string }

export const WEB_SEARCH_MIXED_TOOLS_UNSUPPORTED_MESSAGE =
  "Mixed web_search and client tools require a Responses or native Messages adapter"
export const WEB_SEARCH_ROUTE_UNAVAILABLE_MESSAGE =
  "No faithful Web Search route is configured"
export const WEB_SEARCH_PROVIDER_ADAPTER_UNSUPPORTED_MESSAGE =
  "Web Search is not supported by the selected provider adapter"

export const resolveWebSearchRoute = (
  payload: AnthropicMessagesPayload,
  options: { webSearchModel?: string; responsesWebSearchEnabled: boolean },
): WebSearchRoute => {
  const { webSearchModel, responsesWebSearchEnabled } = options
  const fallbackProviderAlias =
    webSearchModel ? parseProviderModelAlias(webSearchModel) : null
  if (fallbackProviderAlias) {
    return { kind: "provider", alias: fallbackProviderAlias }
  }
  if (!hasWebSearchServerTool(payload)) {
    return {
      kind: "unsupported",
      message: WEB_SEARCH_ROUTE_UNAVAILABLE_MESSAGE,
    }
  }
  if (webSearchModel && responsesWebSearchEnabled) {
    return { kind: "responses", model: webSearchModel }
  }
  return {
    kind: "unsupported",
    message: WEB_SEARCH_ROUTE_UNAVAILABLE_MESSAGE,
  }
}

export const createWebSearchUnsupportedResponse = (
  c: Context,
  message = WEB_SEARCH_MIXED_TOOLS_UNSUPPORTED_MESSAGE,
): Response =>
  c.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
      },
    },
    400,
  )

export const createWebSearchInvalidRequestError = (
  message: string,
): HTTPError =>
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
        status: 400,
        headers: { "content-type": "application/json" },
      },
    ),
  )

export const extractWebSearchConfig = (
  payload: AnthropicMessagesPayload,
): WebSearchToolConfig => {
  const tool = payload.tools?.find(isWebSearchServerTool)
  if (
    tool?.max_uses !== undefined
    && (!Number.isSafeInteger(tool.max_uses) || tool.max_uses <= 0)
  ) {
    throw createWebSearchInvalidRequestError(
      "web_search max_uses must be a positive integer",
    )
  }

  return {
    maxUses: tool?.max_uses,
    allowedDomains: tool?.allowed_domains,
    blockedDomains: tool?.blocked_domains,
    userLocation: tool?.user_location,
  }
}

export const prepareWebSearchResponsesPayload = (
  payload: AnthropicMessagesPayload,
  options: {
    model?: string
    restoredWebSearchTurns?: ReadonlyArray<RestoredWebSearchTurn>
    subagentAgentId?: string | null
  } = {},
): ResponsesPayload => {
  const config = extractWebSearchConfig(payload)
  const switchedPayload: AnthropicMessagesPayload = {
    ...payload,
    model: options.model ?? payload.model,
    tools: payload.tools?.filter(isAnthropicCustomTool),
    stream: true,
  }

  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    switchedPayload,
    options.subagentAgentId,
    undefined,
    { restoredWebSearchTurns: options.restoredWebSearchTurns },
  )
  responsesPayload.include = [
    ...new Set([
      ...(responsesPayload.include ?? []),
      "web_search_call.action.sources" as const,
    ]),
  ]
  responsesPayload.tools = [
    ...(responsesPayload.tools ?? []),
    buildResponsesWebSearchTool(config),
  ]
  if (
    typeof config.maxUses === "number"
    && Number.isSafeInteger(config.maxUses)
    && config.maxUses > 0
  ) {
    responsesPayload.max_tool_calls = config.maxUses
  }
  responsesPayload.tool_choice = undefined
  responsesPayload.reasoning = {
    effort: "medium",
    summary: "auto",
  }
  return responsesPayload
}

const getExplicitWebSearchEffort = (
  payload: AnthropicMessagesPayload,
): unknown => {
  const outputConfig: unknown = payload.output_config
  if (
    typeof outputConfig !== "object"
    || outputConfig === null
    || !Object.hasOwn(outputConfig, "effort")
  ) {
    return undefined
  }
  return (outputConfig as { effort?: unknown }).effort
}

export const applyWebSearchReasoningEffort = (
  source: AnthropicMessagesPayload,
  target: ResponsesPayload,
  selectedModel: Model | undefined,
): string | null => {
  const requested = getExplicitWebSearchEffort(source)
  if (requested === undefined) {
    return null
  }
  const effort = normalizeMessageReasoningEffort(requested)
  if (!effort) {
    return "Invalid explicit reasoning effort for web search"
  }
  if (!selectedModel) {
    return `Cannot validate explicit reasoning effort for search model '${target.model}'`
  }
  if (!selectedModel.capabilities.supports.reasoning_effort?.includes(effort)) {
    return `Reasoning effort '${effort}' is not supported by search model '${target.model}'`
  }
  target.reasoning = { ...target.reasoning, effort }
  return null
}
