import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ModelsResponse } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}
let modelMappings: Record<string, string> = {}
let bundledCodexCatalog: ReturnType<typeof createCodexCatalog>

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelMappings: () => modelMappings,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("../src/lib/state")
const { PATHS } = await import("../src/lib/paths")
const { codexClientModelsDependencies } = await import(
  "../src/services/codex/client-models"
)
const { clearCodexCatalogCache, loadInstalledCodexCatalog } = await import(
  "../src/services/codex/installed-catalog"
)
const { clearCodexProviderCatalogCache } = await import(
  "../src/services/codex/get-models"
)
const { modelRoutes } = await import("../src/routes/models/route")
const { providerModelRoutes } = await import(
  "../src/routes/provider/models/route"
)

const originalFetch = globalThis.fetch
let codexModelsUnavailable = false
let slowProviderAborted = false

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
      display_name: "GPT-5.6-Sol",
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "max", description: "Max" },
        { effort: "ultra", description: "Ultra" },
      ],
      shell_type: "shell_command",
      supported_in_api: true,
      visibility: "list",
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
    },
  ],
})

const fetchMock = mock((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  if (requestUrl === "https://abort.example/v1/models") {
    const error = new Error("upstream aborted")
    error.name = "AbortError"
    return Promise.reject(error)
  }

  if (requestUrl === "https://slow.example/v1/models") {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const timeout = setTimeout(() => {
        const error = new Error("slow provider test timed out")
        error.name = "AbortError"
        reject(error)
      }, 50)
      const abort = () => {
        clearTimeout(timeout)
        slowProviderAborted = true
        reject(
          signal?.reason instanceof Error ?
            signal.reason
          : new Error("aggregate request aborted"),
        )
      }
      if (signal?.aborted) {
        abort()
      } else {
        signal?.addEventListener("abort", abort, { once: true })
      }
    })
  }

  if (requestUrl.startsWith("https://chatgpt.com/backend-api/codex/models")) {
    return Promise.resolve(
      codexModelsUnavailable ?
        new Response("temporarily unavailable", { status: 503 })
      : Response.json(bundledCodexCatalog),
    )
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
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

beforeEach(() => {
  enabledProviders = []
  modelMappings = {}
  providerConfigs = {}
  bundledCodexCatalog = createCodexCatalog()
  codexModelsUnavailable = false
  slowProviderAborted = false
  state.models = undefined
  fetchMock.mockClear()
  clearCodexCatalogCache()
  clearCodexProviderCatalogCache()
  codexClientModelsDependencies.loadBundledCatalog = (version) =>
    Promise.resolve(version === "0.144.1" ? bundledCodexCatalog : null)
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
  clearCodexProviderCatalogCache()
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

  test("projects target operations onto an existing source without mutating the live snapshot", async () => {
    const source = createCopilotModels(["gpt-source"]).data[0]
    source.name = "Source display"
    source.preview = true
    source.vendor = "source-vendor"
    source.version = "source-version"
    source.supported_endpoints = ["/chat/completions"]
    const target = createGpt56CopilotModels().data[0]
    target.id = "gpt-target"
    target.name = "Target display"
    const originalSource = structuredClone(source)
    const originalTarget = structuredClone(target)
    state.models = {
      data: [source, target],
      object: "list",
    }
    modelMappings = { "gpt-source": "gpt-target" }

    const response = await createApp().request("/v1/models")
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>
    }
    const virtualSource = body.data.find(({ id }) => id === "gpt-source")

    expect(virtualSource).toMatchObject({
      id: "gpt-source",
      display_name: "Source display",
      name: "Source display",
      object: "model",
      preview: true,
      supported_endpoints: target.supported_endpoints,
      vendor: target.vendor,
      version: target.version,
    })
    expect(virtualSource?.capabilities).toEqual(target.capabilities)
    expect(body.data.map(({ id }) => id)).toContain("gpt-target")
    expect(source).toEqual(originalSource)
    expect(target).toEqual(originalTarget)
    expect(virtualSource?.capabilities).not.toBe(target.capabilities)
  })

  test("does not synthesize absent sources or provider-target capabilities", async () => {
    state.models = createGpt56CopilotModels()
    modelMappings = {
      "absent-source": "gpt-5.6-sol",
      "gpt-5.6-sol": "provider/model",
    }

    const response = await createApp().request("/v1/models")
    const body = (await response.json()) as {
      data: Array<{ id: string; vendor: string }>
    }

    expect(body.data.map(({ id }) => id)).toEqual(["gpt-5.6-sol"])
    expect(body.data[0]?.vendor).toBe("openai")
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

  test("forwards aggregate cancellation to non-Codex discovery", async () => {
    enabledProviders = ["slow"]
    providerConfigs = {
      slow: createProviderConfig("slow", "https://slow.example"),
    }
    const controller = new AbortController()
    const responsePromise = createApp().request(
      new Request("http://localhost/v1/models", {
        signal: controller.signal,
      }),
    )
    await Promise.resolve()

    controller.abort(new Error("aggregate disconnected"))
    const response = await responsePromise

    expect(slowProviderAborted).toBeTrue()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "aggregate disconnected", type: "error" },
    })
  })

  test("does not convert an abort-class provider failure into an empty list", async () => {
    enabledProviders = ["abort"]
    providerConfigs = {
      abort: createProviderConfig("abort", "https://abort.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { message: "upstream aborted", type: "error" },
    })
  })

  test("derives Codex provider models from the official catalog", async () => {
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
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(response.headers.get("x-copilot-api-codex-catalog-source")).toBe(
      "official",
    )
    expect(response.headers.get("x-copilot-api-codex-catalog-freshness")).toBe(
      "fresh",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("does not feed Copilot capabilities back into Codex provider truth", async () => {
    state.models = createGpt56CopilotModels()
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
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models")
    const body = (await response.json()) as {
      data: Array<{
        capabilities: {
          limits: { max_context_window_tokens: number }
          supports: { reasoning_effort: Array<string> }
        }
        id: string
      }>
    }
    const copilot = body.data.find(({ id }) => id === "gpt-5.6-sol")
    const codex = body.data.find(({ id }) => id === "codex/gpt-5.6-sol")

    expect(copilot?.capabilities.limits.max_context_window_tokens).toBe(
      1_050_000,
    )
    expect(codex?.capabilities.limits.max_context_window_tokens).toBe(372_000)
    expect(copilot?.capabilities.supports.reasoning_effort).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(codex?.capabilities.supports.reasoning_effort).toEqual([
      "low",
      "max",
      "ultra",
    ])
  })

  test("labels the static Codex catalog when official discovery fails", async () => {
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
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    codexModelsUnavailable = true

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<{
        capabilities: { supports: { reasoning_effort?: Array<string> } }
        id: string
      }>
    }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.4")
    expect(
      body.data.find(({ id }) => id === "codex/gpt-5.6-sol")?.capabilities
        .supports.reasoning_effort,
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"])
    expect(response.headers.get("x-copilot-api-codex-catalog-source")).toBe(
      "static_fallback",
    )
    expect(response.headers.get("x-copilot-api-codex-catalog-freshness")).toBe(
      "degraded",
    )
    expect(
      response.headers.get("x-copilot-api-codex-catalog-diagnostics"),
    ).toBe(
      "official_unavailable,static_capability_degraded,static_effort_filtered",
    )
  })

  test("returns official unqualified models from the Codex provider route", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/codex/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map(({ id }) => id)).toEqual(["gpt-5.6-sol"])
    expect(response.headers.get("x-copilot-api-codex-catalog-source")).toBe(
      "official",
    )
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
    ).toEqual(["low", "max"])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("persists a successful Codex models response for the next startup", async () => {
    await fs.rm(PATHS.CODEX_MODEL_CATALOG_PATH, { force: true })
    state.models = createGpt56CopilotModels()

    const response = await createApp().request(
      "/v1/models?client_version=0.144.1",
      {
        headers: {
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )
    const responseBody = (await response.json()) as { models: Array<unknown> }

    expect(response.status).toBe(200)
    const persisted = JSON.parse(
      await fs.readFile(PATHS.CODEX_MODEL_CATALOG_PATH, "utf8"),
    ) as {
      _copilot_api: { client_version: string }
      models: Array<unknown>
    }
    expect(persisted.models).toEqual(responseBody.models)
    expect(persisted._copilot_api.client_version).toBe("0.144.1")
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

  test("returns an empty catalog for conflicting Codex client versions", async () => {
    state.models = createGpt56CopilotModels()

    const response = await createApp().request(
      "/v1/models?client_version=0.144.1",
      {
        headers: {
          "user-agent": "codex-tui/0.144.2",
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

  test("changes Codex ETags only when mappings change the effective catalog", async () => {
    bundledCodexCatalog = {
      models: [
        {
          ...createCodexCatalog().models[0],
          base_instructions: "mini instructions",
          display_name: "Mini",
          slug: "gpt-mini",
        },
        {
          ...createCodexCatalog().models[0],
          base_instructions: "target instructions",
          display_name: "Target",
          slug: "gpt-target",
        },
      ],
    }
    const mini = createGpt56CopilotModels().data[0]
    mini.id = "gpt-mini"
    mini.name = "Mini"
    const target = structuredClone(mini)
    target.id = "gpt-target"
    target.name = "Target"
    target.capabilities.limits.max_context_window_tokens = 400_000
    state.models = { data: [mini, target], object: "list" }
    const request = {
      headers: { "user-agent": "codex-tui/0.144.1" },
    }
    const app = createApp()

    const baseline = await app.request(
      "/v1/models?client_version=0.144.1",
      request,
    )
    const baselineEtag = baseline.headers.get("etag")

    modelMappings = { "irrelevant-source": "provider/model" }
    const irrelevant = await app.request(
      "/v1/models?client_version=0.144.1",
      request,
    )
    expect(irrelevant.headers.get("etag")).toBe(baselineEtag)

    modelMappings = { "gpt-mini": "gpt-target" }
    const effective = await app.request(
      "/v1/models?client_version=0.144.1",
      request,
    )
    expect(effective.headers.get("etag")).not.toBe(baselineEtag)
  })
})
