import { expect, test } from "bun:test"
import { Hono } from "hono"

import { forwardError, HTTPError } from "../src/lib/error"
import {
  getResponsesStreamSessionFailure,
  runResponsesStreamSession,
} from "../src/lib/responses-stream-session"
import { parseResponsesStreamEventData } from "../src/lib/responses-stream-protocol"
import { getUpstreamResponseMetadataHeaders } from "../src/lib/upstream-response-headers"
import { normalizeInputImageDetails } from "../src/routes/responses/utils"
import type { ResponsesPayload } from "../src/services/copilot/create-responses"

test.each([400, 429, 503])(
  "preserves upstream retry and trace metadata at status %s without leaking headers",
  async (status) => {
    const headers = {
      "content-type": "application/json",
      "retry-after": "12",
      "x-request-id": "upstream-request",
      "request-id": "service-request",
      "x-github-request-id": "github-request",
      "x-github-backend": "Kubernetes",
      "x-ratelimit-remaining-requests": "0",
      "openai-processing-ms": "12",
      "set-cookie": "private=value",
      authorization: "Bearer private",
      "x-private-header": "private",
      "content-length": "1",
      "x-frame-options": "ALLOWALL",
    }
    const app = new Hono()
    const body = JSON.stringify({
      error: { code: "test_error", message: "test" },
    })
    app.get("/", (c) =>
      forwardError(
        c,
        new HTTPError("test", new Response(body, { status, headers })),
      ),
    )
    const response = await app.request("/")
    expect(response.status).toBe(status)
    expect(await response.text()).toBe(body)
    for (const name of [
      "retry-after",
      "x-request-id",
      "request-id",
      "x-github-request-id",
      "x-github-backend",
      "x-ratelimit-remaining-requests",
      "openai-processing-ms",
    ]) {
      expect(response.headers.get(name)).toBe(new Headers(headers).get(name))
    }
    for (const name of [
      "set-cookie",
      "authorization",
      "x-private-header",
      "x-frame-options",
    ]) {
      expect(response.headers.has(name)).toBe(false)
    }
    expect(getUpstreamResponseMetadataHeaders(new Headers())).toEqual({})
  },
)

test.each([
  {
    type: "error",
    error: {
      code: "model_not_supported",
      message: "The requested model is not supported.",
    },
  },
  { type: "error", code: "invalid_request_body", message: "invalid input" },
])(
  "recognizes unsequenced Copilot errors without rewriting their wire data: %j",
  async (error) => {
    const data = JSON.stringify(error)
    const forwarded: Array<string | undefined> = []
    const result = await runResponsesStreamSession({
      source: (async function* () {
        await Promise.resolve()
        yield { event: "error", data }
      })(),
      onFrame: (frame) => {
        forwarded.push(frame.wire.data)
      },
    })
    expect(result.kind).toBe("error")
    expect(
      getResponsesStreamSessionFailure(result, "unexpected EOF"),
    ).toBeNull()
    expect(forwarded).toEqual([data])
  },
)

test.each([
  { type: "error" },
  { type: "error", message: "invalid sequence", sequence_number: "wrong" },
  { type: "error", error: { message: 7 } },
  { type: "response.output_text.delta", delta: "missing sequence" },
])(
  "does not accept malformed events as unsequenced Copilot errors: %j",
  (event) => {
    expect(parseResponsesStreamEventData(JSON.stringify(event)).kind).toBe(
      "malformed",
    )
  },
)

test("maps original detail to Copilot high without changing images or supported detail values", () => {
  const details = ["original", "high", "low", "auto", undefined, "unknown"]
  const images = details.map((detail, index) => ({
    type: "input_image",
    image_url: `https://example.invalid/${index}.png`,
    ...(detail === undefined ? {} : { detail }),
  }))
  const payload = {
    model: "gpt-6-astra",
    input: [{ role: "user", content: images }],
  } as unknown as ResponsesPayload
  expect(normalizeInputImageDetails(payload)).toBe(2)
  expect(images.map((image) => image.detail)).toEqual([
    "high",
    "high",
    "low",
    "auto",
    undefined,
    "auto",
  ])
  expect(images.map((image) => image.image_url)).toEqual(
    details.map((_, i) => `https://example.invalid/${i}.png`),
  )
  expect(
    normalizeInputImageDetails({ model: "gpt-6-astra", input: "text" }),
  ).toBe(0)
})
