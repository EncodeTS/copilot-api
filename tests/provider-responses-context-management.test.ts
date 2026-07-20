import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { ResponsesResult } from "../src/services/copilot/create-responses"
import type { CodexProviderCatalogSnapshot } from "../src/services/codex/get-models"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")
const actualTokenUsageModule = await import("../src/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null

const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
  getRawProviderConfig: () => providerConfig,
  isResponsesApiWebSocketEnabled: () => false,
  resolveMappedModel: (model: string) => model,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { responsesRoutes } = await import("../src/routes/responses/route")
const { state } = await import("../src/lib/state")
const { providerResponsesDependencies } = await import(
  "../src/routes/provider/responses/handler"
)
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)

const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }
const originalFetch = globalThis.fetch
const originalLoadCodexProviderModels =
  providerResponsesDependencies.loadCodexProviderModels
const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

const codexCatalogSnapshot: CodexProviderCatalogSnapshot = {
  catalog: {
    data: [
      {
        capabilities: {
          family: "gpt-test",
          limits: { max_prompt_tokens: 372_000 },
          object: "model_capabilities",
          supports: { reasoning_effort: ["low", "max", "ultra"] },
          type: "chat",
        },
        id: "gpt-test",
        model_picker_enabled: true,
        name: "GPT Test",
        object: "model",
        vendor: "openai",
        version: "codex-official",
      },
    ],
    object: "list",
  },
  diagnostics: [],
  fetchedAt: 1,
  freshness: "fresh",
  source: "official",
}
const loadCodexProviderModels = mock((_signal?: AbortSignal) =>
  Promise.resolve(codexCatalogSnapshot),
)

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const parseJsonRequestBody = (body: unknown): unknown => {
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body")
  }

  return JSON.parse(body) as unknown
}

const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
  const body = parseJsonRequestBody(init?.body) as { model: string }
  return Promise.resolve(
    new Response(JSON.stringify(createResponsesResult(body.model)), {
      headers: {
        "content-type": "application/json",
      },
    }),
  )
})

const createApp = () => {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  return app
}

beforeEach(() => {
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://openai-responses.example",
    models: {
      "gpt-test": {},
    },
    name: "openai",
    type: "openai-responses",
  }

  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  loadCodexProviderModels.mockClear()
  providerResponsesDependencies.loadCodexProviderModels =
    loadCodexProviderModels
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
  providerResponsesDependencies.loadCodexProviderModels =
    originalLoadCodexProviderModels
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("provider Responses context management", () => {
  test("loads bounded Codex provider truth before direct Responses generation", async () => {
    providerConfig = {
      apiKey: "unused",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({ input: "hello", model: "codex/gpt-test" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-copilot-api-codex-catalog-source")).toBe(
      "official",
    )
    expect(loadCodexProviderModels).toHaveBeenCalledTimes(1)
    expect(loadCodexProviderModels.mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    )
  })

  test("rejects direct Codex Responses effort outside the descriptor", async () => {
    providerConfig = {
      apiKey: "unused",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "codex/gpt-test",
        reasoning: { effort: "xhigh" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Reasoning effort 'xhigh' is not supported by Codex model 'gpt-test'",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not exempt explicit none from Codex descriptor validation", async () => {
    providerConfig = {
      apiKey: "unused",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    }
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "codex/gpt-test",
        reasoning: { effort: "none" },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Reasoning effort 'none' is not supported by Codex model 'gpt-test'",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("emits an error when a provider Responses stream ends without a typed terminal", async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"sequence_number":1,"delta":"partial"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "openai/gpt-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"delta":"partial"')
    expect(body).toContain("event: error")
    expect(body).toContain(
      "Provider Responses stream ended without a terminal event",
    )
  })

  test("emits an error when a provider Responses stream throws after partial output", async () => {
    const encoder = new TextEncoder()
    let pullCount = 0
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1
          controller.enqueue(
            encoder.encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"sequence_number":1,"delta":"partial"}\n\n',
            ),
          )
          return
        }
        controller.error(new Error("provider socket reset"))
      },
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(upstreamBody, {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    )

    const response = await createApp().request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "openai/gpt-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("provider socket reset")
  })

  test("does not add context management or compact provider Responses input by default", async () => {
    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("does not mutate generic provider input without an explicit context management capability", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toBeUndefined()
    expect(body.input).toHaveLength(3)
  })

  test("adds context management and keeps only the latest compaction carrier when enabled", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    providerConfig = {
      ...providerConfig!,
      capabilities: {
        responsesContextManagement: true,
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<Record<string, unknown>>
    }

    expect(body.context_management).toEqual([
      {
        compact_threshold: 160000,
        type: "compaction",
      },
    ])
    expect(body.input).toEqual([
      {
        encrypted_content: "cipher",
        id: "compaction-1",
        type: "compaction",
      },
      {
        content: "latest",
        role: "user",
      },
    ])
  })

  test("allows a single provider model to opt in without enabling its siblings", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    providerConfig = {
      ...providerConfig!,
      models: {
        "gpt-test": {
          responsesContextManagement: true,
        },
        "gpt-without-compaction": {},
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [{ content: "hello", role: "user" }],
        model: "openai/gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
    }
    expect(body.context_management).toEqual([
      {
        compact_threshold: 160000,
        type: "compaction",
      },
    ])

    const siblingResponse = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [{ content: "hello", role: "user" }],
        model: "openai/gpt-without-compaction",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(siblingResponse.status).toBe(200)
    const [, siblingInit] = fetchMock.mock.calls[1]
    const siblingBody = parseJsonRequestBody(
      (siblingInit as RequestInit).body,
    ) as {
      context_management?: unknown
    }
    expect(siblingBody.context_management).toBeUndefined()
  })

  test("applies enabled context management to gpt-5.6 provider models", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    providerConfig = {
      ...providerConfig!,
      capabilities: {
        responsesContextManagement: true,
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-5.6-sol",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toEqual([
      { compact_threshold: 160000, type: "compaction" },
    ])
    expect(body.input).toHaveLength(2)
  })

  test("does not disable enabled context management for future GPT provider models", async () => {
    responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
      true
    providerConfig = {
      ...providerConfig!,
      capabilities: {
        responsesContextManagement: true,
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: "older",
            role: "user",
          },
          {
            encrypted_content: "cipher",
            id: "compaction-1",
            type: "compaction",
          },
          {
            content: "latest",
            role: "user",
          },
        ],
        model: "openai/gpt-6",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0]
    const body = parseJsonRequestBody((init as RequestInit).body) as {
      context_management?: unknown
      input: Array<unknown>
    }

    expect(body.context_management).toEqual([
      { compact_threshold: 160000, type: "compaction" },
    ])
    expect(body.input).toHaveLength(2)
  })
})
