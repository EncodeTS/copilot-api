import { expect, test } from "bun:test"
import { Hono } from "hono"

import {
  forwardError,
  HTTPError,
  LocalPayloadTooLargeError,
} from "../src/lib/error"

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
