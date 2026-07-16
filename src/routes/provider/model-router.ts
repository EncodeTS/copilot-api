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

export const routeProviderModelAlias = async (
  c: Context,
  request: ProviderModelRequest,
): Promise<Response | null> => {
  const alias = parseProviderModelAlias(request.payload.model)
  if (!alias) return null

  request.payload.model = alias.model

  switch (request.endpoint) {
    case "chat_completions":
      return await handleProviderChatCompletionsForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "count_tokens":
      return await handleProviderCountTokensForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "messages":
      return await handleProviderMessagesForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
    case "responses":
      return await handleProviderResponsesForProvider(c, {
        payload: request.payload,
        provider: alias.provider,
      })
  }
}
