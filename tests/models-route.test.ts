import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ModelsResponse } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("../src/lib/state")
const {
  clearCodexCatalogCache,
  codexClientModelsDependencies,
  loadInstalledCodexCatalog,
} = await import("../src/services/codex/client-models")
const { modelRoutes } = await import("../src/routes/models/route")

const originalFetch = globalThis.fetch

const createProviderConfig = (
  name: string,
  baseUrl: string,
): ResolvedProviderConfig => ({
  apiKey: `${name}-key`,
  authType: "authorization",
  baseUrl,
  name,
  type: "openai-compatible",
})

const createCopilotModels = (ids: Array<string>): ModelsResponse => ({
  object: "list",
  data: ids.map((id) => ({
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: 200_000,
      },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  })),
})

const createGpt56CopilotModels = (): ModelsResponse => ({
  object: "list",
  data: [
    {
      capabilities: {
        family: "gpt-5.6-sol",
        limits: {
          max_context_window_tokens: 1_050_000,
          max_output_tokens: 128_000,
          max_prompt_tokens: 922_000,
        },
        object: "model_capabilities",
        supports: {
          parallel_tool_calls: true,
          reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"],
          streaming: true,
          tool_calls: true,
          vision: true,
        },
        tokenizer: "o200k_base",
        type: "chat",
      },
      id: "gpt-5.6-sol",
      model_picker_enabled: true,
      name: "GPT-5.6 Sol",
      object: "model",
      preview: false,
      supported_endpoints: ["/responses", "ws:/responses"],
      vendor: "openai",
      version: "2026-07-13",
    },
  ],
})

const createCodexCatalog = () => ({
  models: [
    {
      slug: "gpt-5.6-sol",
      base_instructions: "x".repeat(16_299),
      context_window: 372_000,
      max_context_window: 372_000,
      auto_compact_token_limit: null,
      effective_context_window_percent: 95,
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "max", description: "Max" },
        { effort: "ultra", description: "Ultra" },
      ],
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
    },
  ],
})

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  const providerModelIds: Record<string, string> = {
    "first.example": "first-model",
    "second.example": "second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "qwen-plus"

  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: providerModelId,
          name: providerModelId,
          object: "model",
        },
        {
          id: "",
          object: "model",
        },
      ],
    }),
  )
})

function createApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  return app
}

beforeEach(() => {
  enabledProviders = []
  providerConfigs = {}
  state.models = undefined
  fetchMock.mockClear()
  clearCodexCatalogCache()
  codexClientModelsDependencies.loadBundledCatalog = (version) =>
    Promise.resolve(version === "0.144.1" ? createCodexCatalog() : null)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.models = undefined
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  codexClientModelsDependencies.loadBundledCatalog = loadInstalledCodexCatalog
  clearCodexCatalogCache()
})

describe("model routes", () => {
  test("aggregates Copilot and provider models without mutating state.models", async () => {
    state.models = createCopilotModels(["gpt-5-mini"])
    enabledProviders = ["dash"]
    providerConfigs = {
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    expect(response.headers.get("vary")).toBe("User-Agent")
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "dash/qwen-plus",
    ])
    expect(state.models.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://dash.example/v1/models")
  })

  test("keeps Copilot models first and provider models in provider order", async () => {
    state.models = createCopilotModels(["gpt-5-mini", "gpt-5"])
    enabledProviders = ["second", "first"]
    providerConfigs = {
      first: createProviderConfig("first", "https://first.example"),
      second: createProviderConfig("second", "https://second.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5",
      "second/second-model",
      "first/first-model",
    ])
  })

  test("returns provider models in provider-only mode and skips failed providers", async () => {
    enabledProviders = ["bad", "dash"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["dash/qwen-plus"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("adds built-in Codex provider models without calling upstream", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("keeps Codex provider-only clients on the official models upstream", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request(
      "/v1/models?client_version=0.144.1",
      {
        headers: {
          accept: "*/*",
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
  })

  test("adapts Copilot capabilities to the matching Codex client catalog", async () => {
    state.models = createGpt56CopilotModels()

    const response = await createApp().request(
      "/v1/models?client_version=0.144.1",
      {
        headers: {
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/)
    expect(response.headers.get("vary")).toBe("User-Agent")
    const body = (await response.json()) as {
      models: Array<Record<string, unknown>>
    }
    expect(Object.keys(body)).toEqual(["models"])
    expect(body.models).toHaveLength(1)

    const model = body.models[0]
    expect(model?.slug).toBe("gpt-5.6-sol")
    expect(model?.context_window).toBe(1_050_000)
    expect(model?.max_context_window).toBe(1_050_000)
    expect(model?.auto_compact_token_limit).toBe(890_000)
    expect(model?.effective_context_window_percent).toBe(95)
    expect(model?.tool_mode).toBe("code_mode_only")
    expect(model?.multi_agent_version).toBe("v2")
    expect(String(model?.base_instructions).length).toBeGreaterThan(10_000)
    expect(
      (model?.supported_reasoning_levels as Array<{ effort: string }>).map(
        ({ effort }) => effort,
      ),
    ).toContain("ultra")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("uses the Codex user-agent version when client_version is absent", async () => {
    state.models = createGpt56CopilotModels()

    const response = await createApp().request("/v1/models", {
      headers: {
        "user-agent": "codex-tui/0.144.1",
      },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: Array<{ slug: string }> }
    expect(body.models.map(({ slug }) => slug)).toEqual(["gpt-5.6-sol"])
  })

  test("keeps a newer unknown Codex version on its bundled catalog", async () => {
    state.models = createGpt56CopilotModels()

    const response = await createApp().request(
      "/v1/models?client_version=0.145.0",
      {
        headers: {
          "user-agent": "Codex Desktop/0.145.0",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 304 when the Codex model catalog ETag still matches", async () => {
    state.models = createGpt56CopilotModels()
    const app = createApp()
    const requestUrl = "/v1/models?client_version=0.144.1"
    const headers = {
      "user-agent": "codex-tui/0.144.1",
    }

    const firstResponse = await app.request(requestUrl, { headers })
    const etag = firstResponse.headers.get("etag")
    expect(etag).not.toBeNull()

    const cachedResponse = await app.request(requestUrl, {
      headers: {
        ...headers,
        "if-none-match": etag ?? "",
      },
    })

    expect(cachedResponse.status).toBe(304)
    expect(await cachedResponse.text()).toBe("")
    expect(cachedResponse.headers.get("etag")).toBe(etag)
  })
})
