import type { Context } from "hono"

import { events } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { requestContext } from "~/lib/request-context"
import {
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { applyResponsesApiContextManagement } from "~/routes/responses/utils"
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"
import {
  createStandardizedCodexResponsesEventStream,
  forwardCodexResponses,
  normalizeCodexResponsesEvent,
} from "~/services/codex/create-responses"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-responses-handler")

export async function handleProviderResponsesForProvider(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  debugJson(logger, "Responses request payload:", {
    payload,
    provider,
  })
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

  const model =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined

  const maxPromptTokens = model?.capabilities.limits.max_prompt_tokens ?? 0
  applyResponsesApiContextManagement(payload, maxPromptTokens)

  const contextManagement = payload.context_management
  debugJson(logger, "Translated Responses request payload:", {
    contextManagement,
    provider,
  })

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

  if (providerConfig.name === "codex" && payload.stream) {
    let usage: UsageTokens = {}

    return createProviderProxyResponse(
      upstreamResponse,
      createStandardizedCodexResponsesEventStream(
        getResponsesEvents(upstreamResponse),
        {
          onClose: () => {
            recordUsage(usage)
          },
          onChunk: (chunk) => {
            debugJson(logger, "Responses stream chunk:", chunk)
          },
          onEvent: (event) => {
            const nextUsage = getResponsesStreamEventUsage(event)
            if (nextUsage) {
              usage = nextUsage
            }
          },
        },
      ),
    )
  }

  if (payload.stream) {
    void recordProviderResponsesStreamUsage(upstreamResponse.clone(), {
      normalizeCodex: providerConfig.name === "codex",
      provider,
      recordUsage,
    }).catch((error) => {
      logger.warn("provider.responses.usage_stream_error", {
        provider,
        error: getErrorMessage(error),
      })
    })
  } else {
    const responseBody = (await upstreamResponse
      .clone()
      .json()) as ResponsesResult
    recordUsage(normalizeResponsesUsage(responseBody.usage))
  }

  return createProviderProxyResponse(upstreamResponse)
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
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
      if (parsed) {
        const nextUsage = getResponsesStreamEventUsage(parsed)
        if (nextUsage) {
          usage = nextUsage
        }
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

const getResponsesStreamEventUsage = (
  event: ResponseStreamEvent,
): UsageTokens | null => {
  if (
    event.type === "response.completed"
    || event.type === "response.failed"
    || event.type === "response.incomplete"
  ) {
    return normalizeResponsesUsage(event.response.usage)
  }

  return null
}

const getResponsesEvents = (response: unknown) => {
  return events(response as Parameters<typeof events>[0])
}
