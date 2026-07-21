import { toSafeLogMetadata as toSafeMetadata } from "./log-metadata"

interface ResponsesDiagnosticPayload {
  context_management?: unknown
  input?: unknown
  instructions?: unknown
  model?: unknown
  stream?: unknown
  tools?: unknown
}

interface ResponsesFailureLike {
  code?: string | null
  message: string
}

export interface ResponsesPayloadDiagnosticSummary {
  compactThreshold?: number
  contextManagementItems: number
  inputItems: number
  inputTypeCounts: Record<string, number>
  instructionsBytes: number
  model?: string
  payloadBytes?: number
  roleCounts: Record<string, number>
  stream: boolean
  toolCount: number
  visionItems: number
}

export interface ResponsesPromptLimitDiagnostic {
  errorCode?: string
  overLimitTokens?: number
  promptLimitTokens?: number
  promptTokens?: number
}

const PROMPT_LIMIT_PATTERN =
  /prompt token count of\s+([\d,]+)\s+exceeds the limit of\s+([\d,]+)/iu

export const summarizeResponsesPayload = (
  payload: ResponsesDiagnosticPayload,
  options: {
    includePayloadBytes?: boolean
  } = {},
): ResponsesPayloadDiagnosticSummary => {
  const input = Array.isArray(payload.input) ? payload.input : []
  const contextManagement =
    Array.isArray(payload.context_management) ? payload.context_management : []
  const summary: ResponsesPayloadDiagnosticSummary = {
    contextManagementItems: contextManagement.length,
    inputItems: input.length,
    inputTypeCounts: countSafePropertyValues(input, "type"),
    instructionsBytes:
      typeof payload.instructions === "string" ?
        Buffer.byteLength(payload.instructions, "utf8")
      : 0,
    roleCounts: countSafePropertyValues(input, "role"),
    stream: payload.stream === true,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    visionItems: countNestedType(payload.input, "input_image"),
  }

  if (options.includePayloadBytes !== false) {
    summary.payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
  }

  const model = toSafeMetadata(payload.model)
  if (model) summary.model = model
  const compactThreshold = findCompactThreshold(contextManagement)
  if (compactThreshold !== undefined) {
    summary.compactThreshold = compactThreshold
  }
  return summary
}

export const parseResponsesPromptLimitFailure = (
  failure: ResponsesFailureLike,
): ResponsesPromptLimitDiagnostic => {
  const diagnostic: ResponsesPromptLimitDiagnostic = {}
  const errorCode = toSafeMetadata(failure.code)
  if (errorCode) diagnostic.errorCode = errorCode

  const match = failure.message.match(PROMPT_LIMIT_PATTERN)
  if (!match) return diagnostic
  const promptTokens = parseTokenCount(match[1])
  const promptLimitTokens = parseTokenCount(match[2])
  if (promptTokens === undefined || promptLimitTokens === undefined) {
    return diagnostic
  }

  diagnostic.promptTokens = promptTokens
  diagnostic.promptLimitTokens = promptLimitTokens
  diagnostic.overLimitTokens = Math.max(0, promptTokens - promptLimitTokens)
  return diagnostic
}

export const createResponsesTransportErrorDiagnostic = (options: {
  error: unknown
  payload: ResponsesDiagnosticPayload
  requestHeaders: Record<string, string>
  transport: "http" | "websocket"
}): Record<string, boolean | null | number | string | undefined> => {
  const payload = summarizeResponsesPayload(options.payload, {
    includePayloadBytes: false,
  })
  const error = options.error instanceof Error ? options.error : undefined
  const errorRecord = isRecord(options.error) ? options.error : undefined
  return {
    errorCode: toSafeMetadata(errorRecord?.code),
    errorName: toSafeMetadata(error?.name) ?? typeof options.error,
    inputItems: payload.inputItems,
    model: payload.model,
    requestId: getRequestHeader(options.requestHeaders, "x-request-id"),
    sessionId: getRequestHeader(options.requestHeaders, "x-interaction-id"),
    stream: payload.stream,
    transport: options.transport,
  }
}

export const createResponsesUpstreamErrorDiagnostic = (options: {
  failure: ResponsesFailureLike
  payload: ResponsesDiagnosticPayload
  payloadBytes?: number
  requestHeaders: Record<string, string>
  responseHeaders?: Headers
  status?: number
  transport: "http" | "websocket"
}): Record<string, boolean | null | number | string | undefined> => {
  const promptLimit = parseResponsesPromptLimitFailure(options.failure)
  const payload = summarizeResponsesPayload(options.payload, {
    includePayloadBytes: options.payloadBytes === undefined,
  })
  return {
    compactThreshold: payload.compactThreshold,
    contextManagementItems: payload.contextManagementItems,
    errorCode: promptLimit.errorCode,
    githubBackend: toSafeMetadata(
      options.responseHeaders?.get("x-github-backend"),
    ),
    githubRequestId: toSafeMetadata(
      options.responseHeaders?.get("x-github-request-id"),
    ),
    inputItems: payload.inputItems,
    model: payload.model,
    overLimitTokens: promptLimit.overLimitTokens,
    payloadBytes: options.payloadBytes ?? payload.payloadBytes,
    promptLimitTokens: promptLimit.promptLimitTokens,
    promptTokens: promptLimit.promptTokens,
    requestId: getRequestHeader(options.requestHeaders, "x-request-id"),
    serviceRequestId: toSafeMetadata(
      options.responseHeaders?.get("x-copilot-service-request-id"),
    ),
    sessionId: getRequestHeader(options.requestHeaders, "x-interaction-id"),
    status: options.status,
    stream: payload.stream,
    transport: options.transport,
    upstreamRequestId: toSafeMetadata(
      options.responseHeaders?.get("x-request-id"),
    ),
  }
}

const getRequestHeader = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalized = headerName.toLowerCase()
  return toSafeMetadata(
    Object.entries(headers).find(
      ([name]) => name.toLowerCase() === normalized,
    )?.[1],
  )
}

const countSafePropertyValues = (
  values: Array<unknown>,
  property: "role" | "type",
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const value of values) {
    if (!isRecord(value)) continue
    const metadata = toSafeMetadata(value[property])
    if (!metadata) continue
    counts[metadata] = (counts[metadata] ?? 0) + 1
  }
  return counts
}

const countNestedType = (value: unknown, expectedType: string): number => {
  const pending: Array<unknown> = [value]
  const seen = new WeakSet<object>()
  let count = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      if (seen.has(current)) continue
      seen.add(current)
      for (const child of current) {
        pending.push(child as unknown)
      }
    } else if (isRecord(current)) {
      if (seen.has(current)) continue
      seen.add(current)
      if (current.type === expectedType) count += 1
      for (const child of Object.values(current)) {
        pending.push(child)
      }
    }
  }
  return count
}

const findCompactThreshold = (
  contextManagement: Array<unknown>,
): number | undefined => {
  for (const item of contextManagement) {
    if (!isRecord(item) || item.type !== "compaction") continue
    const threshold = item.compact_threshold
    if (
      typeof threshold === "number"
      && Number.isSafeInteger(threshold)
      && threshold > 0
    ) {
      return threshold
    }
  }
  return undefined
}

const parseTokenCount = (value: string): number | undefined => {
  const count = Number(value.replaceAll(",", ""))
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
