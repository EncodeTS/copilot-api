import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualTokenModule = await import("../src/lib/token")

let codexProviderConfig: ResolvedProviderConfig | null = null

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) =>
    provider === "codex" ? codexProviderConfig : null,
  getRawProviderConfig: (provider: string) =>
    provider === "codex" ? codexProviderConfig : null,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: async () => {},
}))

const { state } = await import("../src/lib/state")
const { forwardCodexAlphaSearch, resolveCodexAlphaSearchUrl } = await import(
  "../src/services/codex/alpha-search"
)
const { forwardCodexModels, getModels, resolveCodexModelsUrl } = await import(
  "../src/services/codex/get-models"
)
const { alphaSearchRoutes } = await import("../src/routes/alpha-search/route")

const originalFetch = globalThis.fetch
const alphaSearchPayload = {
  id: "search-request-id",
  model: "gpt-5.6-sol",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "search query",
        },
      ],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "searching",
        },
      ],
      phase: "commentary",
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-id",
      },
    },
  ],
  commands: {
    open: [{ ref_id: "turn0search0" }],
    response_length: "long",
  },
  settings: {
    allowed_callers: ["direct"],
    external_web_access: false,
  },
  max_output_tokens: 10_000,
}
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ results: [{ title: "result" }] }), {
        headers: {
          "content-type": "application/json",
          "x-upstream": "codex",
        },
        status: 200,
      }),
    ),
)

function createApp() {
  const app = new Hono()
  app.route("/alpha/search", alphaSearchRoutes)
  return app
}

beforeEach(() => {
  codexProviderConfig = {
    apiKey: "unused-provider-key",
    authType: "oauth2",
    baseUrl: "https://chatgpt.com/backend-api",
    name: "codex",
    type: "openai-responses",
  }
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("Codex alpha search URL", () => {
  test("builds the upstream URL and preserves query parameters", () => {
    expect(
      resolveCodexAlphaSearchUrl("http://localhost/alpha/search?q=bun&page=2"),
    ).toBe("https://chatgpt.com/backend-api/codex/alpha/search?q=bun&page=2")
  })

  test("uses the fixed Codex API base URL", () => {
    expect(resolveCodexAlphaSearchUrl("/alpha/search")).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search",
    )
  })
})

describe("Codex models forwarding", () => {
  test("uses the fixed Codex models URL and preserves query parameters", () => {
    expect(
      resolveCodexModelsUrl("http://localhost/v1/models?client=codex"),
    ).toBe("https://chatgpt.com/backend-api/codex/models?client=codex")
  })

  test("forwards model requests with Codex auth headers", async () => {
    await forwardCodexModels(
      "http://localhost/v1/models?client=codex",
      new Headers({ accept: "*/*" }),
    )

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    expect(init?.method).toBe("GET")
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("keeps the built-in Codex model catalog available", () => {
    const models = getModels()
    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toContain("gpt-5.6-sol")
  })
})

describe("Codex alpha search forwarding", () => {
  test("forwards POST body, query, and Codex auth headers", async () => {
    const response = await createApp().request(
      "/alpha/search?q=typescript&limit=5",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: "Bearer client-token",
          "content-type": "application/json",
          cookie: "session=test-cookie",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-client-header": "kept",
        },
        body: JSON.stringify(alphaSearchPayload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      results: [{ title: "result" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/alpha/search?q=typescript&limit=5",
    )
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual(alphaSearchPayload)
  })

  test("does not expose alpha search over GET", async () => {
    const response = await createApp().request("/alpha/search?q=bun")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("adds JSON content type when a request body has none", async () => {
    await forwardCodexAlphaSearch(
      new Request("http://localhost/alpha/search", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    )
  })

  test("returns 404 when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/alpha/search?q=bun", {
      method: "POST",
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'codex' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
