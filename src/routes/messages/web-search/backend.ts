import type {
  ResponseOutputMessage,
  ResponseOutputWebSearchCall,
  ResponsesResult,
} from "~/services/copilot/create-responses"
import {
  WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH,
  WEB_SEARCH_HISTORY_MAX_DECODED_BYTES,
  WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS,
  WEB_SEARCH_HISTORY_MAX_TOTAL_NODES,
} from "./history-carrier"

export interface WebSearchSource {
  url: string
  title: string
  page_age?: string | null
}

export interface WebSearchCitation extends WebSearchSource {
  citedText?: string
  endIndex?: number
  startIndex?: number
}

export interface WebSearchTextBlock {
  citations: Array<WebSearchCitation>
  text: string
  type: "output_text" | "refusal"
}

interface WebSearchActionBase {
  pattern?: string
  queries?: Array<string>
  query?: string
  sources: Array<WebSearchSource>
  url?: string
}

export type WebSearchExecutableAction =
  | (WebSearchActionBase & { type: "search" })
  | (WebSearchActionBase & { type: "open" | "open_page"; url: string })
  | (WebSearchActionBase & {
      type: "find" | "find_in_page"
      pattern: string
      url: string
    })

export type WebSearchAction =
  | WebSearchExecutableAction
  | (WebSearchActionBase & { type?: never })

type WebSearchCallBase = { id?: string }
export type WebSearchCall =
  | (WebSearchCallBase & {
      action: WebSearchExecutableAction
      status: "completed" | "in_progress" | "searching"
    })
  | (WebSearchCallBase & {
      action: WebSearchAction
      status: "failed"
    })

export interface WebSearchExtract {
  /** The grounded answer text produced by the GPT backend (with inline cites). */
  answerText: string
  /** Every Web Search call in upstream order. */
  calls: Array<WebSearchCall>
  /** Sources in upstream order. Repeated URLs are intentionally retained. */
  sources: Array<WebSearchSource>
  /** Search queries the backend actually ran. */
  queries: Array<string>
  /** Number of web_search_call output items the backend actually emitted. */
  callCount: number
  /** Ordered visible text/refusal blocks with per-claim citations. */
  textBlocks: Array<WebSearchTextBlock>
}

export interface WebSearchToolConfig {
  maxUses?: number
  allowedDomains?: Array<string>
  blockedDomains?: Array<string>
  userLocation?: Record<string, unknown>
}

export class WebSearchSemanticValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebSearchSemanticValidationError"
  }
}

/** Builds the Responses API web_search tool object from the Anthropic config. */
export const buildResponsesWebSearchTool = (
  config: WebSearchToolConfig,
): Record<string, unknown> => {
  const tool: Record<string, unknown> = { type: "web_search" }
  const filters: Record<string, unknown> = {}
  if (config.allowedDomains?.length) {
    filters.allowed_domains = config.allowedDomains
  }
  if (config.blockedDomains?.length) {
    filters.blocked_domains = config.blockedDomains
  }
  if (Object.keys(filters).length > 0) tool.filters = filters
  if (config.userLocation) tool.user_location = config.userLocation
  return tool
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const WEB_SEARCH_CALL_STATUSES = new Set<
  NonNullable<ResponseOutputWebSearchCall["status"]>
>(["in_progress", "searching", "completed", "failed"])
const WEB_SEARCH_ACTION_TYPES = new Set([
  "search",
  "open",
  "find",
  "open_page",
  "find_in_page",
])
const RESPONSE_MESSAGE_STATUSES = new Set(["completed", "incomplete"])
const MAX_WEB_SEARCH_FACTS = 256
const MAX_WEB_SEARCH_CONTENT_BLOCKS = 1_024
const MAX_WEB_SEARCH_STRING_LENGTH = 1024 * 1024

const isStableProviderId = (value: string): boolean =>
  value.length > 0 && value.length <= 512 && value === value.trim()

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    throw new WebSearchSemanticValidationError(
      `Responses Web Search ${field} must be a string`,
    )
  }
  if (value.length > MAX_WEB_SEARCH_STRING_LENGTH) {
    throw new WebSearchSemanticValidationError(
      `Responses Web Search ${field} is too large`,
    )
  }
  return value
}

const validateOutputBudget = (output: unknown): void => {
  if (!Array.isArray(output)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search output must be an array",
    )
  }
  if (output.length > WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search output has too many items",
    )
  }
  let serialized: string
  try {
    serialized = JSON.stringify(output)
  } catch {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search output is not serializable",
    )
  }
  if (
    Buffer.byteLength(serialized, "utf8") > WEB_SEARCH_HISTORY_MAX_DECODED_BYTES
  ) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search output exceeds the byte limit",
    )
  }
  const stack: Array<unknown> = [output]
  const seen = new Set<object>()
  let nodes = 0
  while (stack.length > 0) {
    const value = stack.pop()
    nodes += 1
    if (nodes > WEB_SEARCH_HISTORY_MAX_TOTAL_NODES) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output exceeds the node limit",
      )
    }
    if (typeof value !== "object" || value === null) continue
    if (seen.has(value)) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output contains a cycle",
      )
    }
    seen.add(value)
    const children: Array<unknown> =
      Array.isArray(value) ? (value as Array<unknown>) : Object.values(value)
    if (children.length > WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output collection is too wide",
      )
    }
    stack.push(...children)
  }
}

