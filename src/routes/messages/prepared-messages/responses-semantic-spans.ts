import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

const MAX_NODES = 10_000
const MAX_DEPTH = 128
const MAX_METADATA_ENTRIES = 16
const MAX_METADATA_KEY_CODE_UNITS = 64
const MAX_METADATA_VALUE_CODE_UNITS = 512

export interface ResponsesSemanticSpanCollection {
  readonly structuralTokens: number
  readonly texts: ReadonlyArray<string>
  readonly unknownMediaItems: number
}

interface MutableSemanticSpanCollection {
  structuralTokens: number
  texts: Array<string>
  unknownMediaItems: number
}

interface SemanticSpanTraversal {
  readonly ancestors: Set<object>
  readonly collection: MutableSemanticSpanCollection
  nodesVisited: number
  readonly signal?: AbortSignal
}

export class ResponsesSemanticSpanLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesSemanticSpanLimitError"
  }
}

const enterNode = (
  traversal: SemanticSpanTraversal,
  value: unknown,
  depth: number,
): (() => void) => {
  traversal.signal?.throwIfAborted()
  if (depth > MAX_DEPTH) {
    throw new ResponsesSemanticSpanLimitError(
      `Responses token estimate exceeds the maximum depth of ${MAX_DEPTH}`,
    )
  }
  traversal.nodesVisited += 1
  if (traversal.nodesVisited > MAX_NODES) {
    throw new ResponsesSemanticSpanLimitError(
      `Responses token estimate exceeds the maximum node count of ${MAX_NODES}`,
    )
  }
  if (typeof value !== "object" || value === null) return () => {}
  if (traversal.ancestors.has(value)) {
    throw new ResponsesSemanticSpanLimitError(
      "Responses token estimate contains a cyclic input structure",
    )
  }
  traversal.ancestors.add(value)
  return () => traversal.ancestors.delete(value)
}

const addText = (
  traversal: SemanticSpanTraversal,
  value: unknown,
  maximumCodeUnits?: number,
): void => {
  if (typeof value !== "string" || value.length === 0) return
  const text =
    maximumCodeUnits === undefined ? value : value.slice(0, maximumCodeUnits)
  if (text.length > 0) traversal.collection.texts.push(text)
}

const collectSchema = (
  value: unknown,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, value, depth)
  try {
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      addText(traversal, String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collectSchema(item, traversal, depth + 1)
      return
    }
    if (typeof value !== "object" || value === null) return

    traversal.collection.structuralTokens += 1
    for (const [key, child] of Object.entries(value)) {
      addText(traversal, key)
      collectSchema(child, traversal, depth + 1)
    }
  } finally {
    leave()
  }
}

const collectKnownValues = (
  value: unknown,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, value, depth)
  try {
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      addText(traversal, String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collectKnownValues(item, traversal, depth + 1)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const child of Object.values(value)) {
      collectKnownValues(child, traversal, depth + 1)
    }
  } finally {
    leave()
  }
}

const collectMetadata = (
  metadata: ResponsesPayload["metadata"],
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  if (!metadata) return
  const leave = enterNode(traversal, metadata, depth)
  try {
    traversal.collection.structuralTokens += 1
    const entries = Object.entries(metadata).slice(0, MAX_METADATA_ENTRIES)
    for (const [key, value] of entries) {
      enterNode(traversal, value, depth + 1)()
      addText(traversal, key, MAX_METADATA_KEY_CODE_UNITS)
      addText(traversal, value, MAX_METADATA_VALUE_CODE_UNITS)
    }
  } finally {
    leave()
  }
}

const collectContent = (
  content: string | Array<ResponseInputContent> | undefined,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, content, depth)
  try {
    if (typeof content === "string") {
      addText(traversal, content)
      return
    }
    if (!Array.isArray(content)) return

    for (const block of content) {
      const leaveBlock = enterNode(traversal, block, depth + 1)
      try {
        if (typeof block !== "object" || block === null) {
          traversal.collection.unknownMediaItems += 1
          continue
        }
        traversal.collection.structuralTokens += 1
        if (block.type === "input_text" || block.type === "output_text") {
          addText(traversal, block.text)
          continue
        }
        if (block.type === "input_file") {
          addText(traversal, block.filename, MAX_METADATA_VALUE_CODE_UNITS)
          continue
        }
        if (block.type === "input_image") continue

        traversal.collection.unknownMediaItems += 1
      } finally {
        leaveBlock()
      }
    }
  } finally {
    leave()
  }
}

