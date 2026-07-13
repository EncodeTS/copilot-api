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
const { forwardCodexImages, resolveCodexImagesUrl } = await import(
  "../src/services/codex/images"
)
const { imageRouteDependencies, imageRoutes } = await import(
  "../src/routes/images/route"
)
const { server } = await import("../src/server")

const originalDebugJsonAsync = imageRouteDependencies.debugJsonAsync
let debugValues: Array<unknown> = []
const debugJsonAsyncMock = mock(
  async (
    _logger: Parameters<typeof originalDebugJsonAsync>[0],
    _label: string,
    factory: Parameters<typeof originalDebugJsonAsync>[2],
  ) => {
    if (state.verbose) {
      debugValues.push(await factory())
    }
  },
)

const originalFetch = globalThis.fetch
type StreamingRequestInit = RequestInit & { duplex?: "half" }
const fetchMock = mock(
  (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          created: 1_784_000_000,
          data: [{ b64_json: "generated-image" }],
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-upstream": "codex",
          },
          status: 200,
        },
      ),
    ),
)

function createApp() {
  const app = new Hono()
  app.route("/images", imageRoutes)
  app.route("/v1/images", imageRoutes)
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
  state.verbose = false
  fetchMock.mockClear()
  debugJsonAsyncMock.mockClear()
  debugValues = []
  imageRouteDependencies.debugJsonAsync = debugJsonAsyncMock
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
  state.verbose = false
  imageRouteDependencies.debugJsonAsync = originalDebugJsonAsync
})

describe("Codex images URL", () => {
  test("builds the generations URL and preserves query parameters", () => {
    expect(
      resolveCodexImagesUrl(
        "http://localhost/v1/images/generations?client=codex&format=png",
        "generations",
      ),
    ).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?client=codex&format=png",
    )
  })

  test("builds the edits URL", () => {
    expect(resolveCodexImagesUrl("/images/edits", "edits")).toBe(
      "https://chatgpt.com/backend-api/codex/images/edits",
    )
  })
})

describe("Codex images forwarding", () => {
  test("forwards a JSON generation request and Codex auth headers", async () => {
    const payload = {
      model: "gpt-image-2",
      prompt: "A small robot watering a plant",
      quality: "high",
      size: "1024x1024",
    }

    const response = await createApp().request(
      "/images/generations?output=base64",
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
        body: JSON.stringify(payload),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-upstream")).toBe("codex")
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
    expect(init?.method).toBe("POST")
    expect((init as StreamingRequestInit | undefined)?.duplex).toBe("half")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("session=test-cookie")
    expect(headers.get("originator")).toBe("codex-tui")
    expect(headers.get("user-agent")).toBe("codex-tui/test")
    expect(headers.get("x-client-header")).toBe("kept")
    expect(await new Response(init?.body).json()).toEqual(payload)
  })

  test("preserves multipart fields and file bytes for image edits", async () => {
    state.verbose = true
    const formData = new FormData()
    formData.set("model", "gpt-image-2")
    formData.set("prompt", "Make the background transparent")
    formData.set(
      "image",
      new Blob(["source-image-bytes"], { type: "image/png" }),
      "source.png",
    )

    const response = await createApp().request("/v1/images/edits", {
      method: "POST",
      body: formData,
    })

    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")

    const headers = new Headers(init?.headers)
    expect(headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    )
    const forwardedResponse = new Response(init?.body, {
      headers,
    })
    const forwardedFormData = await forwardedResponse.formData()
    expect(forwardedFormData.get("model")).toBe("gpt-image-2")
    expect(forwardedFormData.get("prompt")).toBe(
      "Make the background transparent",
    )

    const image = forwardedFormData.get("image")
    expect(image).not.toBeNull()
    expect(typeof image).not.toBe("string")
    if (image === null || typeof image === "string") {
      throw new Error("Expected the forwarded image to be a file")
    }
    expect(image.name).toBe("source.png")
    expect(image.type).toBe("image/png")
    expect(await image.text()).toBe("source-image-bytes")
    expect(debugJsonAsyncMock).not.toHaveBeenCalled()
  })

  test("adds JSON defaults when request headers are absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/generations", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
      "generations",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/json")
  })

  test("does not label an edit request as JSON when content type is absent", async () => {
    await forwardCodexImages(
      new Request("http://localhost/images/edits", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      }),
      "edits",
    )

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(new Headers(init?.headers).has("content-type")).toBe(false)
  })

  test("logs only the generation request body when debug logging is enabled", async () => {
    state.verbose = true
    const payload = { prompt: "debug body" }

    const response = await createApp().request("/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      created: 1_784_000_000,
      data: [{ b64_json: "generated-image" }],
    })
    expect(debugJsonAsyncMock).toHaveBeenCalledTimes(1)
    expect(debugJsonAsyncMock.mock.calls[0]?.[1]).toBe(
      "images.generations.codex.request",
    )
    expect(debugValues).toEqual([{ body: JSON.stringify(payload) }])
  })

  test("does not expose image endpoints over GET", async () => {
    const response = await createApp().request("/images/generations")

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("returns 404 when the Codex provider is unavailable", async () => {
    codexProviderConfig = null

    const response = await createApp().request("/images/edits", {
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

test("server registers unversioned and v1 Codex media routes", () => {
  const postPaths = new Set(
    server.routes
      .filter((route) => route.method === "POST")
      .map((route) => route.path),
  )

  const expectedPaths = [
    "/alpha/search",
    "/v1/alpha/search",
    "/images/generations",
    "/images/edits",
    "/v1/images/generations",
    "/v1/images/edits",
  ]
  for (const path of expectedPaths) {
    expect(postPaths.has(path)).toBe(true)
  }
})
