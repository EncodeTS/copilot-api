import type { Context } from "hono"

import { HTTPError } from "~/lib/error"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import { prepareCopilotMessagesRequest } from "./prepared-messages/core"
import {
  generatePreparedCopilotMessages,
  preparedMessagesGenerationDependencies,
} from "./prepared-messages/generate"

export const messagesTranslationDependencies =
  preparedMessagesGenerationDependencies

export const handleCopilotMessages = async (
  c: Context,
  payload: AnthropicMessagesPayload,
): Promise<Response> => {
  try {
    return await generatePreparedCopilotMessages(
      c,
      prepareCopilotMessagesRequest(payload),
    )
  } catch (error) {
    if (error instanceof HTTPError) return error.response
    throw error
  }
}
