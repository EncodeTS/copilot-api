import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"

import {
  getConfig,
  getUpstreamTimeouts,
  mergeDefaultConfig,
  reloadConfig,
} from "../src/lib/config"
import { fetchWithConfiguredUpstreamLifecycle } from "../src/lib/configured-upstream"
import { PATHS } from "../src/lib/paths"
import { upstreamLifecycleDependencies } from "../src/lib/upstream-lifecycle"
import { state } from "../src/lib/state"
import { prepareCodexResponsesWebSocketRequest } from "../src/services/codex/create-responses"
import {
  createResponses,
  prepareResponsesWebSocketRequest,
} from "../src/services/copilot/create-responses"
import {
  prepareResponsesWirePayload,
  admitResponsesWirePayload,
} from "../src/services/copilot/responses-wire-artifact"

let originalConfig: string
const originalUnref = upstreamLifecycleDependencies.unrefTimer
const originalState = { ...state }
beforeEach(() => {
  getConfig()
  originalConfig = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
  upstreamLifecycleDependencies.unrefTimer = () => {}
})
afterEach(() => {
  fs.writeFileSync(PATHS.CONFIG_PATH, originalConfig)
  reloadConfig()
  upstreamLifecycleDependencies.unrefTimer = originalUnref
  state.copilotToken = originalState.copilotToken
  state.codexAccessToken = originalState.codexAccessToken
  state.codexAccountId = originalState.codexAccountId
})

test("persists timeout migration idempotently without deleting other transport settings", () => {
  for (const configSchemaVersion of [0, 2]) {
    const legacy = {
      headersTimeoutMsV2: 345_000,
      streamInactivityTimeoutMs: 350_000,
      websocketOpenTimeoutMs: 45_000,
      websocketMaxBufferedBytes: 1234,
    }
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      JSON.stringify({
        configSchemaVersion,
        responsesTransport: legacy,
        upstreamTimeouts: { httpTotalMs: 999_000, futurePhaseMs: 123_000 },
      }),
    )
    reloadConfig()
    expect(getUpstreamTimeouts()).toMatchObject({
      httpHeadersMs: 345_000,
      httpFirstByteMs: 350_000,
      websocketConnectMs: 45_000,
      httpTotalMs: 999_000,
    })
    const persisted = JSON.parse(
      fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
    ) as Record<string, unknown>
    expect(persisted.responsesTransport).toEqual(legacy)
    expect(persisted.upstreamTimeouts).toMatchObject({
      httpHeadersMs: 345_000,
      httpTotalMs: 999_000,
      futurePhaseMs: 123_000,
    })
    const first = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    reloadConfig()
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(first)
    expect(mergeDefaultConfig(getConfig()).changed).toBe(false)
  }
})

test("configured HTTP headers deadline reaches the actual Copilot request", async () => {
  getConfig().upstreamTimeouts = { httpHeadersMs: 15 }
  state.copilotToken = "fixture-token"
  const error = await createResponses(
    { model: "gpt-6-astra", input: "test" },
    {
      vision: false,
      initiator: "user",
      requestId: "fixture",
      transport: "http",
      fetcher: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error ?
                  init.signal.reason
                : new Error("aborted"),
              ),
            { once: true },
          )
        }),
    },
  ).catch((error: unknown) => error)
  expect(error).toMatchObject({
    diagnosticPhase: "http_headers",
    timeoutMs: 15,
  })
})

test("per-request first-byte deadline overrides the configured HTTP policy", async () => {
  getConfig().upstreamTimeouts = { httpFirstByteMs: 500 }
  const response = await fetchWithConfiguredUpstreamLifecycle(
    "https://fixture.invalid/responses",
    {},
    {
      timeouts: { httpFirstByteMs: 15 },
      fetcher: () => Promise.resolve(new Response(new ReadableStream())),
    },
  )
  const error = await response.text().catch((error: unknown) => error)
  expect(error).toMatchObject({
    diagnosticPhase: "http_first_byte",
    timeoutMs: 15,
  })
})

test("both WebSocket adapters receive the configured phase limits and overrides", () => {
  getConfig().upstreamTimeouts = {
    websocketConnectMs: 45_000,
    websocketFirstFrameMs: 320_000,
  }
  state.codexAccessToken = "fixture-token"
  state.codexAccountId = "fixture-account"
  const payload = { model: "gpt-6-astra", input: "test", stream: true }
  const codex = prepareCodexResponsesWebSocketRequest(
    payload,
    new Headers(),
    undefined,
    { timeouts: { websocketTotalMs: 600_000 } },
  )
  expect(codex.timeouts).toMatchObject({
    websocketConnectMs: 45_000,
    websocketFirstFrameMs: 320_000,
    websocketTotalMs: 600_000,
  })
  const artifact = admitResponsesWirePayload(
    prepareResponsesWirePayload(payload),
    "user",
    "websocket",
  )
  const copilot = prepareResponsesWebSocketRequest(
    artifact,
    { "x-initiator": "user" },
    { requestId: "fixture" },
  )
  expect(copilot.timeouts).toMatchObject({
    websocketConnectMs: 45_000,
    websocketFirstFrameMs: 320_000,
  })
})
