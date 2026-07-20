import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { CodexStartupCatalogUpdateResult } from "../src/services/codex/startup-catalog"

const actualConfigModule = await import("../src/lib/config")
const actualPathsModule = await import("../src/lib/paths")

let modelMappings: Record<string, string> = {
  "claude-opus-4-7": "gpt-5-mini",
}
const refreshStartupCatalog = mock(
  (): Promise<CodexStartupCatalogUpdateResult> =>
    Promise.resolve({
      clientVersion: "0.144.2",
      degraded: false,
      inputRevision: 1,
      modelCount: 1,
      path: "/tmp/models.json",
      restartRequired: true,
      status: "updated" as const,
    }),
)

const getModelMappings = mock(() => modelMappings)
const setModelMappings = mock((nextModelMappings: Record<string, string>) => {
  modelMappings = nextModelMappings
  return modelMappings
})
const clearResponsesWebSocketConnections = mock(() => 2)
const getPooledWebSocketDiagnostics = mock(() => ({
  activeRequests: 1,
  connections: 3,
  dedicatedConnections: 1,
  idleConnections: 1,
  overflows: 4,
  poolHits: 5,
  poolMisses: 6,
  pooledConnections: 2,
  queuedBytes: 7,
  queuedFrames: 8,
}))
const getResponsesWebSocketResourceLimits = mock(() => ({
  capacityWaitMs: 250,
  dedicatedConnectionLimit: 64,
  globalConnectionLimit: 128,
  idleConnectionLimit: 32,
  idleTimeoutMs: 60_000,
  maxFrameBytes: 33_554_432,
  maxQueuedBytes: 67_108_864,
  maxQueuedFrames: 4096,
  perCapacityKeyConnectionLimit: 32,
}))

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelMappings,
  setModelMappings,
}))

const { configRoutes } = await import("../src/routes/admin/config/route")
const { configRouteDependencies } = await import(
  "../src/routes/admin/config/route"
)

const createApp = () => {
  const app = new Hono()
  app.route("/admin/config", configRoutes)
  return app
}

beforeEach(() => {
  modelMappings = {
    "claude-opus-4-7": "gpt-5-mini",
  }

  getModelMappings.mockClear()
  setModelMappings.mockClear()
  refreshStartupCatalog.mockClear()
  clearResponsesWebSocketConnections.mockClear()
  getPooledWebSocketDiagnostics.mockClear()
  getResponsesWebSocketResourceLimits.mockClear()
  configRouteDependencies.refreshStartupCatalog = refreshStartupCatalog
  configRouteDependencies.clearResponsesWebSocketConnections =
    clearResponsesWebSocketConnections
  configRouteDependencies.getPooledWebSocketDiagnostics =
    getPooledWebSocketDiagnostics
  configRouteDependencies.getResponsesWebSocketResourceLimits =
    getResponsesWebSocketResourceLimits
})

