import type {
  AnthropicDocumentBlock,
  AnthropicDocumentContainerBlock,
  AnthropicImageBlock,
  AnthropicMessagesPayload,
  AnthropicToolResultContentBlock,
} from "~/routes/messages/anthropic-types"
import {
  isAnthropicDocumentBlock,
  isAnthropicDocumentContainerBlock,
  isAnthropicFileDocumentBlock,
  isAnthropicFileImageBlock,
  isAnthropicFileSource,
  isAnthropicImageBlock,
} from "~/routes/messages/anthropic-types"

import {
  createInvalidValueFact,
  createFileIdFact,
  createRawBase64Fact,
  createUrlOrDataFact,
} from "~/lib/media-facts/fact-builders"
import {
  type Ancestor,
  FactCollector,
  isRecord,
} from "~/lib/media-facts/collector"
import type { MediaPathSegment } from "~/lib/media-facts/types"

const consume = (
  collector: FactCollector,
  value: unknown,
  depth: number,
  ancestors: Ancestor,
): boolean => collector.visit(value, depth, ancestors).accepted

const addAnthropicImageFact = (
  block: AnthropicImageBlock,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (block.source.type === "url") {
    if (consume(collector, block.source.url, depth, ancestors)) {
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "anthropic.image.source.url",
            mediaKind: "image",
            path: [...path, "source", "url"],
            protocol: "anthropic",
          },
          block.source.url,
        ),
      )
    }
    return
  }
  if (consume(collector, block.source.data, depth, ancestors)) {
    collector.add(
      createRawBase64Fact(
        {
          carrier: "anthropic.image.source.data",
          mediaKind: "image",
          path: [...path, "source", "data"],
          protocol: "anthropic",
        },
        block.source.data,
        block.source.media_type,
      ),
    )
  }
}

const addAnthropicDocumentFact = (
  block: AnthropicDocumentBlock,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (block.source.type === "url") {
    if (consume(collector, block.source.url, depth, ancestors)) {
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "anthropic.document.source.url",
            mediaKind: "file",
            path: [...path, "source", "url"],
            protocol: "anthropic",
          },
          block.source.url,
        ),
      )
    }
    return
  }
  if (consume(collector, block.source.data, depth, ancestors)) {
    collector.add(
      createRawBase64Fact(
        {
          carrier: "anthropic.document.source.data",
          mediaKind: "file",
          path: [...path, "source", "data"],
          protocol: "anthropic",
        },
        block.source.data,
        block.source.media_type,
      ),
    )
  }
}

const visitDocumentContainer = (
  block: AnthropicDocumentContainerBlock,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (block.source.type === "text") {
    consume(collector, block.source.data, depth + 1, ancestors)
    return
  }
  if (typeof block.source.content === "string") {
    consume(collector, block.source.content, depth + 1, ancestors)
    return
  }
  visitAnthropicContent(
    block.source.content,
    [...path, "source", "content"],
    depth + 1,
    ancestors,
    collector,
  )
}

const visitAnthropicContent = (
  content: Array<unknown>,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  const contentVisit = collector.visit(content, depth, ancestors)
  if (!contentVisit.ancestor) return
  for (let index = 0; index < content.length && !collector.halted; index += 1) {
    const block = content[index]
    const blockVisit = collector.visit(block, depth + 1, contentVisit.ancestor)
    if (!blockVisit.accepted || !isRecord(block) || !blockVisit.ancestor)
      continue
    const blockPath = [...path, index]
    const source = isRecord(block.source) ? block.source : undefined
    const sourceVisit =
      source ?
        collector.visit(source, depth + 2, blockVisit.ancestor)
      : undefined
    const typedBlock = block as AnthropicToolResultContentBlock

    if (isAnthropicImageBlock(typedBlock)) {
      if (sourceVisit?.ancestor) {
        addAnthropicImageFact(
          typedBlock,
          blockPath,
          depth + 3,
          sourceVisit.ancestor,
          collector,
        )
      }
      continue
    }
    if (isAnthropicDocumentBlock(typedBlock)) {
      if (sourceVisit?.ancestor) {
        addAnthropicDocumentFact(
          typedBlock,
          blockPath,
          depth + 3,
          sourceVisit.ancestor,
          collector,
        )
      }
      continue
    }
    if (isAnthropicDocumentContainerBlock(block)) {
      if (sourceVisit?.ancestor) {
        visitDocumentContainer(
          block,
          blockPath,
          depth + 3,
          sourceVisit.ancestor,
          collector,
        )
      }
      continue
    }
    const fileBlock =
      isAnthropicFileImageBlock(block) ? block
      : isAnthropicFileDocumentBlock(block) ? block
      : undefined
    if (
      sourceVisit?.ancestor
      && fileBlock
      && isAnthropicFileSource(source)
      && consume(collector, source.file_id, depth + 3, sourceVisit.ancestor)
    ) {
      collector.add(
        createFileIdFact(
          fileBlock.type === "image" ?
            {
              carrier: "anthropic.image.source.file_id",
              mediaKind: "image",
              path: [...blockPath, "source", "file_id"],
              protocol: "anthropic",
            }
          : {
              carrier: "anthropic.document.source.file_id",
              mediaKind: "file",
              path: [...blockPath, "source", "file_id"],
              protocol: "anthropic",
            },
          source.file_id,
        ),
      )
      continue
    }
    if (
      block.type === "document"
      && source
      && (source.type === "text" || source.type === "content")
    ) {
      collector.warn("invalid_container")
      continue
    }
    // `file_id` is a field of source.type=file, never a source discriminator.
    if (
      (block.type === "document" || block.type === "image")
      && source
      && source.type === "file_id"
    ) {
      continue
    }
    if (block.type === "image") {
      collector.add(
        createInvalidValueFact({
          carrier: "anthropic.image.source.data",
          mediaKind: "image",
          path: [...blockPath, "source", "data"],
          protocol: "anthropic",
        }),
      )
      continue
    }
    if (block.type === "document") {
      collector.add(
        createInvalidValueFact({
          carrier: "anthropic.document.source.data",
          mediaKind: "file",
          path: [...blockPath, "source", "data"],
          protocol: "anthropic",
        }),
      )
      continue
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      visitAnthropicContent(
        block.content,
        [...blockPath, "content"],
        depth + 2,
        blockVisit.ancestor,
        collector,
      )
    }
    // tool_use.input and every other arbitrary object are deliberately opaque.
  }
}

export const collectAnthropicMediaFacts = (
  root: Record<string, unknown>,
  rootAncestor: Ancestor,
  collector: FactCollector,
): void => {
  if (!Array.isArray(root.messages)) return
  const payload = root as unknown as AnthropicMessagesPayload
  const messagesVisit = collector.visit(payload.messages, 1, rootAncestor)
  if (!messagesVisit.ancestor) return
  for (
    let messageIndex = 0;
    messageIndex < payload.messages.length && !collector.halted;
    messageIndex += 1
  ) {
    const message = payload.messages[messageIndex]
    const messageVisit = collector.visit(message, 2, messagesVisit.ancestor)
    if (
      !messageVisit.accepted
      || !isRecord(message)
      || !messageVisit.ancestor
    ) {
      continue
    }
    if (message.role !== "user") continue
    if (!Array.isArray(message.content)) {
      consume(collector, message.content, 3, messageVisit.ancestor)
      continue
    }
    visitAnthropicContent(
      message.content,
      ["messages", messageIndex, "content"],
      3,
      messageVisit.ancestor,
      collector,
    )
  }
}