const collectReasoningSummary = (
  summary: unknown,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, summary, depth)
  try {
    if (!Array.isArray(summary)) return
    for (const block of summary) {
      const leaveBlock = enterNode(traversal, block, depth + 1)
      try {
        if (typeof block === "object" && block !== null) {
          addText(traversal, (block as Record<string, unknown>).text)
          traversal.collection.structuralTokens += 1
        }
      } finally {
        leaveBlock()
      }
    }
  } finally {
    leave()
  }
}

const collectCodeInterpreterOutputs = (
  outputs: unknown,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, outputs, depth)
  try {
    if (!Array.isArray(outputs)) return
    for (const output of outputs) {
      const leaveOutput = enterNode(traversal, output, depth + 1)
      try {
        if (typeof output !== "object" || output === null) continue
        const record = output as Record<string, unknown>
        traversal.collection.structuralTokens += 1
        if (record.type === "logs") addText(traversal, record.logs)
      } finally {
        leaveOutput()
      }
    }
  } finally {
    leave()
  }
}

const collectInputItem = (
  item: ResponseInputItem,
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, item, depth)
  try {
    if (typeof item !== "object" || item === null) return
    const record = item as Record<string, unknown>
    traversal.collection.structuralTokens += 1

    if (
      (record.type === undefined || record.type === "message")
      && typeof record.role === "string"
    ) {
      collectContent(
        record.content as string | Array<ResponseInputContent> | undefined,
        traversal,
        depth + 1,
      )
      return
    }
    if (record.type === "function_call") {
      addText(traversal, record.name)
      addText(traversal, record.arguments)
      return
    }
    if (record.type === "function_call_output") {
      collectContent(
        record.output as string | Array<ResponseInputContent> | undefined,
        traversal,
        depth + 1,
      )
      return
    }
    if (record.type === "tool_search_call") {
      if (typeof record.arguments === "string") {
        addText(traversal, record.arguments)
      } else {
        collectSchema(record.arguments, traversal, depth + 1)
      }
      return
    }
    if (record.type === "tool_search_output") {
      collectSchema(record.tools, traversal, depth + 1)
      return
    }
    if (record.type === "reasoning") {
      collectReasoningSummary(record.summary, traversal, depth + 1)
      return
    }
    if (record.type === "compaction" || record.type === "compaction_trigger") {
      return
    }
    if (record.type === "additional_tools") {
      collectSchema(record.tools, traversal, depth + 1)
      return
    }
    if (
      record.type === "computer_call_output"
      || record.type === "image_generation_call"
    ) {
      return
    }
    if (record.type === "code_interpreter_call") {
      addText(traversal, record.code)
      collectCodeInterpreterOutputs(record.outputs, traversal, depth + 1)
      return
    }

    traversal.collection.unknownMediaItems += 1
  } finally {
    leave()
  }
}

const collectInput = (
  input: ResponsesPayload["input"],
  traversal: SemanticSpanTraversal,
  depth: number,
): void => {
  const leave = enterNode(traversal, input, depth)
  try {
    if (typeof input === "string") {
      addText(traversal, input)
      return
    }
    if (!Array.isArray(input)) return
    for (const item of input) collectInputItem(item, traversal, depth + 1)
  } finally {
    leave()
  }
}

export const collectResponsesSemanticSpans = (
  payload: ResponsesPayload,
  signal?: AbortSignal,
): ResponsesSemanticSpanCollection => {
  const traversal: SemanticSpanTraversal = {
    ancestors: new Set(),
    collection: { structuralTokens: 0, texts: [], unknownMediaItems: 0 },
    nodesVisited: 0,
    signal,
  }

  enterNode(traversal, payload, 0)()
  addText(traversal, payload.instructions)
  collectInput(payload.input, traversal, 1)
  if (payload.context_management !== undefined) {
    collectKnownValues(payload.context_management, traversal, 1)
  }
  if (payload.parallel_tool_calls !== undefined) {
    collectKnownValues(payload.parallel_tool_calls, traversal, 1)
  }
  if (payload.reasoning !== undefined) {
    collectKnownValues(payload.reasoning, traversal, 1)
  }
  if (payload.text !== undefined) collectSchema(payload.text, traversal, 1)
  if (payload.tool_choice !== undefined) {
    collectSchema(payload.tool_choice, traversal, 1)
  }
  if (payload.tools !== undefined) {
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      traversal.collection.structuralTokens += 1
    }
    collectSchema(payload.tools, traversal, 1)
  }
  collectMetadata(payload.metadata, traversal, 1)

  return Object.freeze({
    structuralTokens: traversal.collection.structuralTokens,
    texts: Object.freeze([...traversal.collection.texts]),
    unknownMediaItems: traversal.collection.unknownMediaItems,
  })
}
