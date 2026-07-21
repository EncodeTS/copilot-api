import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Dispatcher } from "undici"

import {
  createProxyAwareFetch,
  createEnvProxyDispatcher,
  createStrictProxyAgentOptions,
  getProxyEnvDispatcher,
  initProxyFromEnv,
  isNoProxyDestination,
  ProxyRequiredError,
  resolveProxyUrlForUrl,
} from "~/lib/proxy"

const proxyKeys = [
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "COPILOT_API_PROXY_REQUIRED",
] as const

const originalProxyEnv = Object.fromEntries(
  proxyKeys.map((key) => [key, process.env[key]]),
)

afterEach(() => {
  for (const key of proxyKeys) {
    const original = originalProxyEnv[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

const clearProxyEnv = (): void => {
  for (const key of proxyKeys) delete process.env[key]
}

interface RecordedDispatch {
  dispatcher: string
  options: Dispatcher.DispatchOptions
}

const createRecordingDispatcher = (
  name: string,
  records: Array<RecordedDispatch>,
  lifecycle: {
    closes?: Array<string>
    destroys?: Array<string>
  } = {},
): Dispatcher =>
  ({
    dispatch(
      options: Dispatcher.DispatchOptions,
      _handler: Dispatcher.DispatchHandler,
    ) {
      records.push({ dispatcher: name, options })
      return true
    },
    close() {
      lifecycle.closes?.push(name)
      return Promise.resolve()
    },
    destroy() {
      lifecycle.destroys?.push(name)
      return Promise.resolve()
    },
  }) as Dispatcher

const createHandler = (onError = mock((_error: Error) => {})) =>
  ({ onError }) as unknown as Dispatcher.DispatchHandler

describe("environment proxy policy", () => {
  test("requires certificate validation for proxy and destination TLS", () => {
    expect(createStrictProxyAgentOptions("socks5://127.0.0.1:1080")).toEqual({
      requestTls: { rejectUnauthorized: true },
      uri: "socks5://127.0.0.1:1080",
    })
    expect(createStrictProxyAgentOptions("https://proxy.example:8443")).toEqual(
      {
        proxyTls: { rejectUnauthorized: true },
        requestTls: { rejectUnauthorized: true },
        uri: "https://proxy.example:8443",
      },
    )
  })

  test("routes HTTP and SOCKS5 proxies while preserving TLS dispatch options", () => {
    clearProxyEnv()
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    const records: Array<RecordedDispatch> = []
    const createdProxyKeys: Array<string> = []
    const dispatcher = createEnvProxyDispatcher({
      createDirectDispatcher: () =>
        createRecordingDispatcher("direct", records),
      createProxyDispatcher: (proxyUrl, origin) => {
        createdProxyKeys.push(`${proxyUrl}|${origin}`)
        return createRecordingDispatcher(`${proxyUrl}|${origin}`, records)
      },
    })
    const options = {
      origin: "https://api.example.com",
      path: "/v1",
      method: "GET",
      requestTls: { rejectUnauthorized: true, servername: "api.example.com" },
    } as Dispatcher.DispatchOptions

    expect(dispatcher.dispatch(options, createHandler())).toBe(true)
    expect(records[0]?.options).toBe(options)
    expect(createdProxyKeys).toEqual([
      "http://proxy.example:8080|https://api.example.com",
    ])

    process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080"
    expect(
      createEnvProxyDispatcher({
        createProxyDispatcher: (proxyUrl, origin) => {
          createdProxyKeys.push(`${proxyUrl}|${origin}`)
          return createRecordingDispatcher(`${proxyUrl}|${origin}`, records)
        },
      }).dispatch(options, createHandler()),
    ).toBe(true)
    expect(createdProxyKeys.at(-1)).toBe(
      "socks5://127.0.0.1:1080|https://api.example.com",
    )
  })

  test("honors NO_PROXY even when fail-closed mode is required", () => {
    clearProxyEnv()
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    process.env.NO_PROXY = ".internal.example,localhost:8443"
    process.env.COPILOT_API_PROXY_REQUIRED = "1"

    expect(resolveProxyUrlForUrl("https://api.internal.example/v1")).toBe(
      undefined,
    )
    expect(resolveProxyUrlForUrl("https://localhost:8443/v1")).toBe(undefined)
  })

  test("matches NO_PROXY ports, wildcards, suffixes, and IPv6 exactly", () => {
    const env = {
      NO_PROXY: "*,ignored.example",
    }
    expect(isNoProxyDestination(new URL("http://any.example"), env)).toBe(true)

    env.NO_PROXY = "localhost:8443,.internal.example,[::1]:9443"
    expect(isNoProxyDestination(new URL("https://localhost:8443"), env)).toBe(
      true,
    )
    expect(isNoProxyDestination(new URL("https://localhost:443"), env)).toBe(
      false,
    )
    expect(
      isNoProxyDestination(new URL("https://api.internal.example"), env),
    ).toBe(true)
    expect(isNoProxyDestination(new URL("https://[::1]:9443"), env)).toBe(true)
    expect(
      isNoProxyDestination(new URL("ws://localhost"), { NO_PROXY: "x" }),
    ).toBe(false)
  })

  test("rejects invalid destinations and unsupported configured proxies", () => {
    clearProxyEnv()
    expect(() => resolveProxyUrlForUrl("not a URL")).toThrow(
      "destination URL is invalid",
    )

    process.env.HTTPS_PROXY = "%"
    expect(() => resolveProxyUrlForUrl("https://api.example.com")).toThrow(
      "proxy URL is invalid",
    )

    process.env.HTTPS_PROXY = "ftp://proxy.example"
    expect(() => resolveProxyUrlForUrl("https://api.example.com")).toThrow(
      "proxy protocol 'ftp:' is unsupported",
    )

    process.env.HTTPS_PROXY = "socks4://127.0.0.1:1080"
    let socks4Error: unknown
    try {
      resolveProxyUrlForUrl("https://api.example.com")
    } catch (error) {
      socks4Error = error
    }
    expect(socks4Error).toMatchObject({
      code: "unsupported_proxy_protocol",
      name: "ProxyRequiredError",
    })
  })

  test("fails closed instead of silently dispatching direct when proxy is required", () => {
    clearProxyEnv()
    process.env.COPILOT_API_PROXY_REQUIRED = "1"
    const directDispatch = mock(() => true)
    const onError = mock((_error: Error) => {})
    const dispatcher = createEnvProxyDispatcher({
      createDirectDispatcher: () =>
        ({ dispatch: directDispatch }) as unknown as Dispatcher,
    })

    expect(
      dispatcher.dispatch(
        {
          method: "GET",
          origin: "https://api.example.com",
          path: "/v1",
        },
        createHandler(onError),
      ),
    ).toBe(false)
    expect(directDispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(ProxyRequiredError)
  })

  test("isolates proxy pools by proxy URL and upstream origin", () => {
    clearProxyEnv()
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    const created: Array<string> = []
    const dispatcher = createEnvProxyDispatcher({
      createProxyDispatcher: (proxyUrl, origin) => {
        created.push(`${proxyUrl}|${origin}`)
        return createRecordingDispatcher(`${proxyUrl}|${origin}`, [])
      },
    })
    const handler = createHandler()

    for (const origin of [
      "https://one.example",
      "https://two.example",
      "https://one.example",
    ]) {
      dispatcher.dispatch({ method: "GET", origin, path: "/" }, handler)
    }

    expect(created).toEqual([
      "http://proxy.example:8080|https://one.example",
      "http://proxy.example:8080|https://two.example",
    ])
  })

  test("uses direct dispatch only when permitted and closes every isolated pool", async () => {
    clearProxyEnv()
    const records: Array<RecordedDispatch> = []
    const closes: Array<string> = []
    const destroys: Array<string> = []
    const dispatcher = createEnvProxyDispatcher({
      createDirectDispatcher: () =>
        createRecordingDispatcher("direct", records, { closes, destroys }),
      createProxyDispatcher: (proxyUrl, origin) =>
        createRecordingDispatcher(`${proxyUrl}|${origin}`, records, {
          closes,
          destroys,
        }),
    })
    const handler = createHandler()

    expect(
      dispatcher.dispatch(
        { method: "GET", origin: "https://direct.example", path: "/" },
        handler,
      ),
    ).toBe(true)
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    dispatcher.dispatch(
      { method: "GET", origin: "https://proxied.example", path: "/" },
      handler,
    )
    expect(records.map(({ dispatcher: name }) => name)).toEqual([
      "direct",
      "http://proxy.example:8080|https://proxied.example",
    ])

    await dispatcher.close()
    expect(closes.sort()).toEqual([
      "direct",
      "http://proxy.example:8080|https://proxied.example",
    ])
    await dispatcher.destroy(new Error("shutdown"))
    expect(destroys).toEqual(["direct"])
  })

  test("rejects missing or invalid dispatcher origins through the handler", () => {
    clearProxyEnv()
    const onError = mock((_error: Error) => {})
    const dispatcher = createEnvProxyDispatcher()

    expect(
      dispatcher.dispatch({ method: "GET", path: "/" }, createHandler(onError)),
    ).toBe(false)
    expect(
      dispatcher.dispatch(
        { method: "GET", origin: "not an origin", path: "/" },
        createHandler(onError),
      ),
    ).toBe(false)
    expect(onError).toHaveBeenCalledTimes(2)

    expect(() =>
      dispatcher.dispatch(
        { method: "GET", path: "/" },
        {} as Dispatcher.DispatchHandler,
      ),
    ).toThrow(ProxyRequiredError)
  })

  test("guards Bun HTTP fetches with the same required proxy policy", async () => {
    clearProxyEnv()
    process.env.COPILOT_API_PROXY_REQUIRED = "1"
    const underlyingFetch = mock(
      (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        Promise.resolve(new Response("ok")),
    )
    const guardedFetch = createProxyAwareFetch(
      underlyingFetch as unknown as typeof fetch,
      { passProxyOption: true },
    )

    let requiredProxyError: unknown
    try {
      await guardedFetch("https://api.example.com/v1")
    } catch (error) {
      requiredProxyError = error
    }
    expect(requiredProxyError).toBeInstanceOf(ProxyRequiredError)
    expect(underlyingFetch).not.toHaveBeenCalled()

    process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080"
    expect(await guardedFetch("https://api.example.com/v1")).toBeInstanceOf(
      Response,
    )
    expect(underlyingFetch).toHaveBeenCalledTimes(1)
    expect(underlyingFetch.mock.calls[0]?.[1]).toMatchObject({
      proxy: "socks5://127.0.0.1:1080",
    })

    process.env.NO_PROXY = "direct.example"
    const request = new Request("https://direct.example/v1")
    await guardedFetch(request)
    expect(underlyingFetch.mock.calls[1]?.[0]).toBe(request)
    expect(underlyingFetch.mock.calls[1]?.[1]).toBeUndefined()
  })

  test("initializes the Bun global fetch policy and dispatcher", async () => {
    clearProxyEnv()
    process.env.HTTPS_PROXY = "http://proxy.example:8080"
    const originalFetch = globalThis.fetch
    const underlyingFetch = mock(
      (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        Promise.resolve(new Response("ok")),
    )
    globalThis.fetch = underlyingFetch as unknown as typeof fetch

    try {
      initProxyFromEnv({ required: true })
      expect(getProxyEnvDispatcher()).toBeDefined()
      await globalThis.fetch("https://api.example.com/v1")
      expect(underlyingFetch.mock.calls[0]?.[1]).toMatchObject({
        proxy: "http://proxy.example:8080",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
