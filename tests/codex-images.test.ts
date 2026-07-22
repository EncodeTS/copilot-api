import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { state } from "../src/lib/state"
import type { UpstreamFetch } from "../src/lib/upstream-lifecycle"
import { createImageRoutes } from "../src/routes/images/route"
import {
  createProviderImagesPort,
  resolveCodexImagesUrl,
} from "../src/services/providers/provider-images-port"
import { server } from "../src/server"

const codexConfig: ResolvedProviderConfig = {
  apiKey: "unused-config-key",
  authType: "oauth2",
  baseUrl: "https://chatgpt.com/backend-api",
  name: "codex",
  type: "openai-responses",
}

afterEach(() => {
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

const createCodexApp = (fetcher: UpstreamFetch): Hono => {
  const routes = createImageRoutes({
    createProviderImagesPort: (config) =>
      createProviderImagesPort(config, { fetcher }),
    resolveProviderConfig: (provider) =>
      Promise.resolve(provider === "codex" ? codexConfig : null),
  })
  const app = new Hono()
  app.route("/images", routes)
  app.route("/v1/images", routes)
  app.route("/:provider/v1/images", routes)
  return app
}

describe("Codex image compatibility routes", () => {
  test("forwards exact generation bytes through the unversioned alias", async () => {
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    const exactBody = '{\n "prompt": "wire exact", "n": 1\n}\n'
    let forwardedBody = ""
    let forwardedUrl = ""
    let forwardedHeaders = new Headers()
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        forwardedUrl = requestUrl(input)
        forwardedHeaders = new Headers(init?.headers)
        forwardedBody = await new Response(init?.body).text()
        return new Response('{"data":[]}\n', {
          headers: { "content-type": "application/json" },
        })
      },
    )

    const response = await createCodexApp(fetcher).request(
      "/images/generations?output=base64",
      {
        body: exactBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"data":[]}\n')
    expect(forwardedUrl).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations?output=base64",
    )
    expect(forwardedBody).toBe(exactBody)
    expect(forwardedHeaders.get("authorization")).toBe(
      "Bearer codex-access-token",
    )
    expect(forwardedHeaders.get("chatgpt-account-id")).toBe("account-123")
  })

  test("preserves raw multipart edit bytes through the v1 alias", async () => {
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    const boundary = "----exact-codex-edit"
    const exactBytes = new Uint8Array([45, 45, 13, 10, 0, 255, 13, 10, 45])
    let forwardedBytes = new Uint8Array()
    let forwardedContentType = ""
    const fetcher = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedContentType =
          new Headers(init?.headers).get("content-type") ?? ""
        forwardedBytes = new Uint8Array(
          await new Response(init?.body).arrayBuffer(),
        )
        return Response.json({ data: [] })
      },
    )

    const response = await createCodexApp(fetcher).request("/v1/images/edits", {
      body: exactBytes,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(forwardedContentType).toBe(
      `multipart/form-data; boundary=${boundary}`,
    )
    expect(forwardedBytes).toEqual(exactBytes)
  })

  test("returns 404 for missing providers and does not expose GET", async () => {
    const fetcher = mock(() => Promise.resolve(Response.json({ data: [] })))
    const app = createCodexApp(fetcher)

    const providerResponse = await app.request(
      "/missing/v1/images/generations",
      { method: "POST" },
    )
    expect(providerResponse.status).toBe(404)
    expect(await providerResponse.json()).toEqual({
      error: {
        message: "Provider 'missing' not found or disabled",
        type: "invalid_request_error",
      },
    })
    expect((await app.request("/images/generations")).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

test("Codex image URL uses the configured base and preserves query bytes", () => {
  expect(
    resolveCodexImagesUrl(
      "https://codex.example/backend-api",
      "http://localhost/codex/v1/images/edits?mask=a%2Fb&n=2",
      "edits",
    ),
  ).toBe("https://codex.example/backend-api/codex/images/edits?mask=a%2Fb&n=2")
})

test("server registers legacy and versioned provider image routes", () => {
  const postPaths = new Set(
    server.routes
      .filter((route) => route.method === "POST")
      .map((route) => route.path),
  )

  for (const path of [
    "/images/generations",
    "/images/edits",
    "/v1/images/generations",
    "/v1/images/edits",
    "/:provider/v1/images/generations",
    "/:provider/v1/images/edits",
  ]) {
    expect(postPaths.has(path)).toBe(true)
  }
})

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString()
