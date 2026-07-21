import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

const REQUIRED_PROXY_ENV = "COPILOT_API_PROXY_REQUIRED"
const VALID_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"])

let proxyEnvDispatcher: Dispatcher | undefined

export class ProxyRequiredError extends Error {
  readonly code: ProxyPolicyErrorCode

  constructor(
    message = "A proxy is required for this upstream destination",
    code: ProxyPolicyErrorCode = "proxy_required",
  ) {
    super(message)
    this.name = "ProxyRequiredError"
    this.code = code
  }
}

export type ProxyPolicyErrorCode =
  | "invalid_destination"
  | "invalid_proxy_url"
  | "proxy_required"
  | "unsupported_proxy_protocol"

export interface EnvProxyDispatcherOptions {
  createDirectDispatcher?: () => Dispatcher
  createProxyDispatcher?: (proxyUrl: string, origin: string) => Dispatcher
  required?: boolean
}

export const createStrictProxyAgentOptions = (
  proxyUrl: string,
): ProxyAgent.Options => {
  const protocol = new URL(proxyUrl).protocol
  return {
    ...(protocol === "https:" ?
      { proxyTls: { rejectUnauthorized: true } }
    : {}),
    requestTls: { rejectUnauthorized: true },
    uri: proxyUrl,
  }
}

interface ProxyAwareFetchOptions {
  passProxyOption?: boolean
  required?: boolean
}

type FetchInput = Parameters<typeof fetch>[0]

export function getProxyEnvDispatcher(): Dispatcher | undefined {
  return proxyEnvDispatcher
}

export const isProxyRequired = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const value = env[REQUIRED_PROXY_ENV]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

const getNoProxyValue = (env: NodeJS.ProcessEnv): string =>
  env.no_proxy?.trim() || env.NO_PROXY?.trim() || ""

const getDefaultPort = (protocol: string): number => {
  switch (protocol) {
    case "http:":
    case "ws:":
      return 80
    case "https:":
    case "wss:":
      return 443
    default:
      return 0
  }
}

const parseNoProxyEntry = (
  entry: string,
): { hostname: string; port?: number } | null => {
  const normalized = entry.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === "*") return { hostname: "*" }

  if (normalized.startsWith("[")) {
    const closingBracket = normalized.indexOf("]")
    if (closingBracket < 0) return { hostname: normalized }
    const hostname = normalized.slice(0, closingBracket + 1)
    const portText = normalized.slice(closingBracket + 1)
    return {
      hostname,
      ...(portText.startsWith(":") && /^\d+$/u.test(portText.slice(1)) ?
        { port: Number(portText.slice(1)) }
      : {}),
    }
  }

  const match = /^(.*?):(\d+)$/u.exec(normalized)
  return match ?
      { hostname: match[1], port: Number(match[2]) }
    : { hostname: normalized }
}

export const isNoProxyDestination = (
  destination: URL,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const noProxy = getNoProxyValue(env).toLowerCase()
  if (!noProxy) return false

  const hostname = destination.hostname.toLowerCase()
  const bracketedHostname = hostname.includes(":") ? `[${hostname}]` : hostname
  const port =
    destination.port ?
      Number(destination.port)
    : getDefaultPort(destination.protocol)

  for (const rawEntry of noProxy.split(/[,\s]+/u)) {
    const entry = parseNoProxyEntry(rawEntry)
    if (!entry || (entry.port !== undefined && entry.port !== port)) continue
    if (entry.hostname === "*") return true

    const entryHostname = entry.hostname.replace(/^\*+/u, "")
    if (entryHostname.startsWith(".")) {
      if (hostname.endsWith(entryHostname)) return true
      continue
    }
    if (hostname === entryHostname || bracketedHostname === entryHostname) {
      return true
    }
  }
  return false
}

const normalizeProxyUrl = (rawProxyUrl: string): string => {
  let proxyUrl: URL
  try {
    proxyUrl = new URL(rawProxyUrl)
  } catch {
    throw new ProxyRequiredError(
      "The configured proxy URL is invalid",
      "invalid_proxy_url",
    )
  }
  if (!VALID_PROXY_PROTOCOLS.has(proxyUrl.protocol)) {
    throw new ProxyRequiredError(
      `The configured proxy protocol '${proxyUrl.protocol}' is unsupported`,
      "unsupported_proxy_protocol",
    )
  }
  return rawProxyUrl
}

