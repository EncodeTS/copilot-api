import { expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import {
  forwardError,
  HTTPError,
  LocalPayloadTooLargeError,
} from "../src/lib/error"
import { RequestBodyTooLargeError } from "../src/lib/request-body-policy"
import { serverErrorHandler } from "../src/server"

test("forwardError preserves a structured upstream error envelope", async () => {
  const upstreamBody = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "max_tokens must be positive",
    },
    request_id: "request-upstream",
  }
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Upstream failed",
        Response.json(upstreamBody, { status: 400 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual(upstreamBody)
})

test("forwardError wraps a non-JSON upstream error body", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "Upstream failed",
        new Response("gateway unavailable", { status: 503 }),
      ),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    error: {
      message: "gateway unavailable",
      type: "error",
    },
  })
})

test("forwardError strips compression stack traces from local 413 responses", async () => {
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new LocalPayloadTooLargeError("payload too large", {
        budgetBytes: 100,
        compressionDiagnosticSamples: [
          {
            message: "decode failed",
            stack: "/private/app/src/image-compression.ts:1",
          },
        ],
        currentVisualWorkingSetReplaced: false,
        fileDataBytes: 0,
        imageBytes: 120,
        imageCount: 1,
        latestImageReplaced: false,
        payloadBytes: 120,
        replacedCount: 0,
        sendHardLimitBytes: 100,
        textAndToolBytes: 0,
      }),
    ),
  )

  const response = await app.request("/")
  expect(response.status).toBe(413)
  const body = (await response.json()) as {
    error: {
      details: {
        compressionDiagnosticSamples: Array<Record<string, unknown>>
      }
    }
  }
  expect(body.error.details.compressionDiagnosticSamples).toEqual([
    {
      message: "decode failed",
    },
  ])
})

test("forwardError preserves structured inbound body-limit errors", async () => {
  const app = new Hono()
  app.get("/", (c) => forwardError(c, new RequestBodyTooLargeError("encoded")))

  const response = await app.request("/")

  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({
    error: {
      code: "local_request_body_too_large",
      message: "Encoded request body exceeds the local safety limit.",
      stage: "encoded",
      type: "payload_too_large",
    },
  })
})

test("serverErrorHandler preserves structured inbound body-limit errors", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {})
  const app = new Hono()
  app.onError(serverErrorHandler)
  app.get("/", () => {
    throw new RequestBodyTooLargeError("decoded")
  })

  const response = await app.request("/")

  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    error: {
      code: "local_request_body_too_large",
      stage: "decoded",
    },
  })
  expect(consoleError).not.toHaveBeenCalled()
  consoleError.mockRestore()
})

test("serverErrorHandler keeps unexpected errors generic", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {})
  const app = new Hono()
  app.onError(serverErrorHandler)
  app.get("/", () => {
    throw new Error("private failure details")
  })

  const response = await app.request("/")

  expect(response.status).toBe(500)
  expect(await response.text()).toBe("Internal Server Error")
  expect(consoleError).toHaveBeenCalledTimes(1)
  consoleError.mockRestore()
})
