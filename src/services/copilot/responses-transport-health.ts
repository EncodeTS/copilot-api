import consola from "consola"

import { clearIdlePooledWebSocketConnections } from "~/services/responses-websocket"

export const DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS = 30_000

export type ResponsesWebSocketDegradedReason =
  | "network_change"
  | "proxy_change"
  | "sent_unknown_disconnect"

export interface ResponsesWebSocketTransportHealthDiagnostics {
  active: boolean
  cooldownUntilMs: number | null
  lastDegradedAtMs: number | null
  reason: ResponsesWebSocketDegradedReason | null
  remainingMs: number
}

export const responsesWebSocketTransportHealthDependencies = {
  now: (): number => Date.now(),
}

let cooldownUntilMs = 0
let lastDegradedAtMs: number | null = null
let degradedReason: ResponsesWebSocketDegradedReason | null = null

export const degradeResponsesWebSocketTransport = (
  reason: "sent_unknown_disconnect",
): ResponsesWebSocketTransportHealthDiagnostics => {
  const clearedIdleConnections = clearIdlePooledWebSocketConnections()
  return startResponsesWebSocketTransportCooldown(reason, {
    clearedIdleConnections,
  })
}

export const enterResponsesWebSocketTransportCooldown = (
  reason: "network_change" | "proxy_change",
): ResponsesWebSocketTransportHealthDiagnostics =>
  startResponsesWebSocketTransportCooldown(reason)

const startResponsesWebSocketTransportCooldown = (
  reason: ResponsesWebSocketDegradedReason,
  diagnosticFields: Record<string, number> = {},
): ResponsesWebSocketTransportHealthDiagnostics => {
  const now = responsesWebSocketTransportHealthDependencies.now()
  cooldownUntilMs = Math.max(
    cooldownUntilMs,
    now + DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
  )
  lastDegradedAtMs = now
  degradedReason = reason

  consola.warn("responses.websocket_transport_degraded", {
    ...diagnosticFields,
    cooldownMs: DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
    reason,
  })
  return getResponsesWebSocketTransportHealthDiagnostics()
}

export const shouldPreferResponsesHttpTransport = (
  canUseHttp: boolean,
): boolean =>
  canUseHttp && getResponsesWebSocketTransportHealthDiagnostics().active

export const getResponsesWebSocketTransportHealthDiagnostics =
  (): ResponsesWebSocketTransportHealthDiagnostics => {
    const remainingMs = Math.max(
      0,
      cooldownUntilMs - responsesWebSocketTransportHealthDependencies.now(),
    )
    return {
      active: remainingMs > 0,
      cooldownUntilMs: cooldownUntilMs > 0 ? cooldownUntilMs : null,
      lastDegradedAtMs,
      reason: degradedReason,
      remainingMs,
    }
  }

export const resetResponsesWebSocketTransportHealth = (): void => {
  cooldownUntilMs = 0
  lastDegradedAtMs = null
  degradedReason = null
}
