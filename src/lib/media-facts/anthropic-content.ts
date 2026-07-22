import type { MediaPathSegment } from "~/lib/media-facts/types"

export interface AnthropicContentAncestor {
  readonly parent?: AnthropicContentAncestor
  readonly value: object
}

interface AnthropicContentValueEvent {
  readonly ancestors: AnthropicContentAncestor
  readonly depth: number
  readonly kind: "block" | "content" | "message" | "messages" | "scalar_content"
  readonly path: ReadonlyArray<MediaPathSegment>
  readonly value: unknown
}

interface AnthropicContentCycleEvent {
  readonly depth: number
  readonly kind: "cycle"
  readonly path: ReadonlyArray<MediaPathSegment>
}

export type AnthropicCanonicalContentEvent =
  | AnthropicContentCycleEvent
  | AnthropicContentValueEvent

export interface AnthropicCanonicalContentIteratorOptions {
  /** Optional consumer-owned traversal bound; the iterator has no default cap. */
  readonly maxDepth?: number
  /** Existing root ancestry for consumers that already admitted the payload. */
  readonly rootAncestor?: AnthropicContentAncestor
}

interface ContentWork {
  ancestors: AnthropicContentAncestor
  content: Array<unknown>
  depth: number
  kind: "content"
  path: Array<MediaPathSegment>
}

interface MessageWork {
  ancestors: AnthropicContentAncestor
  depth: number
  index: number
  kind: "message"
  value: unknown
}

interface BlockWork {
  ancestors: AnthropicContentAncestor
  block: unknown
  depth: number
  index: number
  kind: "block"
  path: Array<MediaPathSegment>
}

type Work = BlockWork | ContentWork | MessageWork

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasAncestor = (
  value: object,
  ancestors: AnthropicContentAncestor | undefined,
): boolean => {
  let ancestor = ancestors
  while (ancestor) {
    if (ancestor.value === value) return true
    ancestor = ancestor.parent
  }
  return false
}

const extendAncestors = (
  value: object,
  ancestors: AnthropicContentAncestor,
): AnthropicContentAncestor => ({ parent: ancestors, value })

const mayDescend = (depth: number, maxDepth: number | undefined): boolean =>
  maxDepth === undefined || depth <= maxDepth

const isDocumentContentBlock = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type !== "image" || !isRecord(value.source)) return false
  if (value.source.type === "base64") {
    return (
      Object.hasOwn(value.source, "data")
      && Object.hasOwn(value.source, "media_type")
    )
  }
  if (value.source.type === "url") return Object.hasOwn(value.source, "url")
  if (value.source.type === "file") {
    return Object.hasOwn(value.source, "file_id")
  }
  return false
}

const getDocumentContent = (
  block: Record<string, unknown>,
): Array<unknown> | undefined => {
  if (block.type !== "document" || !isRecord(block.source)) return undefined
  if (block.source.type !== "content" || !Array.isArray(block.source.content)) {
    return undefined
  }
  return block.source.content.every(isDocumentContentBlock) ?
      block.source.content
    : undefined
}

/**
 * Iterates only protocol-owned Anthropic content paths. It performs no media
 * decoding/probing and has no media-fact cap; consumers own their own limits.
 */
export function* iterateAnthropicCanonicalContent(
  root: unknown,
  options: AnthropicCanonicalContentIteratorOptions = {},
): Generator<AnthropicCanonicalContentEvent> {
  if (!isRecord(root) || !Array.isArray(root.messages)) return

  const rootAncestor = options.rootAncestor ?? { value: root }
  if (hasAncestor(root.messages, rootAncestor)) {
    yield { depth: 1, kind: "cycle", path: ["messages"] }
    return
  }
  yield {
    ancestors: rootAncestor,
    depth: 1,
    kind: "messages",
    path: ["messages"],
    value: root.messages,
  }
  if (!mayDescend(1, options.maxDepth)) return
  const messagesAncestor = extendAncestors(root.messages, rootAncestor)
  const work: Array<Work> = []
  for (let index = root.messages.length - 1; index >= 0; index -= 1) {
    work.push({
      ancestors: messagesAncestor,
      depth: 2,
      index,
      kind: "message",
      value: root.messages[index],
    })
  }

  while (work.length > 0) {
    const current = work.pop()
    if (!current) continue

    if (current.kind === "message") {
      const messagePath: Array<MediaPathSegment> = ["messages", current.index]
      yield {
        ancestors: current.ancestors,
        depth: current.depth,
        kind: "message",
        path: messagePath,
        value: current.value,
      }
      if (!mayDescend(current.depth, options.maxDepth)) continue
      if (
        !isRecord(current.value)
        || current.value.role !== "user"
        || hasAncestor(current.value, current.ancestors)
      ) {
        continue
      }
      const messageAncestor = extendAncestors(current.value, current.ancestors)
      const contentPath: Array<MediaPathSegment> = [...messagePath, "content"]
      if (Array.isArray(current.value.content)) {
        work.push({
          ancestors: messageAncestor,
          content: current.value.content,
          depth: current.depth + 1,
          kind: "content",
          path: contentPath,
        })
      } else {
        yield {
          ancestors: messageAncestor,
          depth: current.depth + 1,
          kind: "scalar_content",
          path: contentPath,
          value: current.value.content,
        }
      }
      continue
    }

    if (current.kind === "content") {
      if (hasAncestor(current.content, current.ancestors)) {
        yield {
          depth: current.depth,
          kind: "cycle",
          path: current.path,
        }
        continue
      }
      yield {
        ancestors: current.ancestors,
        depth: current.depth,
        kind: "content",
        path: current.path,
        value: current.content,
      }
      if (!mayDescend(current.depth, options.maxDepth)) continue
      const contentAncestor = extendAncestors(
        current.content,
        current.ancestors,
      )
      for (let index = current.content.length - 1; index >= 0; index -= 1) {
        work.push({
          ancestors: contentAncestor,
          block: current.content[index],
          depth: current.depth + 1,
          index,
          kind: "block",
          path: current.path,
        })
      }
      continue
    }

    const blockPath = [...current.path, current.index]
    yield {
      ancestors: current.ancestors,
      depth: current.depth,
      kind: "block",
      path: blockPath,
      value: current.block,
    }
    if (!mayDescend(current.depth, options.maxDepth)) continue
    if (
      !isRecord(current.block)
      || hasAncestor(current.block, current.ancestors)
    ) {
      continue
    }
    const blockAncestor = extendAncestors(current.block, current.ancestors)
    if (
      current.block.type === "tool_result"
      && Array.isArray(current.block.content)
    ) {
      work.push({
        ancestors: blockAncestor,
        content: current.block.content,
        depth: current.depth + 1,
        kind: "content",
        path: [...blockPath, "content"],
      })
      continue
    }
    const documentContent = getDocumentContent(current.block)
    if (!documentContent) continue
    const source = current.block.source as Record<string, unknown>
    if (hasAncestor(source, blockAncestor)) continue
    work.push({
      ancestors: extendAncestors(source, blockAncestor),
      content: documentContent,
      depth: current.depth + 3,
      kind: "content",
      path: [...blockPath, "source", "content"],
    })
  }
}
