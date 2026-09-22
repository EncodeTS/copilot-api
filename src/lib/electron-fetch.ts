import consola from "consola"
import { createRequire } from "node:module"

type ElectronModule = {
  net?: {
    fetch?: typeof fetch
  }
}

const require = createRequire(import.meta.url)

function authorizationHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null
  if (headers instanceof Headers) return headers.get("authorization")
  if (Array.isArray(headers)) {
    const match = headers.find(
      ([name]) => name.toLowerCase() === "authorization",
    )
    return match?.[1] ?? null
  }

  const name = Object.keys(headers).find(
    (key) => key.toLowerCase() === "authorization",
  )
  return name ? headers[name] : null
}

export function requestCarriesAuthorization(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  if (authorizationHeader(init?.headers)) return true
  return input instanceof Request && Boolean(input.headers.get("authorization"))
}

// Electron 39's utility-process net.fetch drops Authorization and GitHub
// answers 401 for an otherwise valid token. Electron 43 sends the header.
// Keep Chromium fetch for unauthenticated calls, but send credentialed calls
// through Node's fetch so the token actually leaves the process.
export function createBoundElectronFetch(
  nodeFetch: typeof fetch,
  netFetch: typeof fetch,
): typeof fetch {
  const boundFetch: typeof fetch = (input, init) => {
    const fetcher =
      requestCarriesAuthorization(input, init) ? nodeFetch : netFetch
    return fetcher(input, init)
  }
  return boundFetch
}

export function bindElectronFetch(): boolean {
  if (!process.versions.electron) return false

  try {
    const electronModule = require("electron") as ElectronModule
    const netFetch = electronModule.net?.fetch

    if (typeof netFetch !== "function") return false

    const nodeFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = createBoundElectronFetch(
      nodeFetch,
      netFetch.bind(electronModule.net),
    )
    consola.log("Successfully bound Electron's net.fetch to global fetch.")
    return true
  } catch {
    consola.log(
      "Failed to bind Electron's net.fetch. Falling back to global fetch.",
    )
    return false
  }
}
