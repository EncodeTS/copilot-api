import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { checkRateLimit as checkConfiguredRateLimit } from "~/lib/rate-limit"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import {
  createStandardizedCodexResponsesEventStream,
  forwardCodexResponses,
  normalizeCodexResponsesEvent,
} from "~/services/codex/create-responses"
import {
  createProviderProxyResponse,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "./utils"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  checkRateLimit: checkConfiguredRateLimit,
  createResponses: createCopilotResponses,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  debugJson(logger, "Responses request payload:", payload)

  const providerModelAlias = parseProviderModelAlias(payload.model)
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  await responsesHandlerDependencies.checkRateLimit(state)

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload({ messages: payload.input })
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  removeUnsupportedTools(payload)

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  compactInputByLatestCompaction(payload)

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const responsesTransport = getResponsesTransportForModel(selectedModel)

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  debugJson(logger, "Translated Responses payload:", payload)

  const { vision, initiator } = getResponsesRequestOptions(payload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await responsesHandlerDependencies.createResponses(payload, {
    vision,
    initiator,
    requestId,
    sessionId: sessionId,
    transport: responsesTransport,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let usage: UsageTokens = {}

      for await (const chunk of response) {
        debugJson(logger, "Responses stream chunk:", chunk)
        const parsedEvent = parseResponsesStreamEvent(chunk)
        if (
          parsedEvent?.type === "response.completed"
          || parsedEvent?.type === "response.failed"
          || parsedEvent?.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(parsedEvent.response.usage)
        }

        const processedData = fixStreamIds(
          (chunk as { data?: string }).data ?? "",
          (chunk as { event?: string }).event,
          idTracker,
        )

        await stream.writeSSE({
          id: (chunk as { id?: string }).id,
          event: (chunk as { event?: string }).event,
          data: processedData,
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage(normalizeResponsesUsage((response as ResponsesResult).usage))
  return c.json(response as ResponsesResult)
}

const handleProviderResponsesForProvider = async (
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
  },
): Promise<Response> => {
  const { payload, provider } = options
  const providerConfig = await resolveProviderConfig(provider)
  if (providerConfig?.type !== "openai-responses") {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/responses endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const upstreamResponse =
    providerConfig.name === "codex" ?
      await forwardCodexResponses(
        payload,
        c.req.raw.headers,
        providerConfig.baseUrl,
      )
    : await forwardProviderResponses(providerConfig, payload, c.req.raw.headers)

  if (!upstreamResponse.ok) {
    throw new HTTPError(
      `Failed to create ${provider} responses`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderResponsesUsageRecorder(payload, provider)

  if (payload.stream) {
    void recordProviderResponsesStreamUsage(upstreamResponse.clone(), {
      normalizeCodex: providerConfig.name === "codex",
      provider,
      recordUsage,
    })
  } else {
    const responseBody = (await upstreamResponse
      .clone()
      .json()) as ResponsesResult
    recordUsage(normalizeResponsesUsage(responseBody.usage))
  }

  if (providerConfig.name === "codex" && payload.stream) {
    return createProviderProxyResponse(
      upstreamResponse,
      createStandardizedCodexResponsesEventStream(
        getResponsesEvents(upstreamResponse),
      ),
    )
  }

  return createProviderProxyResponse(upstreamResponse)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const createProviderResponsesUsageRecorder = (
  payload: ResponsesPayload,
  provider: string,
): ((usage: UsageTokens) => void) => {
  const sessionAffinity =
    requestContext.getStore()?.sessionAffinity?.trim() || null

  return createProviderTokenUsageRecorder({
    endpoint: "responses",
    model: payload.model,
    providerName: provider,
    sessionId: sessionAffinity ?? "",
  })
}

const recordProviderResponsesStreamUsage = async (
  upstreamResponse: unknown,
  options: {
    normalizeCodex: boolean
    provider: string
    recordUsage: (usage: UsageTokens) => void
  },
): Promise<void> => {
  let usage: UsageTokens = {}

  try {
    for await (const chunk of getResponsesEvents(upstreamResponse)) {
      debugJson(logger, "Responses stream chunk:", chunk)
      if (!chunk.data || chunk.data === "[DONE]") {
        continue
      }

      const parsed = parseProviderResponsesStreamEvent(chunk.data, {
        normalizeCodex: options.normalizeCodex,
        provider: options.provider,
      })
      if (
        parsed?.type === "response.completed"
        || parsed?.type === "response.failed"
        || parsed?.type === "response.incomplete"
      ) {
        usage = normalizeResponsesUsage(parsed.response.usage)
      }
    }
  } finally {
    options.recordUsage(usage)
  }
}

const parseProviderResponsesStreamEvent = (
  data: string,
  options: {
    normalizeCodex: boolean
    provider: string
  },
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    return options.normalizeCodex ?
        normalizeCodexResponsesEvent(parsed)
      : parsed
  } catch (error) {
    logger.error("provider.responses.parse_chunk_error", {
      provider: options.provider,
      data,
      error,
    })
    return null
  }
}

const getResponsesEvents = (response: unknown) => {
  return events(response as Parameters<typeof events>[0])
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type)) {
      dropped.push(type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}
