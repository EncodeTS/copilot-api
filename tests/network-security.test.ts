import { afterEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { resolveServerNetworkOptions } from "../src/lib/network-security"
import { server } from "../src/server"

const originalCopilotToken = state.copilotToken

afterEach(() => {
  state.copilotToken = originalCopilotToken
})

describe("server listener security", () => {
  test("binds explicitly to loopback by default", () => {
    expect(resolveServerNetworkOptions({ apiKeys: [], lan: false })).toEqual({
      displayHost: "127.0.0.1",
      listenerHost: "127.0.0.1",
    })
  })

  test("refuses deliberate LAN mode without a normal API key", () => {
    expect(() =>
      resolveServerNetworkOptions({ apiKeys: [], lan: true }),
    ).toThrow("LAN mode requires at least one auth.apiKeys entry")
  })

  test("does not treat blank keys as LAN authentication", () => {
    expect(() =>
      resolveServerNetworkOptions({ apiKeys: ["  "], lan: true }),
    ).toThrow("LAN mode requires at least one auth.apiKeys entry")
  })

  test("allows deliberate LAN mode when a normal API key is configured", () => {
    expect(
      resolveServerNetworkOptions({ apiKeys: ["gateway-key"], lan: true }),
    ).toEqual({
      displayHost: "127.0.0.1",
      listenerHost: "0.0.0.0",
    })
  })
})

describe("HTTP network boundary", () => {
  test("rejects DNS-rebinding hostnames", async () => {
    const response = await server.request("http://attacker.example/")

    expect(response.status).toBe(421)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("rejects hostile browser origins by default", async () => {
    const response = await server.request("http://127.0.0.1/", {
      headers: { origin: "https://attacker.example" },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("allows same-origin browser and originless configured clients", async () => {
    const sameOrigin = await server.request("http://127.0.0.1/", {
      headers: { origin: "http://127.0.0.1" },
    })
    const configuredClient = await server.request("http://127.0.0.1/")

    expect(sameOrigin.status).toBe(200)
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1",
    )
    expect(sameOrigin.headers.get("vary")).toContain("Origin")
    expect(configuredClient.status).toBe(200)
  })

  test("answers only same-origin preflight requests", async () => {
    const allowed = await server.request("http://127.0.0.1/v1/models", {
      headers: {
        "access-control-request-headers": "x-api-key,content-type",
        "access-control-request-method": "GET",
        origin: "http://127.0.0.1",
      },
      method: "OPTIONS",
    })
    const denied = await server.request("http://127.0.0.1/v1/models", {
      headers: {
        "access-control-request-method": "GET",
        origin: "https://attacker.example",
      },
      method: "OPTIONS",
    })

    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1",
    )
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "x-api-key, content-type",
    )
    expect(denied.status).toBe(403)
  })
})

describe("sensitive local surfaces", () => {
  test("does not expose the upstream bearer endpoint", async () => {
    state.copilotToken = "upstream-secret-token"

    const anonymous = await server.request("http://127.0.0.1/token")
    const ordinaryClient = await server.request("http://127.0.0.1/token", {
      headers: { "x-api-key": "ordinary-client-key" },
    })

    expect(anonymous.status).toBe(404)
    expect(ordinaryClient.status).toBe(404)
    expect(await anonymous.text()).not.toContain("upstream-secret-token")
    expect(await ordinaryClient.text()).not.toContain("upstream-secret-token")
  })

  test("serves a same-origin-only viewer with restrictive browser policy", async () => {
    const response = await server.request(
      "http://127.0.0.1/usage-viewer?endpoint=https://attacker.example/collect&x-api-key=saved-secret",
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const contentSecurityPolicy = response.headers.get(
      "content-security-policy",
    )
    expect(contentSecurityPolicy).toContain("default-src 'none'")
    expect(contentSecurityPolicy).toContain("connect-src 'self'")
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'")
    expect(contentSecurityPolicy).toContain("script-src 'sha256-")
    expect(html).not.toContain("attacker.example")
    expect(html).not.toContain("saved-secret")
    expect(html).not.toContain("localStorage")
    expect(html).not.toContain("cdn.tailwindcss.com")
    expect(html).not.toContain("fonts.googleapis.com")
    expect(html).not.toContain("unpkg.com")
    expect(html).not.toContain("typeof lucide")
    expect(html).not.toContain('urlParams.get("endpoint")')
    expect(html).toContain('const DEFAULT_ENDPOINT = "/usage"')
    expect(html).toContain("data-local-icon")
  })

  test("serves the compiled Viewer utilities from the same origin", async () => {
    const response = await server.request("http://127.0.0.1/usage-viewer.css")
    const css = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/css")
    expect(css).toContain("tailwindcss v4")
    expect(css).toContain(".animate-spin")
    expect(css).toContain(".flex")
    expect(css).toContain(".grid")
  })
})