export const resolveProxyUrlForUrl = (
  targetUrl: string,
  options: { required?: boolean } = {},
): string | undefined => {
  let destination: URL
  try {
    destination = new URL(targetUrl)
  } catch {
    throw new ProxyRequiredError(
      "The upstream destination URL is invalid",
      "invalid_destination",
    )
  }

  const rawProxyUrl = getProxyForUrl(destination.toString()).trim()
  if (rawProxyUrl) return normalizeProxyUrl(rawProxyUrl)
  if (isNoProxyDestination(destination)) return undefined
  if (options.required ?? isProxyRequired()) throw new ProxyRequiredError()
  return undefined
}

const getFetchTargetUrl = (input: FetchInput): string =>
  input instanceof Request ? input.url : input.toString()

export const createProxyAwareFetch = (
  underlyingFetch: typeof fetch,
  options: ProxyAwareFetchOptions = {},
): typeof fetch =>
  (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const proxyUrl = resolveProxyUrlForUrl(getFetchTargetUrl(input), {
      required: options.required,
    })
    if (!options.passProxyOption || !proxyUrl) {
      return await underlyingFetch(input, init)
    }

    const proxyInit = { ...init, proxy: proxyUrl } as RequestInit & {
      proxy: string
    }
    return await underlyingFetch(input, proxyInit)
  }) as typeof fetch

const canonicalOrigin = (origin: string | URL | undefined): string => {
  if (origin === undefined) {
    throw new ProxyRequiredError("The upstream destination origin is missing")
  }
  try {
    return new URL(origin).origin
  } catch {
    throw new ProxyRequiredError(
      "The upstream destination origin is invalid",
      "invalid_destination",
    )
  }
}

const failDispatch = (
  handler: Dispatcher.DispatchHandler,
  error: Error,
): false => {
  if (handler.onError) {
    handler.onError(error)
    return false
  }
  throw error
}

export const createEnvProxyDispatcher = (
  options: EnvProxyDispatcherOptions = {},
): Dispatcher => {
  const direct = (options.createDirectDispatcher ?? (() => new Agent()))()
  const createProxy =
    options.createProxyDispatcher
    ?? ((proxyUrl: string) =>
      new ProxyAgent(createStrictProxyAgentOptions(proxyUrl)))
  const proxies = new Map<string, Dispatcher>()

  const dispatcher = {
    dispatch(
      dispatchOptions: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      let origin: string
      let proxyUrl: string | undefined
      try {
        origin = canonicalOrigin(dispatchOptions.origin)
        proxyUrl = resolveProxyUrlForUrl(origin, {
          required: options.required,
        })
      } catch (error) {
        return failDispatch(
          handler,
          error instanceof Error ? error : new ProxyRequiredError(),
        )
      }

      if (!proxyUrl) {
        consola.debug(`HTTP proxy bypass: ${new URL(origin).hostname}`)
        return direct.dispatch(dispatchOptions, handler)
      }

      const poolKey = `${proxyUrl}\u0000${origin}`
      let proxy = proxies.get(poolKey)
      if (!proxy) {
        proxy = createProxy(proxyUrl, origin)
        proxies.set(poolKey, proxy)
      }
      const parsedProxy = new URL(proxyUrl)
      consola.debug(
        `HTTP proxy route: ${new URL(origin).hostname} via ${parsedProxy.protocol}//${parsedProxy.host}`,
      )
      return proxy.dispatch(dispatchOptions, handler)
    },
    async close(): Promise<void> {
      await Promise.all(
        [direct, ...proxies.values()].map((agent) => agent.close()),
      )
      proxies.clear()
    },
    async destroy(error?: Error | null): Promise<void> {
      await Promise.all(
        [direct, ...proxies.values()].map((agent) =>
          error === undefined ? agent.destroy() : agent.destroy(error),
        ),
      )
      proxies.clear()
    },
  }

  return dispatcher as unknown as Dispatcher
}

export function initProxyFromEnv(options: { required?: boolean } = {}): void {
  const required = options.required ?? isProxyRequired()
  try {
    proxyEnvDispatcher = createEnvProxyDispatcher({ required })

    if (typeof Bun !== "undefined") {
      globalThis.fetch = createProxyAwareFetch(globalThis.fetch, {
        passProxyOption: true,
        required,
      })
      consola.debug(
        `WebSocket proxy configured from environment${required ? " (required)" : ""}`,
      )
      return
    }

    if (required) {
      globalThis.fetch = createProxyAwareFetch(globalThis.fetch, { required })
    }
    setGlobalDispatcher(proxyEnvDispatcher)
    consola.debug(
      `HTTP proxy configured from environment${required ? " (required)" : ""}`,
    )
  } catch (error) {
    proxyEnvDispatcher = undefined
    if (required) throw error
    consola.debug("Proxy setup skipped:", error)
  }
}
