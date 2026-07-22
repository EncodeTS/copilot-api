import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Dispatcher } from "undici"

import type { ResolvedProviderConfig } from "../src/lib/config"
import { state } from "../src/lib/state"
import {
  createProviderImagesDispatcher,
  createProviderImagesPort,
  PROVIDER_IMAGES_TIMEOUT_MS,
} from "../src/services/providers/provider-images-port"

const genericProvider: ResolvedProviderConfig = {
  apiKey: "provider-secret",
  authType: "authorization",
  baseUrl: "https://images.example/api",
  name: "openai",
  type: "openai-compatible",
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("provider images port", () => {
  test("forwards exact generation JSON bytes and preserves safe upstream metadata", async () => {
    const exactRequestBody =
      '{\n  "prompt": "keep whitespace",\n  "seed": 9007199254740993\n}\n'
    const exactResponseBody =
      '{"created":1784000000,"data":[],"seed":9007199254740993}\n'
    let forwardedUrl = ""
    let forwardedBody = ""
    let forwardedHeaders = new Headers()
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        forwardedUrl = requestUrl(input)
        forwardedHeaders = new Headers(init?.headers)
        forwardedBody = await new Response(init?.body).text()
        return new Response(exactResponseBody, {
          headers: {
            connection: "close",
            "content-type": "application/json; profile=exact",
            "set-cookie": "upstream_session=private",
            "x-request-id": "image-request-1",
          },
          status: 201,
          statusText: "Generated Exactly",
        })
      },
    )
    const port = createProviderImagesPort(genericProvider, { fetcher })
    const request = new Request(
      "http://localhost/openai/v1/images/generations?quality=hd&n=1",
      {
        body: exactRequestBody,
        headers: {
          accept: "application/json; profile=client",
          authorization: "Bearer client-secret",
          "content-type": "application/json; charset=utf-8",
          cookie: "client_session=private",
          "user-agent": "images-client/1.0",
          "x-api-key": "client-api-key",
        },
        method: "POST",
      },
    )

    const dispatched = await port.dispatch({
      operation: "generations",
      request,
    })

    expect(dispatched.adapter).toBe("http")
    expect(forwardedUrl).toBe(
      "https://images.example/api/v1/images/generations?quality=hd&n=1",
    )
    expect(forwardedBody).toBe(exactRequestBody)
    expect(forwardedHeaders.get("authorization")).toBe("Bearer provider-secret")
    expect(forwardedHeaders.get("content-type")).toBe(
      "application/json; charset=utf-8",
    )
    expect(forwardedHeaders.get("accept")).toBe(
      "application/json; profile=client",
    )
    expect(forwardedHeaders.get("user-agent")).toBe("images-client/1.0")
    expect(forwardedHeaders.get("cookie")).toBeNull()
    expect(forwardedHeaders.get("x-api-key")).toBeNull()

    expect(dispatched.response.status).toBe(201)
    expect(dispatched.response.statusText).toBe("Generated Exactly")
    expect(dispatched.response.headers.get("content-type")).toBe(
      "application/json; profile=exact",
    )
    expect(dispatched.response.headers.get("x-request-id")).toBe(
      "image-request-1",
    )
    expect(dispatched.response.headers.get("set-cookie")).toBeNull()
    expect(dispatched.response.headers.get("connection")).toBeNull()
    expect(await dispatched.response.text()).toBe(exactResponseBody)
  })

  test("streams exact multipart edit bytes with their original boundary", async () => {
    const boundary = "----copilot-api-exact-boundary"
    const prefix = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="prompt"',
        "",
        "preserve this body",
        `--${boundary}`,
        'Content-Disposition: form-data; name="image"; filename="pixel.bin"',
        "Content-Type: application/octet-stream",
        "",
        "",
      ].join("\r\n"),
    )
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
    const fileBytes = new Uint8Array([0, 255, 13, 10, 127])
    const multipartBytes = new Uint8Array(
      prefix.byteLength + fileBytes.byteLength + suffix.byteLength,
    )
    multipartBytes.set(prefix)
    multipartBytes.set(fileBytes, prefix.byteLength)
    multipartBytes.set(suffix, prefix.byteLength + fileBytes.byteLength)

    let forwardedBytes = new Uint8Array()
    let forwardedHeaders = new Headers()
    let forwardedUrl = ""
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        forwardedUrl = requestUrl(input)
        forwardedHeaders = new Headers(init?.headers)
        forwardedBytes = new Uint8Array(
          await new Response(init?.body).arrayBuffer(),
        )
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        })
      },
    )
    const port = createProviderImagesPort(
      {
        ...genericProvider,
        apiKey: "x-provider-secret",
        authType: "x-api-key",
      },
      { fetcher },
    )
    const contentType = `multipart/form-data; boundary=${boundary}`
    const request = new Request(
      "http://localhost/openai/v1/images/edits?mask=keep%2Foriginal",
      {
        body: multipartBytes,
        headers: {
          authorization: "Bearer client-secret",
          "content-type": contentType,
        },
        method: "POST",
      },
    )

    const dispatched = await port.dispatch({ operation: "edits", request })

    expect(forwardedUrl).toBe(
      "https://images.example/api/v1/images/edits?mask=keep%2Foriginal",
    )
    expect(forwardedHeaders.get("content-type")).toBe(contentType)
    expect(forwardedHeaders.get("x-api-key")).toBe("x-provider-secret")
    expect(forwardedHeaders.get("authorization")).toBeNull()
    expect(forwardedBytes).toEqual(multipartBytes)
    expect(new Uint8Array(await dispatched.response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  test("does not duplicate a configured generic v1 base path", async () => {
    let forwardedUrl = ""
    const port = createProviderImagesPort(
      { ...genericProvider, baseUrl: "https://images.example/api/v1/" },
      {
        fetcher: (input) => {
          forwardedUrl = requestUrl(input)
          return Promise.resolve(Response.json({ data: [] }))
        },
      },
    )

    await port.dispatch({
      operation: "generations",
      request: postBytes(
        "http://localhost/openai/v1/images/generations?format=png",
      ),
    })

    expect(forwardedUrl).toBe(
      "https://images.example/api/v1/images/generations?format=png",
    )
  })

  test("uses the Codex adapter URL and account-bound credentials", async () => {
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    const exactBody = '{ "prompt": "codex wire bytes" }\n'
    let forwardedUrl = ""
    let forwardedBody = ""
    let forwardedHeaders = new Headers()
    const fetcher = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        forwardedUrl = requestUrl(input)
        forwardedHeaders = new Headers(init?.headers)
        forwardedBody = await new Response(init?.body).text()
        return Response.json({ data: [] })
      },
    )
    const port = createProviderImagesPort(
      {
        apiKey: "stale-config-token",
        authType: "oauth2",
        baseUrl: "https://codex.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      { fetcher },
    )
    const request = new Request(
      "http://localhost/codex/v1/images/generations?output=base64",
      {
        body: exactBody,
        headers: {
          authorization: "Bearer client-secret",
          "content-type": "application/json",
          cookie: "codex_session=kept",
          originator: "codex-tui",
          "user-agent": "codex-tui/test",
          "x-api-key": "client-key",
          "x-client-header": "kept",
        },
        method: "POST",
      },
    )

    const dispatched = await port.dispatch({
      operation: "generations",
      request,
    })

    expect(dispatched.adapter).toBe("codex")
    expect(forwardedUrl).toBe(
      "https://codex.example/backend-api/codex/images/generations?output=base64",
    )
    expect(forwardedBody).toBe(exactBody)
    expect(forwardedHeaders.get("authorization")).toBe(
      "Bearer codex-access-token",
    )
    expect(forwardedHeaders.get("chatgpt-account-id")).toBe("account-123")
    expect(forwardedHeaders.get("x-api-key")).toBeNull()
    expect(forwardedHeaders.get("cookie")).toBe("codex_session=kept")
    expect(forwardedHeaders.get("originator")).toBe("codex-tui")
    expect(forwardedHeaders.get("user-agent")).toBe("codex-tui/test")
    expect(forwardedHeaders.get("x-client-header")).toBe("kept")
  })

  test("defaults generation JSON headers without mislabeling edit bytes", async () => {
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    const capturedHeaders: Headers[] = []
    const fetcher = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders.push(new Headers(init?.headers))
        await new Response(init?.body).arrayBuffer()
        return Response.json({ data: [] })
      },
    )
    const codexPort = createProviderImagesPort(
      {
        apiKey: "unused",
        authType: "oauth2",
        baseUrl: "https://codex.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      { fetcher },
    )
    const genericPort = createProviderImagesPort(genericProvider, { fetcher })

    await codexPort.dispatch({
      operation: "generations",
      request: postBytes("http://localhost/codex/v1/images/generations"),
    })
    await codexPort.dispatch({
      operation: "edits",
      request: postBytes("http://localhost/codex/v1/images/edits"),
    })
    await genericPort.dispatch({
      operation: "generations",
      request: postBytes("http://localhost/openai/v1/images/generations"),
    })
    await genericPort.dispatch({
      operation: "edits",
      request: postBytes("http://localhost/openai/v1/images/edits"),
    })

    expect(capturedHeaders).toHaveLength(4)
    for (const headers of capturedHeaders) {
      expect(headers.get("accept")).toBe("application/json")
    }
    expect(capturedHeaders[0]?.get("content-type")).toBe("application/json")
    expect(capturedHeaders[1]?.get("content-type")).toBeNull()
    expect(capturedHeaders[2]?.get("content-type")).toBe("application/json")
    expect(capturedHeaders[3]?.get("content-type")).toBeNull()
  })

  test("uses an endpoint-specific bounded fifteen-minute deadline", async () => {
    let requestedTimeoutMs: number | undefined
    const deadlineController = new AbortController()
    const port = createProviderImagesPort(genericProvider, {
      createTimeoutSignal: (timeoutMs) => {
        requestedTimeoutMs = timeoutMs
        return deadlineController.signal
      },
      fetcher: () => Promise.resolve(Response.json({ data: [] })),
    })

    await port.dispatch({
      operation: "generations",
      request: postBytes("http://localhost/openai/v1/images/generations"),
    })

    expect(PROVIDER_IMAGES_TIMEOUT_MS).toBe(15 * 60 * 1000)
    expect(requestedTimeoutMs).toBe(PROVIDER_IMAGES_TIMEOUT_MS)
  })

  test("propagates the fake deadline through response-body streaming", async () => {
    const deadlineController = new AbortController()
    const observed: { signal?: AbortSignal } = {}
    const port = createProviderImagesPort(genericProvider, {
      createTimeoutSignal: () => deadlineController.signal,
      fetcher: (_input, init) => {
        observed.signal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(toError(init.signal?.reason)),
                  { once: true },
                )
              },
            }),
          ),
        )
      },
    })
    const dispatched = await port.dispatch({
      operation: "generations",
      request: postBytes("http://localhost/openai/v1/images/generations"),
    })
    const reader = dispatched.response.body?.getReader()
    if (!reader) throw new Error("Expected a response body")
    const pendingRead = reader.read()

    deadlineController.abort(new Error("fake image deadline expired"))

    expect(observed.signal?.aborted).toBe(true)
    expect(await rejectionMessage(pendingRead)).toBe(
      "fake image deadline expired",
    )
  })

  test("propagates caller abort while waiting for image response headers", async () => {
    const callerController = new AbortController()
    const observed: { signal?: AbortSignal } = {}
    const port = createProviderImagesPort(genericProvider, {
      createTimeoutSignal: () => new AbortController().signal,
      fetcher: (_input, init) => {
        observed.signal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(toError(init.signal?.reason)),
            { once: true },
          )
        })
      },
    })
    const dispatch = port.dispatch({
      operation: "generations",
      request: new Request("http://localhost/openai/v1/images/generations", {
        body: "{}",
        method: "POST",
        signal: callerController.signal,
      }),
    })

    callerController.abort(new Error("caller disconnected"))

    expect(observed.signal?.aborted).toBe(true)
    expect(await rejectionMessage(dispatch)).toBe("caller disconnected")
  })

  test("extends Node and Undici header and body timeouts to the image deadline", () => {
    let forwardedOptions: Dispatcher.DispatchOptions | undefined
    const upstream = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        _handler: Dispatcher.DispatchHandler,
      ) {
        forwardedOptions = options
        return true
      },
    } as Dispatcher
    const dispatcher = createProviderImagesDispatcher(upstream)

    dispatcher.dispatch(
      {
        method: "POST",
        origin: new URL("https://images.example"),
        path: "/v1/images/generations",
      },
      {} as Dispatcher.DispatchHandler,
    )

    expect(forwardedOptions?.headersTimeout).toBe(PROVIDER_IMAGES_TIMEOUT_MS)
    expect(forwardedOptions?.bodyTimeout).toBe(PROVIDER_IMAGES_TIMEOUT_MS)
  })

  test("uses the runtime fetch adapter when no test transport is injected", async () => {
    const fetchMock = mock(() => Promise.resolve(Response.json({ data: [] })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const port = createProviderImagesPort(genericProvider, {
      createTimeoutSignal: () => new AbortController().signal,
    })

    const dispatched = await port.dispatch({
      operation: "generations",
      request: postBytes("http://localhost/openai/v1/images/generations"),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(dispatched.response.status).toBe(200)
  })
})

const postBytes = (url: string): Request =>
  new Request(url, {
    body: new Uint8Array([1, 2, 3]),
    method: "POST",
  })

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof Error ? error.message : "unknown error",
  )

const requestUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString()

const toError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error("request aborted")
