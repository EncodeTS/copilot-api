import { scheduler } from "node:timers/promises"

import {
  getTextTokenCount,
  type TokenizerSchedulingOptions,
  type TokenizerYieldControl,
} from "~/lib/tokenizer"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

const RESPONSES_ESTIMATE_SAFETY_FACTOR = 1.07
const RESPONSES_ESTIMATE_MAX_NODES = 10_000
const RESPONSES_ESTIMATE_MAX_DEPTH = 128
const RESPONSES_ESTIMATE_TEXT_CHUNK_CODE_UNITS = 16_384
const yieldToScheduler: TokenizerYieldControl = () => scheduler.yield()

interface SemanticTokenStats {
  objectCount: number
  tokens: number
}

interface SemanticTokenTraversal {
  depthLimit: number
  nodeLimit: number
  nodesVisited: number
  signal?: AbortSignal
  yieldControl: TokenizerYieldControl
}

const getSafeTextChunkEnd = (
  text: string,
  offset: number,
  maximumEnd: number,
): number => {
  if (maximumEnd >= text.length || maximumEnd <= offset) return maximumEnd

  const previous = text.charCodeAt(maximumEnd - 1)
  const next = text.charCodeAt(maximumEnd)
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  return splitsSurrogatePair ? maximumEnd - 1 : maximumEnd
}

const countTextTokensResponsively = async (
  text: string,
  selectedModel: Model,
  yieldControl: TokenizerYieldControl,
  signal?: AbortSignal,
): Promise<number> => {
  let offset = 0
  let tokens = 0
  while (offset < text.length) {
    signal?.throwIfAborted()
    const chunkEnd = getSafeTextChunkEnd(
      text,
      offset,
      Math.min(text.length, offset + RESPONSES_ESTIMATE_TEXT_CHUNK_CODE_UNITS),
    )
    tokens += await getTextTokenCount(
      text.slice(offset, chunkEnd),
      selectedModel,
    )
    offset = chunkEnd
    if (offset < text.length) {
      await yieldControl()
    }
  }
  signal?.throwIfAborted()
  return tokens
}

export class ResponsesTokenEstimateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesTokenEstimateLimitError"
  }
}

const enterSemanticTokenNode = (
  traversal: SemanticTokenTraversal,
  depth: number,
): void => {
  traversal.signal?.throwIfAborted()
  if (depth > traversal.depthLimit) {
    throw new ResponsesTokenEstimateLimitError(
      `Responses token estimate exceeds the maximum depth of ${traversal.depthLimit}`,
    )
  }
  traversal.nodesVisited += 1
  if (traversal.nodesVisited > traversal.nodeLimit) {
    throw new ResponsesTokenEstimateLimitError(
      `Responses token estimate exceeds the maximum node count of ${traversal.nodeLimit}`,
    )
  }
}

const countSemanticTokens = async (
  value: unknown,
  selectedModel: Model,
  includeStructure = false,
  traversal: SemanticTokenTraversal,
  depth = 0,
): Promise<SemanticTokenStats> => {
  enterSemanticTokenNode(traversal, depth)
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    const text = String(value)
    return {
      objectCount: 0,
      tokens: await countTextTokensResponsively(
        text,
        selectedModel,
        traversal.yieldControl,
        traversal.signal,
      ),
    }
  }
  if (Array.isArray(value)) {
    const total = { objectCount: 0, tokens: 0 }
    for (const item of value) {
      const stats = await countSemanticTokens(
        item,
        selectedModel,
        includeStructure,
        traversal,
        depth + 1,
      )
      total.objectCount += stats.objectCount
      total.tokens += stats.tokens
    }
    return total
  }
  if (typeof value !== "object" || value === null) {
    return { objectCount: 0, tokens: 0 }
  }

  let objectCount = includeStructure ? 1 : 0
  let tokens = 0
  for (const [key, child] of Object.entries(value)) {
    const childIncludesStructure =
      includeStructure
      || key === "parameters"
      || key === "schema"
      || key === "tools"
    if (includeStructure) {
      tokens += await countTextTokensResponsively(
        key,
        selectedModel,
        traversal.yieldControl,
        traversal.signal,
      )
    }
    const childStats = await countSemanticTokens(
      child,
      selectedModel,
      childIncludesStructure,
      traversal,
      depth + 1,
    )
    objectCount += childStats.objectCount
    tokens += childStats.tokens
  }
  return { objectCount, tokens }
}

export const estimateResponsesInputTokens = async (
  payload: ResponsesPayload,
  selectedModel: Model,
  options: TokenizerSchedulingOptions = {},
): Promise<number> => {
  const traversal: SemanticTokenTraversal = {
    depthLimit: RESPONSES_ESTIMATE_MAX_DEPTH,
    nodeLimit: RESPONSES_ESTIMATE_MAX_NODES,
    nodesVisited: 0,
    signal: options.signal,
    yieldControl: options.yieldControl ?? yieldToScheduler,
  }
  const fields: Array<[unknown, boolean?]> = [
    [payload.context_management],
    [payload.input],
    [payload.instructions],
    [payload.parallel_tool_calls],
    [payload.reasoning],
    [payload.text, true],
    [payload.tool_choice, true],
    [payload.tools, true],
  ]
  const semanticFields: Array<SemanticTokenStats> = []
  for (const [value, includeStructure] of fields) {
    semanticFields.push(
      await countSemanticTokens(
        value,
        selectedModel,
        includeStructure,
        traversal,
      ),
    )
  }
  const semanticTokens = semanticFields.reduce(
    (total, field) => total + field.tokens + field.objectCount,
    0,
  )
  return Math.ceil(semanticTokens * RESPONSES_ESTIMATE_SAFETY_FACTOR)
}