describe("Responses websocket config routes", () => {
  test("returns resource limits and a content-free runtime snapshot", async () => {
    const response = await createApp().request(
      "/admin/config/responses-websocket",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      diagnostics: getPooledWebSocketDiagnostics(),
      limits: getResponsesWebSocketResourceLimits(),
    })
  })

  test("clears pooled connections for a known network change", async () => {
    const response = await createApp().request(
      "/admin/config/responses-websocket/clear",
      {
        body: JSON.stringify({ reason: "network_change" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(200)
    expect(clearResponsesWebSocketConnections).toHaveBeenCalledWith(
      "network_change",
    )
    expect(await response.json()).toEqual({
      clearedConnections: 2,
      diagnostics: getPooledWebSocketDiagnostics(),
    })
  })

  test("rejects arbitrary clear reasons", async () => {
    const response = await createApp().request(
      "/admin/config/responses-websocket/clear",
      {
        body: JSON.stringify({ reason: "conversation text" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(clearResponsesWebSocketConnections).not.toHaveBeenCalled()
  })

  test("requires an explicit network or proxy clear reason", async () => {
    const response = await createApp().request(
      "/admin/config/responses-websocket/clear",
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
    expect(clearResponsesWebSocketConnections).not.toHaveBeenCalled()
  })

  test("rejects a missing clear request body", async () => {
    const response = await createApp().request(
      "/admin/config/responses-websocket/clear",
      { method: "POST" },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    })
    expect(clearResponsesWebSocketConnections).not.toHaveBeenCalled()
  })
})

describe("config model mappings route", () => {
  test("returns the current model mappings snapshot", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelMappings: {
        "claude-opus-4-7": "gpt-5-mini",
      },
    })
    expect(getModelMappings).toHaveBeenCalledTimes(1)
  })

  test("updates model mappings through the config API", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelMappings: {
          "claude-opus-4-7": "dash/qwen-plus",
          "claude-sonnet-4": "gpt-5.4",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(setModelMappings).toHaveBeenCalledWith({
      "claude-opus-4-7": "dash/qwen-plus",
      "claude-sonnet-4": "gpt-5.4",
    })
    expect(await response.json()).toEqual({
      catalogRefresh: {
        clientVersion: "0.144.2",
        degraded: false,
        inputRevision: 1,
        modelCount: 1,
        path: "/tmp/models.json",
        restartRequired: true,
        status: "updated",
      },
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelMappings: {
        "claude-opus-4-7": "dash/qwen-plus",
        "claude-sonnet-4": "gpt-5.4",
      },
    })
    expect(refreshStartupCatalog).toHaveBeenCalledWith({
      modelMappings: {
        "claude-opus-4-7": "dash/qwen-plus",
        "claude-sonnet-4": "gpt-5.4",
      },
    })
  })

  test("reports an unchanged startup catalog separately from the saved mapping", async () => {
    refreshStartupCatalog.mockResolvedValueOnce({
      clientVersion: "0.144.2",
      degraded: false,
      inputRevision: 2,
      modelCount: 1,
      path: "/tmp/models.json",
      restartRequired: false,
      status: "unchanged",
    })
    const response = await createApp().request("/admin/config/model-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelMappings: { source: "target" },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      catalogRefresh: {
        degraded: false,
        restartRequired: false,
        status: "unchanged",
      },
      modelMappings: { source: "target" },
    })
  })

  test("reports a degraded startup catalog without failing the mapping save", async () => {
    refreshStartupCatalog.mockResolvedValueOnce({
      clientVersion: "0.144.2",
      degraded: true,
      inputRevision: 3,
      modelCount: 1,
      path: "/tmp/models.json",
      restartRequired: true,
      status: "updated",
    })
    const response = await createApp().request("/admin/config/model-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelMappings: { source: "target" },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      catalogRefresh: {
        degraded: true,
        restartRequired: true,
        status: "updated",
      },
      modelMappings: { source: "target" },
    })
  })

  test("rejects invalid request bodies", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelMappings: "claude-opus-4-7",
      }),
    })

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: {
        message: string
        type: string
      }
    }
    expect(json.error.type).toBe("invalid_request_error")
    expect(json.error.message.length).toBeGreaterThan(0)
    expect(setModelMappings).not.toHaveBeenCalled()
    expect(refreshStartupCatalog).not.toHaveBeenCalled()
  })

  test("returns an invalid request when centralized mapping validation fails", async () => {
    setModelMappings.mockImplementationOnce(() => {
      throw new actualConfigModule.ModelMappingsValidationError([
        { code: "chain", source: "a", target: "b" },
      ])
    })
    const response = await createApp().request("/admin/config/model-mappings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelMappings: {
          a: "b",
          b: "c",
        },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        diagnostics: [{ code: "chain", source: "a", target: "b" }],
        message: "Invalid model mappings.",
        type: "invalid_request_error",
      },
    })
    expect(refreshStartupCatalog).not.toHaveBeenCalled()
  })

  test("keeps a successful mapping save when catalog refresh fails", async () => {
    refreshStartupCatalog.mockResolvedValueOnce({
      clientVersion: "0.144.2",
      degraded: false,
      inputRevision: 2,
      path: "/tmp/models.json",
      reason: "persistence_failed",
      restartRequired: false,
      status: "failed",
    })
    const response = await createApp().request("/admin/config/model-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelMappings: { source: "target" },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      catalogRefresh: {
        reason: "persistence_failed",
        restartRequired: false,
        status: "failed",
      },
      modelMappings: { source: "target" },
    })
  })

  test("does not expose the old public config path", async () => {
    const app = createApp()
    const response = await app.request("/config/model-mappings")

    expect(response.status).toBe(404)
  })
})