const readSources = (value: unknown): Array<WebSearchSource> => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action.sources must be an array",
    )
  }
  if (value.length > MAX_WEB_SEARCH_FACTS) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action.sources has too many entries",
    )
  }
  return value.map((source) => {
    if (
      !isRecord(source)
      || (source.type !== undefined && source.type !== "url")
      || typeof source.url !== "string"
      || !source.url
    ) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search source must contain a URL",
      )
    }
    const title = optionalString(source.title, "source.title") ?? source.url
    const pageAge = source.page_age
    if (
      pageAge !== undefined
      && pageAge !== null
      && typeof pageAge !== "string"
    ) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search source.page_age must be a string or null",
      )
    }
    return {
      url: source.url,
      title,
      ...(pageAge !== undefined && { page_age: pageAge }),
    }
  })
}

const readQueries = (value: unknown): Array<string> | undefined => {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || !value.every((query) => typeof query === "string")
  ) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action.queries must be an array of strings",
    )
  }
  if (value.length > MAX_WEB_SEARCH_FACTS) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action.queries has too many entries",
    )
  }
  return [...value]
}

function readAction(value: unknown, status: "failed"): WebSearchAction
function readAction(
  value: unknown,
  status: "completed" | "in_progress" | "searching",
): WebSearchExecutableAction
function readAction(
  value: unknown,
  status: NonNullable<ResponseOutputWebSearchCall["status"]>,
): WebSearchAction {
  if (value === undefined) {
    if (status === "failed") return { sources: [] }
    throw new WebSearchSemanticValidationError(
      "Responses Web Search call.action is required",
    )
  }
  if (!isRecord(value)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action must be an object",
    )
  }
  const type = optionalString(value.type, "action.type")
  const query = optionalString(value.query, "action.query")
  const queries = readQueries(value.queries)
  const url = optionalString(value.url, "action.url")
  const pattern = optionalString(value.pattern, "action.pattern")
  if (type === undefined || !WEB_SEARCH_ACTION_TYPES.has(type)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search action.type is invalid",
    )
  }
  const hasQuery = Boolean(
    query?.trim() || queries?.some((item) => item.trim()),
  )
  if (type === "search" && !hasQuery) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search search action requires a query",
    )
  }
  if ((type === "open" || type === "open_page") && !url?.trim()) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search open action requires a URL",
    )
  }
  if (
    (type === "find" || type === "find_in_page")
    && (!url?.trim() || !pattern?.trim())
  ) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search find action requires a URL and pattern",
    )
  }
  const action = {
    sources: readSources(value.sources),
    ...(query !== undefined && { query }),
    ...(queries !== undefined && { queries }),
    ...(url !== undefined && { url }),
    ...(pattern !== undefined && { pattern }),
  }
  switch (type) {
    case "search":
      return { ...action, type }
    case "open":
    case "open_page":
      return { ...action, type, url: url as string }
    case "find":
    case "find_in_page":
      return {
        ...action,
        type,
        pattern: pattern as string,
        url: url as string,
      }
  }
  throw new WebSearchSemanticValidationError(
    "Responses Web Search action.type is invalid",
  )
}

const readCall = (item: Record<string, unknown>): WebSearchCall => {
  const id = optionalString(item.id, "call.id")
  const status = optionalString(item.status, "call.status")
  if (id !== undefined && !isStableProviderId(id)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search call.id is invalid",
    )
  }
  if (
    status === undefined
    || !WEB_SEARCH_CALL_STATUSES.has(
      status as NonNullable<ResponseOutputWebSearchCall["status"]>,
    )
  ) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search call.status is invalid",
    )
  }
  const typedStatus = status as NonNullable<
    ResponseOutputWebSearchCall["status"]
  >
  if (typedStatus === "failed") {
    const action = readAction(item.action, typedStatus)
    return { action, status: typedStatus, ...(id !== undefined && { id }) }
  }
  const action = readAction(item.action, typedStatus)
  return {
    action,
    status: typedStatus,
    ...(id !== undefined && { id }),
  }
}

