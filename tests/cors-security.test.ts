import { expect, test } from "bun:test"

import { server } from "~/server"

test("same-origin CORS responses never authorize credentials", async () => {
  const response = await server.request("/", {
    headers: {
      cookie: "session=private",
      origin: "http://localhost",
    },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "http://localhost",
  )
  expect(response.headers.get("access-control-allow-credentials")).toBeNull()
})
