import { WebSocket } from "undici"

export type ResponsesWebSocketErrorEvent = Parameters<
  NonNullable<InstanceType<typeof WebSocket>["onerror"]>
>[0]

export const closeResponsesWebSocket = (
  websocket: InstanceType<typeof WebSocket>,
  code?: number,
  reason?: string,
): void => {
  if (
    websocket.readyState === WebSocket.CONNECTING
    || websocket.readyState === WebSocket.OPEN
  ) {
    websocket.close(code, reason)
  }
}

export const createResponsesWebSocketError = (
  message: string,
  event?: Pick<ResponsesWebSocketErrorEvent, "error" | "message">,
): Error => {
  const reason = event?.error ?? event?.message
  if (reason === undefined || reason === "") {
    return new Error(message)
  }
  const cause = toResponsesWebSocketError(reason)
  return new Error(`${message}: ${cause.message}`, { cause })
}

export const toResponsesWebSocketAbortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error(
    typeof reason === "string" ? reason
    : typeof reason === "number" || typeof reason === "boolean" ? String(reason)
    : "Upstream request aborted",
  )
  error.name = "AbortError"
  return error
}

export const toResponsesWebSocketError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))
