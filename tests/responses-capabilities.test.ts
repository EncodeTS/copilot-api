import { describe, expect, test } from "bun:test"

import { getResponsesEndpointCapabilities } from "../src/lib/responses-capabilities"

describe("Responses endpoint capabilities", () => {
  test.each(["/responses", "/v1/responses"])(
    "recognizes %s as HTTP Responses",
    (endpoint) => {
      expect(
        getResponsesEndpointCapabilities({
          supported_endpoints: [endpoint],
        }),
      ).toEqual({ http: true, websocket: false })
    },
  )

  test("recognizes WebSocket-only Responses separately", () => {
    expect(
      getResponsesEndpointCapabilities({
        supported_endpoints: ["ws:/responses"],
      }),
    ).toEqual({ http: false, websocket: true })
  })

  test("returns no capabilities when endpoints are absent", () => {
    expect(getResponsesEndpointCapabilities(undefined)).toEqual({
      http: false,
      websocket: false,
    })
  })
})
