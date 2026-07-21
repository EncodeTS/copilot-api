import type { MiddlewareHandler } from "hono"
import { createHash } from "node:crypto"
import { isIP } from "node:net"

const LOOPBACK_LISTENER_HOST = "127.0.0.1"
const LAN_LISTENER_HOST = "0.0.0.0"

const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
const DEFAULT_CORS_HEADERS = "Authorization, Content-Type, X-Api-Key"
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export interface ServerNetworkOptions {
  displayHost: string
  listenerHost: string
}

export function resolveServerNetworkOptions(options: {
  apiKeys: Array<string>
  lan: boolean
}): ServerNetworkOptions {
  const hasNormalApiKey = options.apiKeys.some((apiKey) => apiKey.trim())
  if (options.lan && !hasNormalApiKey) {
    throw new Error(
      "LAN mode requires at least one auth.apiKeys entry in config.json.",
    )
  }

  return {
    displayHost: LOOPBACK_LISTENER_HOST,
    listenerHost: options.lan ? LAN_LISTENER_HOST : LOOPBACK_LISTENER_HOST,
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "")
}

export function isAllowedHost(host: string): boolean {
  try {
    const { hostname } = new URL(`http://${host}`)
    const normalizedHostname = stripIpv6Brackets(hostname).toLowerCase()
    return normalizedHostname === "localhost" || isIP(normalizedHostname) !== 0
  } catch {
    return false
  }
}

function isSameOrigin(requestUrl: string, origin: string): boolean {
  try {
    return new URL(requestUrl).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function getCorsAllowedHeaders(requestHeaders: string | undefined): string {
  if (!requestHeaders) return DEFAULT_CORS_HEADERS

  const headerNames = requestHeaders.split(",").map((value) => value.trim())
  return (
      headerNames.length > 0
        && headerNames.every((headerName) =>
          HEADER_NAME_PATTERN.test(headerName),
        )
    ) ?
      headerNames.join(", ")
    : DEFAULT_CORS_HEADERS
}

function isSensitivePath(path: string): boolean {
  return (
    path === "/usage"
    || path.startsWith("/usage/")
    || path === "/usage-viewer"
    || path === "/usage-viewer/"
    || path === "/token-usage"
    || path.startsWith("/token-usage/")
    || path === "/admin"
    || path.startsWith("/admin/")
  )
}

export function createNetworkSecurityMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host
    if (!isAllowedHost(host)) {
      return c.json(
        {
          error: {
            message: "Unrecognized Host header.",
            type: "invalid_request_error",
          },
        },
        421,
      )
    }

    const origin = c.req.header("origin")
    if (origin && !isSameOrigin(c.req.url, origin)) {
      return c.json(
        {
          error: {
            message: "Cross-origin requests are not allowed.",
            type: "invalid_request_error",
          },
        },
        403,
      )
    }

    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Access-Control-Allow-Methods", CORS_METHODS)
      c.header(
        "Access-Control-Allow-Headers",
        getCorsAllowedHeaders(c.req.header("access-control-request-headers")),
      )
      c.header("Vary", "Origin")
    }

    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Frame-Options", "DENY")
    if (isSensitivePath(c.req.path)) {
      c.header("Cache-Control", "private, no-store")
    }

    if (origin && c.req.method === "OPTIONS") {
      return c.body(null, 204)
    }

    await next()
  }
}

export function createUsageViewerContentSecurityPolicy(html: string): string {
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (!scriptMatch) {
    throw new Error("Usage Viewer must contain exactly one inline script.")
  }

  const digest = createHash("sha256").update(scriptMatch[1]).digest("base64")

  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    `script-src 'sha256-${digest}'`,
    "style-src 'self' 'unsafe-inline'",
  ].join("; ")
}
