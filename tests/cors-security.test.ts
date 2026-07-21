import { expect, test } from "bun:test"

import { server } from "~/server"

test("CORS wildcard responses never authorize credentials", async () => {
  const response = await server.request("/", {
    headers: {
      cookie: "session=private",
      origin: "https://untrusted.example",
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBe("*")
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()
})
