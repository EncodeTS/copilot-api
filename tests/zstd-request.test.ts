import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  createRequestBodyErrorResponse,
  createRequestBodyMiddleware,
  DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES,
  zstdDecompressionMiddleware,
} from "../src/lib/zstd-request"
import { ZstdDecoderUnavailableError } from "../src/lib/zstd-adapter"
import { server } from "../src/server"

const createApp = (maxBodyBytes?: number) => {
  const app = new Hono()

  app.use(
    maxBodyBytes === undefined ?
      zstdDecompressionMiddleware
    : createRequestBodyMiddleware({
        maxDecodedBytes: maxBodyBytes,
        maxEncodedBytes: maxBodyBytes,
      }),
  )
  app.onError(
    (error, c) =>
      createRequestBodyErrorResponse(c, error)
      ?? c.json({ error: { message: error.message } }, 500),
  )
  app.post("/echo", async (c) =>
    c.json({
      contentEncoding: c.req.header("content-encoding") ?? null,
      contentLength: c.req.raw.headers.get("content-length"),
      payload: await c.req.json(),
    }),
  )

  return app
}

type StreamingRequestInit = RequestInit & { duplex: "half" }

const createStreamingRequest = (
  chunks: string[],
  headers: Headers | Record<string, string>,
  onCancel?: (reason: unknown) => void,
  signal?: AbortSignal,
): Request => {
  const encoder = new TextEncoder()
  let chunkIndex = 0

  const body = new ReadableStream<Uint8Array>(
    {
      cancel(reason) {
        onCancel?.(reason)
      },
      pull(controller) {
        const chunk = chunks[chunkIndex]
        chunkIndex += 1
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunk))
      },
    },
    { highWaterMark: 0 },
  )

  return new Request("http://localhost/echo", {
    body,
    duplex: "half",
    headers,
    method: "POST",
    signal,
  } as StreamingRequestInit)
}

