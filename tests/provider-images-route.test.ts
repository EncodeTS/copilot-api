import { describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { createImageRoutes } from "../src/routes/images/route"
import { createProviderImagesPort } from "../src/services/providers/provider-images-port"

const genericConfig: ResolvedProviderConfig = {
  apiKey: "test-provider-key",
  authType: "authorization",
  baseUrl: "https://images.example",
  name: "openai",
  type: "openai-compatible",
}

describe("versioned provider image routes", () => {
  test("preserves provider errors while keeping diagnostics content-safe", async () => {
    const bodyMarker = "body-content-marker"
    const diagnostics: Array<{ event: string; fields: object }> = []
    const fetcher = mock(() =>
      Promise.resolve(
        new Response(`{"error":{"message":"${bodyMarker}"}}\n`, {
          headers: {
            "content-type": "application/json; profile=provider-error",
            "set-cookie": "omit=1",
            "x-request-id": "images-error-1",
          },
          status: 422,
          statusText: "Provider Rejected Image",
        }),
      ),
    )
    const routes = createImageRoutes({
      createProviderImagesPort: (config) =>
        createProviderImagesPort(config, { fetcher }),
      diagnostic: (event, fields) => diagnostics.push({ event, fields }),
      resolveProviderConfig: (provider) =>
        Promise.resolve(provider === "openai" ? genericConfig : null),
    })
    const app = new Hono()
    app.route("/:provider/v1/images", routes)

    const response = await app.request(
      "/openai/v1/images/generations?response_format=b64_json",
      {
        body: `{"prompt":"${bodyMarker}"}`,
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(422)
    expect(response.statusText).toBe("Provider Rejected Image")
    expect(response.headers.get("content-type")).toBe(
      "application/json; profile=provider-error",
    )
    expect(response.headers.get("x-request-id")).toBe("images-error-1")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.text()).toBe(
      `{"error":{"message":"${bodyMarker}"}}\n`,
    )
    expect(diagnostics.map(({ event }) => event)).toEqual([
      "images.generations.request",
      "images.generations.response",
    ])
    expect(JSON.stringify(diagnostics)).not.toContain(bodyMarker)
  })

  test("preserves a byte-exact 5xx response and safe headers", async () => {
    const rawBody = new Uint8Array([117, 112, 115, 116, 114, 101, 97, 109])
    const routes = createImageRoutes({
      createProviderImagesPort: (config) =>
        createProviderImagesPort(config, {
          fetcher: () =>
            Promise.resolve(
              new Response(rawBody, {
                headers: {
                  "content-type": "application/octet-stream",
                  "set-cookie": "omit=1",
                  "x-upstream-status": "degraded",
                },
                status: 503,
                statusText: "Temporarily Unavailable",
              }),
            ),
        }),
      resolveProviderConfig: () => Promise.resolve(genericConfig),
    })
    const app = new Hono()
    app.route("/:provider/v1/images", routes)

    const response = await app.request("/openai/v1/images/edits", {
      body: new Uint8Array([1, 2, 3]),
      method: "POST",
    })

    expect(response.status).toBe(503)
    expect(response.statusText).toBe("Temporarily Unavailable")
    expect(response.headers.get("x-upstream-status")).toBe("degraded")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(rawBody)
  })

  test("does not expose transport error content in diagnostics or responses", async () => {
    const bodyMarker = "transport-content-marker"
    const diagnostics: Array<{ event: string; fields: object }> = []
    const routes = createImageRoutes({
      createProviderImagesPort: () => ({
        dispatch: () => Promise.reject(new Error(bodyMarker)),
      }),
      diagnostic: (event, fields) => diagnostics.push({ event, fields }),
      resolveProviderConfig: () => Promise.resolve(genericConfig),
    })
    const app = new Hono()
    app.route("/:provider/v1/images", routes)

    const response = await app.request("/openai/v1/images/generations", {
      body: `{"prompt":"${bodyMarker}"}`,
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain(bodyMarker)
    expect(JSON.stringify(diagnostics)).not.toContain(bodyMarker)
  })
})
