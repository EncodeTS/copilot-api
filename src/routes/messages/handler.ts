import type { Context } from "hono"

import { createHandlerLogger, debugJson } from "~/lib/logger"
import { normalizeMessageReasoningEffort } from "~/lib/reasoning-effort"
import {
  handleProviderMessagesForProvider,
  type ProviderMessagesHandler,
} from "~/routes/provider/messages/handler"
import {
  createProviderModelRouter,
  routeProviderModelAlias,
  type ProviderModelRouter,
} from "~/routes/provider/model-router"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  preparedMessages,
  type PreparedMessagesFacade,
} from "./prepared-messages/facade"
import {
  preparedMessagesPolicy,
  resolvePreparedMessagesModel,
  type PreparedMessagesPolicyPort,
} from "./prepared-messages/policy"
import { createMessagesRequestContext } from "./request-context"
import { tryHandleWebSearch, type WebSearchFlow } from "./web-search/fulfill"
import consola from "consola"

const logger = createHandlerLogger("messages-handler")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface MessagesHandlerComposition {
  preparedMessages?: PreparedMessagesFacade
  preparedMessagesPolicy?: PreparedMessagesPolicyPort
  providerMessages?: Pick<ProviderMessagesHandler, "handleForProvider">
  providerModelRouter?: ProviderModelRouter
  webSearchFlow?: Pick<WebSearchFlow, "tryHandle">
}

interface MessagesHandlerDependencies {
  preparedMessages: PreparedMessagesFacade
  preparedMessagesPolicy: PreparedMessagesPolicyPort
  providerMessages: Pick<ProviderMessagesHandler, "handleForProvider">
  providerModelRouter: ProviderModelRouter
  webSearchFlow: Pick<WebSearchFlow, "tryHandle">
}

export type MessagesHandler = (c: Context) => Promise<Response>

const createDefaultMessagesHandlerDependencies =
  (): MessagesHandlerDependencies => ({
    preparedMessages,
    preparedMessagesPolicy,
    providerMessages: {
      handleForProvider: handleProviderMessagesForProvider,
    },
    providerModelRouter: { route: routeProviderModelAlias },
    webSearchFlow: {
      tryHandle: tryHandleWebSearch,
    },
  })

export const createMessagesHandler = (
  composition: MessagesHandlerComposition = {},
): MessagesHandler => {
  const defaults = createDefaultMessagesHandlerDependencies()
  const providerMessagesPort = Object.freeze({
    ...(composition.providerMessages ?? defaults.providerMessages),
  })
  const dependencies = Object.freeze<MessagesHandlerDependencies>({
    preparedMessages: Object.freeze({
      ...(composition.preparedMessages ?? defaults.preparedMessages),
    }),
    preparedMessagesPolicy: Object.freeze({
      ...(composition.preparedMessagesPolicy
        ?? defaults.preparedMessagesPolicy),
    }),
    providerMessages: providerMessagesPort,
    providerModelRouter: Object.freeze({
      ...(composition.providerModelRouter
        ?? (composition.providerMessages ?
          createProviderModelRouter({
            handleProviderMessagesForProvider:
              providerMessagesPort.handleForProvider,
          })
        : defaults.providerModelRouter)),
    }),
    webSearchFlow: Object.freeze({
      ...(composition.webSearchFlow ?? defaults.webSearchFlow),
    }),
  })

  return (c) => handleCompletionWithDependencies(c, dependencies)
}

export async function handleCompletion(
  c: Context,
  composition?: MessagesHandlerComposition,
): Promise<Response> {
  if (composition) {
    return await createMessagesHandler(composition)(c)
  }
  return await handleCompletionWithDependencies(
    c,
    createDefaultMessagesHandlerDependencies(),
  )
}

const handleCompletionWithDependencies = async (
  c: Context,
  dependencies: MessagesHandlerDependencies,
): Promise<Response> => {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const outputConfig: unknown = anthropicPayload.output_config
  if (isRecord(outputConfig) && Object.hasOwn(outputConfig, "effort")) {
    const effort = normalizeMessageReasoningEffort(outputConfig.effort)
    if (!effort) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Unsupported Messages output_config.effort",
          },
        },
        400,
      )
    }
    anthropicPayload.output_config = {
      ...anthropicPayload.output_config,
      effort,
    }
  }

  const messagesRequestContext = createMessagesRequestContext(
    c,
    anthropicPayload,
    dependencies.preparedMessagesPolicy.snapshot(anthropicPayload.model),
  )
  const requestedModel = anthropicPayload.model
  anthropicPayload.model = resolvePreparedMessagesModel(
    messagesRequestContext.policy,
    anthropicPayload.model,
  )
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  // Explicit provider intent is resolved against the provider's effective
  // protocol before the global Web Search fallback is considered.
  const providerResponse = await dependencies.providerModelRouter.route(c, {
    endpoint: "messages",
    payload: anthropicPayload,
  })
  if (providerResponse) return providerResponse

  const webSearchResult = await dependencies.webSearchFlow.tryHandle(
    c,
    anthropicPayload,
    {
      logger,
      forwardToProvider: (ctx, payload, provider) =>
        dependencies.providerMessages.handleForProvider(ctx, {
          payload,
          provider,
        }),
    },
  )
  if (webSearchResult) return webSearchResult

  debugJson(logger, "Anthropic request payload:", anthropicPayload)
  return await dependencies.preparedMessages.generate(
    messagesRequestContext,
    anthropicPayload,
  )
}