describe("zstd request middleware", () => {
  test("enforces the 64 MiB default at the public server seam", async () => {
    const response = await server.request("/v1/responses", {
      body: "{}",
      headers: {
        "content-length": String(DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES + 1),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "encoded",
      },
    })
  })

  test("rejects an invalid Content-Length before reading the request body", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: JSON.stringify({ ok: true }),
      headers: {
        "content-length": "12.5",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_content_length",
        message: "Invalid Content-Length header.",
        type: "invalid_request_error",
      },
    })
  })

  test("fast-rejects a huge declared Content-Length without numeric overflow", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: JSON.stringify({ ok: true }),
      headers: {
        "content-length": "1".repeat(400),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "encoded",
      },
    })
  })

  test("rejects unsupported content encodings", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: JSON.stringify({ ok: true }),
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_content_encoding",
        message: "Unsupported Content-Encoding header.",
        type: "invalid_request_error",
      },
    })
  })

  test("fast-rejects a declared body larger than the encoded limit", async () => {
    const app = createApp(16)

    const response = await app.request("/echo", {
      body: "{}",
      headers: {
        "content-length": "17",
        "content-type": "application/json",
      },
      method: "POST",
    })

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

  test("rejects a chunked identity body at cap plus one and cancels its source", async () => {
    const app = createApp(16)
    let cancelReason: unknown
    const request = createStreamingRequest(
      ['{"value":', '"12345"}', "must-not-be-read"],
      { "content-type": "application/json" },
      (reason) => {
        cancelReason = reason
      },
    )

    const response = await app.fetch(request)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: {
        code: "local_request_body_too_large",
        message: "Encoded request body exceeds the local safety limit.",
        stage: "encoded",
        type: "payload_too_large",
      },
    })
    expect(cancelReason).toBeInstanceOf(Error)
  })

  test("accepts an identity JSON body at the exact encoded cap", async () => {
    const app = createApp(16)
    const body = '{"value":"1234"}'

    const response = await app.fetch(
      createStreamingRequest([body.slice(0, 7), body.slice(7)], {
        "content-length": "16",
        "content-type": "application/json",
      }),
    )

    expect(new TextEncoder().encode(body).byteLength).toBe(16)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      payload: { value: "1234" },
    })
  })

  // These Request-stream cases exercise the middleware contract directly.
  // Real HTTP parsers may reject or truncate a mismatched Content-Length
  // before Hono receives a Request, which is also a safe transport outcome.

  test("rejects an identity body larger than its declared Content-Length", async () => {
    const app = createApp(32)
    const body = '{"value":"1234"}'

    const response = await app.fetch(
      createStreamingRequest([body], {
        "content-length": "15",
        "content-type": "application/json",
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_content_length",
        message: "Content-Length does not match the encoded request body.",
        type: "invalid_request_error",
      },
    })
  })

  test("rejects an identity body smaller than its declared Content-Length", async () => {
    const app = createApp(32)
    const body = '{"value":"1234"}'

    const response = await app.fetch(
      createStreamingRequest([body], {
        "content-length": "17",
        "content-type": "application/json",
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("rejects a missing identity body with a nonzero Content-Length", async () => {
    const app = createApp(32)

    const response = await app.request("/echo", {
      headers: {
        "content-length": "1",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("reports a declared-length mismatch before the encoded safety cap", async () => {
    const app = createApp(16)
    const body = '{"value":"12345"}'

    const response = await app.fetch(
      createStreamingRequest([body], {
        "content-length": "16",
        "content-type": "application/json",
      }),
    )

    expect(new TextEncoder().encode(body).byteLength).toBe(17)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("counts multipart bytes while the route streams the form body", async () => {
    const boundary = "copilot-boundary"
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="prompt"\r\n\r\n',
      "hello\r\n",
      `--${boundary}--\r\n`,
    ].join("")
    const bodyBytes = new TextEncoder().encode(body).byteLength
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: bodyBytes - 1,
        maxEncodedBytes: bodyBytes - 1,
      }),
    )
    app.onError(
      (error, c) =>
        createRequestBodyErrorResponse(c, error)
        ?? c.json({ error: { message: error.message } }, 500),
    )
    app.post("/echo", async (c) => {
      const form = await c.req.formData()
      return c.json({ prompt: form.get("prompt") })
    })
    let cancelReason: unknown
    const request = createStreamingRequest(
      [body.slice(0, -1), body.slice(-1)],
      {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      (reason) => {
        cancelReason = reason
      },
    )

    const response = await app.fetch(request)

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "encoded",
      },
    })
    expect(cancelReason).toBeInstanceOf(Error)
  })

  test("rejects multipart input larger than its declared Content-Length", async () => {
    const boundary = "copilot-boundary"
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="prompt"\r\n\r\n',
      "hello\r\n",
      `--${boundary}--\r\n`,
    ].join("")
    const bodyBytes = new TextEncoder().encode(body).byteLength
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: bodyBytes + 16,
        maxEncodedBytes: bodyBytes + 16,
      }),
    )
    app.onError(
      (error, c) =>
        createRequestBodyErrorResponse(c, error)
        ?? c.json({ error: { message: error.message } }, 500),
    )
    app.post("/echo", async (c) => {
      await c.req.formData()
      return c.json({ ok: true })
    })

    const response = await app.fetch(
      createStreamingRequest([body], {
        "content-length": String(bodyBytes - 1),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("rejects multipart input smaller than its declared Content-Length", async () => {
    const boundary = "copilot-boundary"
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="prompt"\r\n\r\n',
      "hello\r\n",
      `--${boundary}--\r\n`,
    ].join("")
    const bodyBytes = new TextEncoder().encode(body).byteLength
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: bodyBytes + 16,
        maxEncodedBytes: bodyBytes + 16,
      }),
    )
    app.onError(
      (error, c) =>
        createRequestBodyErrorResponse(c, error)
        ?? c.json({ error: { message: error.message } }, 500),
    )
    app.post("/echo", async (c) => {
      await c.req.formData()
      return c.json({ ok: true })
    })

    const response = await app.fetch(
      createStreamingRequest([body], {
        "content-length": String(bodyBytes + 1),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("accepts multipart input at the exact encoded cap", async () => {
    const boundary = "copilot-boundary"
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="prompt"\r\n\r\n',
      "hello\r\n",
      `--${boundary}--\r\n`,
    ].join("")
    const bodyBytes = new TextEncoder().encode(body).byteLength
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: bodyBytes,
        maxEncodedBytes: bodyBytes,
      }),
    )
    app.post("/echo", async (c) => {
      const form = await c.req.formData()
      return c.json({ prompt: form.get("prompt") })
    })

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-length": String(bodyBytes),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ prompt: "hello" })
  })

  test("propagates multipart consumer cancellation without prebuffering", async () => {
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 1_024,
        maxEncodedBytes: 1_024,
      }),
    )
    app.post("/echo", async (c) => {
      const reader = c.req.raw.body?.getReader()
      await reader?.read()
      await reader?.cancel("route-finished")
      return c.json({ ok: true })
    })
    let cancelReason: unknown
    const request = createStreamingRequest(
      ["first", "must-not-be-read"],
      { "content-type": "multipart/form-data; boundary=test" },
      (reason) => {
        cancelReason = reason
      },
    )

    const response = await app.fetch(request)

    expect(response.status).toBe(200)
    expect(cancelReason).toBe("route-finished")
  })

  test("propagates caller abort while streaming multipart input", async () => {
    const app = new Hono()
    app.use(createRequestBodyMiddleware())
    app.onError((error, c) => c.json({ error: { name: error.name } }, 408))
    app.post("/echo", async (c) => c.json({ body: await c.req.raw.text() }))

    const abortController = new AbortController()
    let markPullStarted: (() => void) | undefined
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve
    })
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>(
      {
        cancel(reason) {
          cancelReason = reason
        },
        pull() {
          markPullStarted?.()
        },
      },
      { highWaterMark: 0 },
    )
    const request = new Request("http://localhost/echo", {
      body,
      duplex: "half",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
      },
      method: "POST",
      signal: abortController.signal,
    } as StreamingRequestInit)

    const responsePromise = app.fetch(request)
    await pullStarted
    abortController.abort()
    const response = await responsePromise

    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({
      error: { name: "AbortError" },
    })
    expect((cancelReason as Error).name).toBe("AbortError")
  })

  test("rejects zstd input whose streamed bytes exceed the encoded limit", async () => {
    const payload = { ok: true }
    const body = await Bun.zstdCompress(JSON.stringify(payload))
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 1_024,
        maxEncodedBytes: body.byteLength - 1,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "encoded",
      },
    })
  })

  test("rejects zstd input larger than its declared Content-Length", async () => {
    const payload = { ok: true }
    const body = await Bun.zstdCompress(JSON.stringify(payload))
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 1_024,
        maxEncodedBytes: 1_024,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength - 1),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("rejects zstd input smaller than its declared Content-Length", async () => {
    const payload = { ok: true }
    const body = await Bun.zstdCompress(JSON.stringify(payload))
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 1_024,
        maxEncodedBytes: 1_024,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength + 1),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_content_length" },
    })
  })

  test("decompresses zstd encoded json request bodies", async () => {
    const app = createApp()
    const payload = { model: "gpt-5", messages: [{ role: "user" }] }
    const body = await Bun.zstdCompress(JSON.stringify(payload))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      contentEncoding: null,
      contentLength: null,
      payload,
    })
  })

  test("accepts zstd input at the exact encoded and decoded caps", async () => {
    const payloadText = JSON.stringify({ value: "exact" })
    const body = await Bun.zstdCompress(payloadText)
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: new TextEncoder().encode(payloadText).byteLength,
        maxEncodedBytes: body.byteLength,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-length": String(body.byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: "exact" })
  })

  test("accepts an empty zstd frame when the decoded cap is zero", async () => {
    const body = await Bun.zstdCompress(new Uint8Array())
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 0,
        maxEncodedBytes: body.byteLength,
      }),
    )
    app.post("/echo", async (c) =>
      c.json({ byteLength: (await c.req.arrayBuffer()).byteLength }),
    )

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/octet-stream",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ byteLength: 0 })
  })

  test("rejects nonempty zstd output when the decoded cap is zero", async () => {
    const body = await Bun.zstdCompress(new Uint8Array([1]))
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 0,
        maxEncodedBytes: body.byteLength,
      }),
    )
    app.post("/echo", async (c) => c.body(await c.req.arrayBuffer()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/octet-stream",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "decoded",
      },
    })
  })

  test("rejects zstd output at the decoded cap plus one", async () => {
    const payloadText = JSON.stringify({ value: "one-over" })
    const decodedBytes = new TextEncoder().encode(payloadText).byteLength
    const body = await Bun.zstdCompress(payloadText)
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: decodedBytes - 1,
        maxEncodedBytes: body.byteLength,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "decoded",
      },
    })
  })

  test("rejects a small compressed bomb at the decoded limit", async () => {
    const payload = JSON.stringify({ value: "A".repeat(1024 * 1024) })
    const body = await Bun.zstdCompress(payload)
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware({
        maxDecodedBytes: 1_024,
        maxEncodedBytes: 64 * 1_024,
      }),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(body.byteLength).toBeLessThan(1_024)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "decoded",
      },
    })
  })

  test("rejects an oversized zstd frame window as decoded payload too large", async () => {
    const app = createApp()
    const oversizedWindowHeader = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff,
    ])

    const response = await app.request("/echo", {
      body: oversizedWindowHeader,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: {
        code: "local_request_body_too_large",
        stage: "decoded",
      },
    })
  })

  test("fails closed on zstd frames without a declared content size", async () => {
    const app = createApp()
    const unknownContentSizeFrame = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x00, 0x00,
    ])

    const response = await app.request("/echo", {
      body: unknownContentSizeFrame,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to decompress zstd request body.",
        type: "invalid_request_error",
      },
    })
  })

  test("returns 415 when the bounded zstd runtime cannot initialize", async () => {
    const body = await Bun.zstdCompress('{"ok":true}')
    const app = new Hono()
    app.use(
      createRequestBodyMiddleware(
        {
          maxDecodedBytes: 1024,
          maxEncodedBytes: 1024,
        },
        {
          decodeZstdBody: () =>
            Promise.reject(new ZstdDecoderUnavailableError()),
        },
      ),
    )
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const response = await app.request("/echo", {
      body,
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({
      error: {
        code: "unsupported_content_encoding",
        message: "Zstd request decompression is unavailable in this runtime.",
        type: "invalid_request_error",
      },
    })
  })

  test("leaves unencoded request bodies unchanged", async () => {
    const app = createApp()
    const payload = { ok: true }

    const response = await app.request("/echo", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ payload })
  })

  test("rejects invalid zstd request bodies", async () => {
    const app = createApp()

    const response = await app.request("/echo", {
      body: "not-zstd",
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Failed to decompress zstd request body.",
        type: "invalid_request_error",
      },
    })
  })

  test("does not rewrite a caller abort as malformed zstd input", async () => {
    const app = new Hono()
    app.use(createRequestBodyMiddleware())
    app.onError((error, c) => c.json({ error: { name: error.name } }, 408))
    app.post("/echo", async (c) => c.json(await c.req.json()))

    const abortController = new AbortController()
    let markPullStarted: (() => void) | undefined
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve
    })
    let cancelReason: unknown
    const body = new ReadableStream<Uint8Array>(
      {
        cancel(reason) {
          cancelReason = reason
        },
        pull() {
          markPullStarted?.()
        },
      },
      { highWaterMark: 0 },
    )
    const request = new Request("http://localhost/echo", {
      body,
      duplex: "half",
      headers: {
        "content-encoding": "zstd",
        "content-type": "application/json",
      },
      method: "POST",
      signal: abortController.signal,
    } as StreamingRequestInit)

    const responsePromise = app.fetch(request)
    await pullStarted
    abortController.abort()
    const response = await responsePromise

    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({
      error: { name: "AbortError" },
    })
    expect((cancelReason as Error).name).toBe("AbortError")
  })
})
