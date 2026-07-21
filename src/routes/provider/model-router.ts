import type { Context } from "hono"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { parseProviderModelAlias } from "~/lib/provider-model"

import { handleProviderChatCompletionsForProvider } from "./chat-completions/handler"
import { handleProviderCountTokensForProvider } from "./messages/count-tokens-handler"
import { handleProviderMessagesForProvider } from "./messages/handler"
import { handleProviderResponsesForProvider } from "./responses/handler"

type ProviderModelRequest =
  | {
      endpoint: "chat_completions"
      payload: ChatCompletionsPayload
    }
  | {
      endpoint: "count_tokens"
      payload: AnthropicMessagesPayload
    }
  | {
      endpoint: "messages"
      payload: AnthropicMessagesPayload
    }
  | {
      endpoint: "responses"
      payload: ResponsesPayload
    }

export interface ProviderModelRouter {
  route: (c: Context, request: ProviderModelRequest) => Promise<Response | null>
}

export interface ProviderModelRouterComposition {
  handleProviderChatCompletionsForProvider?: typeof handleProviderChatCompletionsForProvider
  handleProviderCountTokensForProvider?: typeof handleProviderCountTokensForProvider
  handleProviderMessagesForProvider?: typeof handleProviderMessagesForProvider
  handleProviderResponsesForProvider?: typeof handleProviderResponsesForProvider
}

const createDefaultProviderModelRouterDependencies =
  (): Required<ProviderModelRouterComposition> => ({
    handleProviderChatCompletionsForProvider,
    handleProviderCountTokensForProvider,
    handleProviderMessagesForProvider,
    handleProviderResponsesForProvider,
  })

export const createProviderModelRouter = (
  composition: ProviderModelRouterComposition = {},
): ProviderModelRouter => {
  const defaults = createDefaultProviderModelRouterDependencies()
  const dependencies = Object.freeze({
    handleProviderChatCompletionsForProvider:
      composition.handleProviderChatCompletionsForProvider
      ?? defaults.handleProviderChatCompletionsForProvider,
    handleProviderCountTokensForProvider:
      composition.handleProviderCountTokensForProvider
      ?? defaults.handleProviderCountTokensForProvider,
    handleProviderMessagesForProvider:
      composition.handleProviderMessagesForProvider
      ?? defaults.handleProviderMessagesForProvider,
    handleProviderResponsesForProvider:
      composition.handleProviderResponsesForProvider
      ?? defaults.handleProviderResponsesForProvider,
  })
  const router: ProviderModelRouter = {
    route: (c, request) =>
      routeProviderModelAliasWithDependencies(c, request, dependencies),
  }
  return Object.freeze(router)
}

export const routeProviderModelAlias = async (
  c: Context,
  request: ProviderModelRequest,
): Promise<Response | null> =>
  await routeProviderModelAliasWithDependencies(
    c,
    request,
    createDefaultProviderModelRouterDependencies(),
  )

const routeProviderModelAliasWithDependencies = async (
  c: Context,
  request: ProviderModelRequest,
  dependencies: Required<ProviderModelRouterComposition>,
): Promise<Response | null> => {
  const alias = parseProviderModelAlias(request.payload.model)
  if (!alias) return null

  request.payload.model = alias.model

  switch (request.endpoint) {
    case "chat_completions":
      return await dependencies.handleProviderChatCompletionsForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "count_tokens":
      return await dependencies.handleProviderCountTokensForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "messages":
      return await dependencies.handleProviderMessagesForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "responses":
      return await dependencies.handleProviderResponsesForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
  }
}
