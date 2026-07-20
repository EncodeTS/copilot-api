import {
  isAnthropicDocumentBlock,
  isAnthropicDocumentContainerBlock,
  isAnthropicFileDocumentBlock,
  isAnthropicFileImageBlock,
  isAnthropicImageBlock,
  isAnthropicTextBlock,
  isAnthropicToolReferenceBlock,
  type AnthropicToolResultContentBlock,
} from "./anthropic-types"
import { createMessagesInvalidRequestError } from "./invalid-request-error"

const INVALID_TOOL_RESULT_CONTENT_MESSAGE =
  "Anthropic tool_result content must be a string or an array of typed content blocks."

const isRecordWithTypedContent = (
  value: unknown,
): value is Record<string, unknown> & { type: string } =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && "type" in value
  && typeof value.type === "string"
  && value.type.length > 0

const isValidToolResultContentBlock = (
  value: unknown,
): value is AnthropicToolResultContentBlock => {
  if (!isRecordWithTypedContent(value)) {
    return false
  }

  switch (value.type) {
    case "text":
      return isAnthropicTextBlock(value)
    case "image":
      return isAnthropicImageBlock(value) || isAnthropicFileImageBlock(value)
    case "document":
      return (
        isAnthropicDocumentBlock(value)
        || isAnthropicFileDocumentBlock(value)
        || isAnthropicDocumentContainerBlock(value)
      )
    case "tool_reference":
      return isAnthropicToolReferenceBlock(value)
    default:
      return true
  }
}

export const validateAnthropicToolResultContent = (
  content: unknown,
): string | Array<AnthropicToolResultContentBlock> => {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content) && content.every(isValidToolResultContentBlock)) {
    return content
  }

  throw createMessagesInvalidRequestError(INVALID_TOOL_RESULT_CONTENT_MESSAGE)
}
