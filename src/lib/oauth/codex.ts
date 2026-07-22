import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

import {
  AuthProtocolError,
  AuthTransportError,
  createAuthRequestError,
  fetchAuthJson,
  readOAuthErrorCode,
  requireAuthObject,
  type AuthRequestOptions,
} from "~/lib/auth-request"

export { CODEX_API_BASE_URL } from "~/services/codex/create-responses"

const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPE = "openid profile email offline_access"
const JWT_CLAIM_PATH = "https://api.openai.com/auth"
const REFRESH_BUFFER_MS = 60_000
const CALLBACK_TIMEOUT_MS = 45_000

interface TokenSuccessResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface OAuthPageOptions {
  title: string
  heading: string
  message: string
}

export interface CodexCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface CodexAuthInfo {
  url: string
  instructions?: string
}

export interface LoginCodexOptions extends AuthRequestOptions {
  callbackTimeoutMs?: number
  onCallbackServerCreated?: (server: ReturnType<typeof createServer>) => void
  onAuth: (info: CodexAuthInfo) => void
  onPrompt: (message: string, signal?: AbortSignal) => Promise<string>
  onProgress?: (message: string) => void
}

export interface RefreshCodexCredentialsOptions extends AuthRequestOptions {
  onRotatedCredentials?: (credentials: CodexCredentials) => Promise<void> | void
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

async function generatePkce(): Promise<{
  verifier: string
  challenge: string
}> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64UrlEncode(verifierBytes)
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )

  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(hashBuffer)),
  }
}

function createState(): string {
  return randomBytes(16).toString("hex")
}

function parseAuthorizationInput(input: string): {
  code?: string
  state?: string
} {
  const value = input.trim()
  if (!value) {
    return {}
  }

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    }
  } catch {
    // Continue and parse it as plain text.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    }
  }

  return { code: value }
}

function decodeJwt(accessToken: string): Record<string, unknown> | null {
  try {
    const payload = accessToken.split(".")[1]
    if (!payload) {
      return null
    }
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken)
  if (!payload) {
    return null
  }

  const authPayload = payload[JWT_CLAIM_PATH]
  if (!authPayload || typeof authPayload !== "object") {
    return null
  }

  const accountId = (authPayload as { chatgpt_account_id?: unknown })
    .chatgpt_account_id
  return typeof accountId === "string" && accountId ? accountId : null
}

function renderOAuthPage(options: OAuthPageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #09090b;
      color: #fafafa;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
    }
    main {
      max-width: 560px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.15;
    }
    p {
      margin: 0;
      color: #a1a1aa;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(options.heading)}</h1>
    <p>${escapeHtml(options.message)}</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderOAuthSuccessPage(message: string): string {
  return renderOAuthPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message,
  })
}

function renderOAuthErrorPage(message: string): string {
  return renderOAuthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
  })
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  options?: AuthRequestOptions,
): Promise<TokenSuccessResult> {
  const response = await fetchAuthJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    },
    {
      ...options,
      action: "Codex token exchange",
    },
  )

  const oauthCode = readOAuthErrorCode(response.payload)
  if (!response.ok || oauthCode) {
    throw createAuthRequestError({
      action: "Codex token exchange",
      headers: response.headers,
      oauthCode,
      status: response.status,
    })
  }

  const payload = requireAuthObject(response, "Codex token exchange") as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof payload.access_token !== "string"
    || !payload.access_token
    || typeof payload.refresh_token !== "string"
    || !payload.refresh_token
    || typeof payload.expires_in !== "number"
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
  ) {
    throw new AuthProtocolError(
      "Codex token exchange response is missing required fields",
    )
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
}

async function refreshAccessToken(
  refreshToken: string,
  options?: AuthRequestOptions,
): Promise<TokenSuccessResult> {
  const response = await fetchAuthJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    },
    {
      ...options,
      action: "Codex token refresh",
    },
  )

  const oauthCode = readOAuthErrorCode(response.payload)
  if (!response.ok || oauthCode) {
    throw createAuthRequestError({
      action: "Codex token refresh",
      headers: response.headers,
      oauthCode,
      status: response.status,
    })
  }

  const payload = requireAuthObject(response, "Codex token refresh") as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof payload.access_token !== "string"
    || !payload.access_token
    || (payload.refresh_token !== undefined
      && (typeof payload.refresh_token !== "string" || !payload.refresh_token))
    || typeof payload.expires_in !== "number"
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
  ) {
    throw new AuthProtocolError(
      "Codex token refresh response is missing required fields",
    )
  }

  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" ?
        payload.refresh_token
      : refreshToken,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
}

async function createAuthorizationFlow(): Promise<{
  verifier: string
  state: string
  url: string
}> {
  const { verifier, challenge } = await generatePkce()
  const state = createState()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  url.searchParams.set("originator", "copilot-api")

  return { verifier, state, url: url.toString() }
}

