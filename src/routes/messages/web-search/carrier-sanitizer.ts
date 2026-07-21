import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

export type MessagesDestination = "chat_completions" | "messages" | "responses"

export interface WebSearchCarrierSanitizer {
  sanitize: (
    payload: AnthropicMessagesPayload,
    destination: MessagesDestination,
  ) => void
}

/**
 * The carrier contract belongs to the Web Search lane. Prepared Messages owns
 * only this frozen seam until that contract is implemented.
 */
export const passthroughWebSearchCarrierSanitizer =
  Object.freeze<WebSearchCarrierSanitizer>({
    sanitize: () => {},
  })
