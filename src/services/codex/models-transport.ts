import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

import type { CodexCredentialSnapshot } from "./credential-snapshot"

const CODEX_MODELS_URL = `${CODEX_API_BASE_URL}/codex/models`

export const resolveCodexModelsUrl = (requestUrl: string): string => {
  const upstreamUrl = new URL(CODEX_MODELS_URL)
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export const forwardCodexModels = async (
  requestUrl: string,
  requestHeaders: Headers,
  signal?: AbortSignal,
): Promise<Response> => {
  const headers = buildCodexRequestHeaders(requestHeaders)
  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  return await fetch(resolveCodexModelsUrl(requestUrl), {
    headers,
    method: "GET",
    signal,
  })
}

// Cached provider discovery must not inherit conditionals, cookies, ranges,
// beta flags, or client identities from whichever caller starts the refresh.
export const fetchCodexProviderCatalog = async (
  credentials: CodexCredentialSnapshot,
  signal?: AbortSignal,
): Promise<Response> => {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    originator: "copilot-api",
    "user-agent": "copilot-api",
  })
  return await fetch(CODEX_MODELS_URL, { headers, method: "GET", signal })
}
