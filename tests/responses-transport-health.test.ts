import { afterEach, beforeEach, expect, test } from "bun:test"

import { getResponsesTransportForModel } from "../src/routes/responses/utils"
import {
  DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
  degradeResponsesWebSocketTransport,
  getResponsesWebSocketTransportHealthDiagnostics,
  resetResponsesWebSocketTransportHealth,
  responsesWebSocketTransportHealthDependencies,
} from "../src/services/copilot/responses-transport-health"

const originalNow = responsesWebSocketTransportHealthDependencies.now
let now = 1_000

beforeEach(() => {
  now = 1_000
  responsesWebSocketTransportHealthDependencies.now = () => now
  resetResponsesWebSocketTransportHealth()
})

afterEach(() => {
  resetResponsesWebSocketTransportHealth()
  responsesWebSocketTransportHealthDependencies.now = originalNow
})

test("transport selection prefers HTTP during websocket cooldown and preserves websocket-only models", () => {
  const dualTransportModel = {
    supported_endpoints: ["/responses", "ws:/responses"],
  }
  const websocketOnlyModel = {
    supported_endpoints: ["ws:/responses"],
  }
  expect(
    getResponsesTransportForModel(dualTransportModel, { useWebSocket: true }),
  ).toBe("websocket")

  degradeResponsesWebSocketTransport("sent_unknown_disconnect")

  expect(
    getResponsesTransportForModel(dualTransportModel, { useWebSocket: true }),
  ).toBe("http")
  expect(
    getResponsesTransportForModel(websocketOnlyModel, { useWebSocket: true }),
  ).toBe("websocket")
})

test("websocket cooldown expires, repeated degradation extends it, and reset closes it", () => {
  degradeResponsesWebSocketTransport("sent_unknown_disconnect")
  expect(getResponsesWebSocketTransportHealthDiagnostics()).toMatchObject({
    active: true,
    cooldownUntilMs: 1_000 + DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
    lastDegradedAtMs: 1_000,
    reason: "sent_unknown_disconnect",
    remainingMs: DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
  })

  now += 10_000
  degradeResponsesWebSocketTransport("sent_unknown_disconnect")
  expect(getResponsesWebSocketTransportHealthDiagnostics()).toMatchObject({
    active: true,
    cooldownUntilMs: 11_000 + DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
    lastDegradedAtMs: 11_000,
    remainingMs: DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS,
  })

  now += DEFAULT_RESPONSES_WEBSOCKET_COOLDOWN_MS + 1
  expect(getResponsesWebSocketTransportHealthDiagnostics().active).toBe(false)

  resetResponsesWebSocketTransportHealth()
  expect(getResponsesWebSocketTransportHealthDiagnostics()).toEqual({
    active: false,
    cooldownUntilMs: null,
    lastDegradedAtMs: null,
    reason: null,
    remainingMs: 0,
  })
})
