import { collectMediaFacts, type MediaFact } from "~/lib/media-facts"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

/**
 * Versioned local profile. It is deliberately an estimate: authoritative
 * provider count endpoints take precedence over every value in this module.
 */
export const CHAT_MEDIA_TOKEN_PROFILE = "chat-conservative-2026-07-21"

const IMAGE_PATCH_EDGE_PIXELS = 28
const MAX_IMAGE_TOKENS = 32_768
const MAX_FILE_TOKENS = 32_768
const CONSERVATIVE_UNKNOWN_MEDIA_TOKENS = 32_768
const FILE_TOKEN_BYTES = 3

export interface ChatMediaTokenEstimate {
  readonly input: number
  readonly output: number
  readonly profile: typeof CHAT_MEDIA_TOKEN_PROFILE
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const estimateImageTokens = (fact: Readonly<MediaFact>): number => {
  if (fact.warnings.length > 0 || !fact.image) {
    return CONSERVATIVE_UNKNOWN_MEDIA_TOKENS
  }
  // Anthropic's public image profile uses 28px patches. Keeping the raw patch
  // count (up to this local profile's explicit cap) is conservative when the
  // upstream would resize an oversized image before inference.
  const patches =
    Math.ceil(fact.image.width / IMAGE_PATCH_EDGE_PIXELS)
    * Math.ceil(fact.image.height / IMAGE_PATCH_EDGE_PIXELS)
  return clamp(patches, 1, MAX_IMAGE_TOKENS)
}

const estimateFileTokens = (fact: Readonly<MediaFact>): number => {
  if (fact.warnings.length > 0) return CONSERVATIVE_UNKNOWN_MEDIA_TOKENS
  const decodedBytes = fact.base64?.decodedBytes
  if (decodedBytes === undefined) return CONSERVATIVE_UNKNOWN_MEDIA_TOKENS
  // No public closed formula covers every file type. This bounded byte proxy
  // therefore remains an explicitly versioned estimate, never an exact count.
  return clamp(Math.ceil(decodedBytes / FILE_TOKEN_BYTES), 1, MAX_FILE_TOKENS)
}

export const estimateMediaFactTokens = (fact: Readonly<MediaFact>): number => {
  switch (fact.mediaKind) {
    case "audio":
      return CONSERVATIVE_UNKNOWN_MEDIA_TOKENS
    case "file":
      return estimateFileTokens(fact)
    case "image":
      return estimateImageTokens(fact)
  }
}

/**
 * Estimates only canonical media facts. Carrier strings never leave the media
 * fact collector and are never returned, logged, or passed to a tokenizer.
 */
export const estimateChatMediaTokens = (
  payload: ChatCompletionsPayload,
): ChatMediaTokenEstimate => {
  const collection = collectMediaFacts(payload, { protocol: "chat" })
  let input = collection.warnings.length * CONSERVATIVE_UNKNOWN_MEDIA_TOKENS
  let output = 0

  for (const fact of collection.facts) {
    const tokens = estimateMediaFactTokens(fact)
    const messageIndex = fact.path[0] === "messages" ? fact.path[1] : undefined
    const message =
      typeof messageIndex === "number" ? payload.messages[messageIndex] : null
    if (message?.role === "assistant") output += tokens
    else input += tokens
  }

  return { input, output, profile: CHAT_MEDIA_TOKEN_PROFILE }
}
