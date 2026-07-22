import { describe, expect, test } from "bun:test"

import { createProviderProxyResponse } from "../src/services/providers/provider-proxy"

describe("provider proxy response metadata", () => {
  test("preserves safe metadata while stripping cookies and transport headers", async () => {
    const response = createProviderProxyResponse(
      new Response("provider body", {
        headers: {
          connection: "keep-alive",
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "11",
          "set-cookie": "provider_session=private",
          "set-cookie2": "provider_legacy=private",
          "x-request-id": "provider-safe-id",
        },
        status: 429,
        statusText: "Provider busy",
      }),
    )

    expect(response.status).toBe(429)
    expect(response.statusText).toBe("Provider busy")
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    )
    expect(response.headers.get("retry-after")).toBe("11")
    expect(response.headers.get("x-request-id")).toBe("provider-safe-id")
    expect(response.headers.get("connection")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("set-cookie2")).toBeNull()
    expect(await response.text()).toBe("provider body")
  })
})
