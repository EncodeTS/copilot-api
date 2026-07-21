export interface ResponsesWebSocketChunk {
  data: string
  event?: string
  id?: string
}

export interface ResponsesWebSocketChunkProjectionOptions {
  normalizeError?: (event: Record<string, unknown>) => Record<string, unknown>
}

export const projectResponsesWebSocketChunk = (
  data: string,
  options: ResponsesWebSocketChunkProjectionOptions = {},
): ResponsesWebSocketChunk => {
  if (data === "[DONE]") return { data }

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return { data }
  }
  if (!isRecord(parsed)) return { data }

  let projected = parsed
  if (parsed.type === "error" && options.normalizeError) {
    projected = options.normalizeError(parsed)
  }
  return {
    data: projected === parsed ? data : JSON.stringify(projected),
    event: typeof projected.type === "string" ? projected.type : undefined,
    id: typeof projected.id === "string" ? projected.id : undefined,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