const readCitation = (
  annotation: unknown,
  text: string,
): WebSearchCitation | null => {
  if (!isRecord(annotation) || annotation.type !== "url_citation") return null
  if (typeof annotation.url !== "string" || !annotation.url) {
    throw new WebSearchSemanticValidationError(
      "Responses URL citation must contain a URL",
    )
  }
  const title =
    optionalString(annotation.title, "citation.title") ?? annotation.url
  const start = annotation.start_index
  const end = annotation.end_index
  const hasRange = start !== undefined || end !== undefined
  if (
    hasRange
    && (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || Number(start) < 0
      || Number(end) < Number(start)
      || Number(end) > text.length)
  ) {
    throw new WebSearchSemanticValidationError(
      "Responses URL citation has an invalid text range",
    )
  }
  const providerCitedText = optionalString(
    annotation.cited_text,
    "citation.cited_text",
  )
  const citedText =
    providerCitedText
    ?? (hasRange ? text.slice(Number(start), Number(end)) : undefined)
  return {
    url: annotation.url,
    title,
    ...(hasRange && {
      startIndex: Number(start),
      endIndex: Number(end),
    }),
    ...(citedText !== undefined && { citedText }),
  }
}

const collectMessageBlocks = (
  item: ResponseOutputMessage,
): Array<WebSearchTextBlock> => {
  if (item.role !== "assistant") {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search message.role is invalid",
    )
  }
  if (!RESPONSE_MESSAGE_STATUSES.has(item.status)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search message.status is invalid",
    )
  }
  if (item.content === undefined) return []
  if (!Array.isArray(item.content)) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search message content must be an array",
    )
  }
  if (item.content.length > MAX_WEB_SEARCH_CONTENT_BLOCKS) {
    throw new WebSearchSemanticValidationError(
      "Responses Web Search message has too many content blocks",
    )
  }
  const blocks: Array<WebSearchTextBlock> = []
  for (const block of item.content) {
    if (!isRecord(block)) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search message content blocks must be objects",
      )
    }
    if (block.type === "refusal") {
      if (typeof block.refusal !== "string") {
        throw new WebSearchSemanticValidationError(
          "Responses Web Search refusal must be a string",
        )
      }
      blocks.push({ type: "refusal", text: block.refusal, citations: [] })
      continue
    }
    if (block.type !== "output_text") {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search message content type is invalid",
      )
    }
    if (typeof block.text !== "string") {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output text must be a string",
      )
    }
    if (block.annotations !== undefined && !Array.isArray(block.annotations)) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search annotations must be an array",
      )
    }
    if (
      Array.isArray(block.annotations)
      && block.annotations.length > MAX_WEB_SEARCH_CONTENT_BLOCKS
    ) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output text has too many annotations",
      )
    }
    const text = block.text
    const citations = (block.annotations ?? []).flatMap((annotation) => {
      const citation = readCitation(annotation, text)
      return citation ? [citation] : []
    })
    blocks.push({
      type: "output_text",
      text,
      citations,
    })
  }
  return blocks
}

/**
 * Extracts ordered Web Search calls and visible message blocks. Provider-native
 * fields stay in `result.output`, which is the sole history-carrier truth.
 */
export const extractWebSearchResult = (
  result: ResponsesResult,
): WebSearchExtract => {
  validateOutputBudget(result.output)
  const calls: Array<WebSearchCall> = []
  const textBlocks: Array<WebSearchTextBlock> = []
  const outputItemIds = new Set<string>()

  for (const item of result.output as Array<unknown>) {
    if (!isRecord(item)) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output items must be objects",
      )
    }
    if (typeof item.type !== "string" || !item.type.trim()) {
      throw new WebSearchSemanticValidationError(
        "Responses Web Search output item.type is invalid",
      )
    }
    const id = optionalString(item.id, "output item.id")
    if (id !== undefined) {
      if (!isStableProviderId(id) || outputItemIds.has(id)) {
        throw new WebSearchSemanticValidationError(
          "Responses Web Search output item IDs must be stable and unique",
        )
      }
      outputItemIds.add(id)
    }
    if (item.type === "message") {
      const messageItem = item as unknown as ResponseOutputMessage
      if (result.status === "completed" && messageItem.status !== "completed") {
        throw new WebSearchSemanticValidationError(
          "Completed Responses Web Search output contains an unfinished message",
        )
      }
      textBlocks.push(...collectMessageBlocks(messageItem))
      continue
    }
    if (item.type === "web_search_call") {
      calls.push(readCall(item))
    }
  }

  const queries = calls.flatMap((call) =>
    call.action.queries?.length ? call.action.queries
    : call.action.query !== undefined ? [call.action.query]
    : [],
  )
  const citationSources = textBlocks.flatMap((block) =>
    block.citations.map(({ url, title, page_age }) => ({
      url,
      title,
      ...(page_age !== undefined && { page_age }),
    })),
  )
  const callSources = calls.flatMap((call) => call.action.sources)
  const answerText =
    textBlocks
      .map((block) => block.text)
      .join("\n\n")
      .trim() || (result.output_text ?? "").trim()

  return {
    answerText,
    calls,
    sources: callSources.length > 0 ? callSources : citationSources,
    queries,
    callCount: calls.length,
    textBlocks,
  }
}