async function waitForAuthorizationCode(
  state: string,
  signal?: AbortSignal,
  timeoutMs: number = CALLBACK_TIMEOUT_MS,
  onServerCreated?: (server: ReturnType<typeof createServer>) => void,
): Promise<string | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "Codex authorization callback timeout must be a positive finite number",
    )
  }
  if (signal?.aborted) {
    throw new AuthTransportError(
      "Codex authorization callback was aborted",
      "aborted",
    )
  }

  let resolveCode: ((code: string | null) => void) | undefined
  const waitForCode = new Promise<string | null>((resolve) => {
    resolveCode = resolve
  })

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || "", "http://localhost")
      if (url.pathname !== CALLBACK_PATH) {
        response.statusCode = 404
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("Callback route not found."))
        return
      }

      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("State mismatch."))
        return
      }

      const code = url.searchParams.get("code")
      if (!code) {
        response.statusCode = 400
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(renderOAuthErrorPage("Missing authorization code."))
        return
      }

      response.statusCode = 200
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        renderOAuthSuccessPage(
          "OpenAI Codex authentication completed. You can close this window.",
        ),
      )
      resolveCode?.(code)
    } catch {
      response.statusCode = 500
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        renderOAuthErrorPage("Internal error while processing OAuth callback."),
      )
    }
  })
  onServerCreated?.(server)

  let rejectOnAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () =>
      reject(
        new AuthTransportError(
          "Codex authorization callback was aborted",
          "aborted",
        ),
      )
    signal?.addEventListener("abort", rejectOnAbort, { once: true })
    // Close the gap between the initial check and listener registration.
    if (signal?.aborted) rejectOnAbort()
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs)
    timeout.unref?.()
  })

  try {
    const listening = new Promise<true>((resolve, reject) => {
      server.once("error", reject)
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        server.off("error", reject)
        resolve(true)
      })
    })
    let listenResult: true | null
    try {
      listenResult = await Promise.race([listening, timedOut, aborted])
    } catch (error) {
      if (error instanceof AuthTransportError) throw error
      return null
    }
    if (listenResult === null) return null
    return await Promise.race([waitForCode, timedOut, aborted])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (rejectOnAbort) signal?.removeEventListener("abort", rejectOnAbort)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    }).catch(() => undefined)
  }
}

async function waitForPrompt(
  prompt: Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (!signal) return await prompt
  if (signal.aborted) {
    throw new AuthTransportError(
      "Codex authorization prompt was aborted",
      "aborted",
    )
  }
  let rejectOnAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () =>
      reject(
        new AuthTransportError(
          "Codex authorization prompt was aborted",
          "aborted",
        ),
      )
    signal.addEventListener("abort", rejectOnAbort, { once: true })
    if (signal.aborted) rejectOnAbort()
  })
  try {
    return await Promise.race([prompt, aborted])
  } finally {
    if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort)
  }
}

export async function loginCodex(
  options: LoginCodexOptions,
): Promise<CodexCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow()
  options.onAuth({
    url,
    instructions:
      "Please complete the login in the browser. If the browser does not automatically redirect, please paste the callback URL or code back to the terminal.",
  })
  options.onProgress?.("Waiting for Codex OAuth callback")

  let code = await waitForAuthorizationCode(
    state,
    options.signal,
    options.callbackTimeoutMs,
    options.onCallbackServerCreated,
  )
  if (!code) {
    const input = await waitForPrompt(
      options.onPrompt(
        "Paste the authorization code or full redirect URL:",
        options.signal,
      ),
      options.signal,
    )
    const parsed = parseAuthorizationInput(input)
    if (parsed.state && parsed.state !== state) {
      throw new Error("Codex OAuth state mismatch")
    }
    code = parsed.code ?? null
  }

  if (!code) {
    throw new Error("Missing Codex authorization code")
  }

  const tokenResult = await exchangeAuthorizationCode(code, verifier, options)
  const accountId = getAccountId(tokenResult.accessToken)
  if (!accountId) {
    throw new Error("Failed to extract Codex account id from access token")
  }

  return {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresAt,
    accountId,
  }
}

export async function refreshCodexCredentials(
  credentials: CodexCredentials,
  options?: RefreshCodexCredentialsOptions,
): Promise<CodexCredentials> {
  const tokenResult = await refreshAccessToken(
    credentials.refreshToken,
    options,
  )
  // Account identity is stable across a refresh. Build the rotated credential
  // immediately and make it durable before caller-side lifecycle decisions can
  // discard the now-invalid predecessor.
  const rotatedCredentials: CodexCredentials = {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresAt,
    accountId: credentials.accountId,
  }
  await options?.onRotatedCredentials?.(rotatedCredentials)
  return rotatedCredentials
}

export function isCodexCredentialsExpired(
  credentials: Pick<CodexCredentials, "expiresAt">,
  now: number = Date.now(),
): boolean {
  return credentials.expiresAt <= now + REFRESH_BUFFER_MS
}
