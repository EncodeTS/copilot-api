import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
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
import {
  MEDIA_FACT_MAX_DEPTH,
  type MediaPathSegment,
} from "~/lib/media-facts/types"
import { iterateAnthropicCanonicalContent } from "~/lib/media-facts/anthropic-content"

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

const visitAnthropicBlock = (
  block: unknown,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  const blockVisit = collector.visit(block, depth, ancestors)
  if (!blockVisit.accepted || !isRecord(block) || !blockVisit.ancestor) return
  const source = isRecord(block.source) ? block.source : undefined
  const sourceVisit =
    source ? collector.visit(source, depth + 1, blockVisit.ancestor) : undefined
  const typedBlock = block as AnthropicToolResultContentBlock

  if (isAnthropicImageBlock(typedBlock)) {
    if (sourceVisit?.ancestor) {
      addAnthropicImageFact(
        typedBlock,
        path,
        depth + 2,
        sourceVisit.ancestor,
        collector,
      )
    }
    return
  }
  if (isAnthropicDocumentBlock(typedBlock)) {
    if (sourceVisit?.ancestor) {
      addAnthropicDocumentFact(
        typedBlock,
        path,
        depth + 2,
        sourceVisit.ancestor,
        collector,
      )
    }
    return
  }
  if (isAnthropicDocumentContainerBlock(block)) {
    if (sourceVisit?.ancestor) {
      if (block.source.type === "text") {
        consume(collector, block.source.data, depth + 3, sourceVisit.ancestor)
      } else if (typeof block.source.content === "string") {
        consume(
          collector,
          block.source.content,
          depth + 3,
          sourceVisit.ancestor,
        )
      }
    }
    return
  }
  const fileBlock =
    isAnthropicFileImageBlock(block) ? block
    : isAnthropicFileDocumentBlock(block) ? block
    : undefined
  if (
    sourceVisit?.ancestor
    && fileBlock
    && isAnthropicFileSource(source)
    && consume(collector, source.file_id, depth + 2, sourceVisit.ancestor)
  ) {
    collector.add(
      createFileIdFact(
        fileBlock.type === "image" ?
          {
            carrier: "anthropic.image.source.file_id",
            mediaKind: "image",
            path: [...path, "source", "file_id"],
            protocol: "anthropic",
          }
        : {
            carrier: "anthropic.document.source.file_id",
            mediaKind: "file",
            path: [...path, "source", "file_id"],
            protocol: "anthropic",
          },
        source.file_id,
      ),
    )
    return
  }
  if (
    block.type === "document"
    && source
    && (source.type === "text" || source.type === "content")
  ) {
    collector.warn("invalid_container")
    return
  }
  // `file_id` is a field of source.type=file, never a source discriminator.
  if (
    (block.type === "document" || block.type === "image")
    && source
    && source.type === "file_id"
  ) {
    return
  }
  if (block.type === "image") {
    collector.add(
      createInvalidValueFact({
        carrier: "anthropic.image.source.data",
        mediaKind: "image",
        path: [...path, "source", "data"],
        protocol: "anthropic",
      }),
    )
    return
  }
  if (block.type === "document") {
    collector.add(
      createInvalidValueFact({
        carrier: "anthropic.document.source.data",
        mediaKind: "file",
        path: [...path, "source", "data"],
        protocol: "anthropic",
      }),
    )
  }
}

export const collectAnthropicMediaFacts = (
  root: Record<string, unknown>,
  rootAncestor: Ancestor,
  collector: FactCollector,
): void => {
  for (const event of iterateAnthropicCanonicalContent(root, {
    maxDepth: MEDIA_FACT_MAX_DEPTH,
    rootAncestor,
  })) {
    if (collector.halted) break
    if (event.kind === "cycle") {
      collector.warn("cycle_detected")
      continue
    }
    if (event.kind === "block") {
      visitAnthropicBlock(
        event.value,
        [...event.path],
        event.depth,
        event.ancestors,
        collector,
      )
      continue
    }
    collector.visit(event.value, event.depth, event.ancestors)
  }
}
