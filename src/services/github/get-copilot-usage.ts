import { createHash } from "node:crypto"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import {
  AuthProtocolError,
  AuthTransportError,
  fetchAuthJson,
  type AuthFetch,
  type AuthJsonResponse,
  type AuthRequestOptions,
} from "~/lib/auth-request"
import { state } from "~/lib/state"

export type CopilotAccountType = "individual" | "business" | "enterprise"

export type CopilotUsageErrorCode =
  | "aborted"
  | "forbidden"
  | "invalid_response"
  | "network_error"
  | "rate_limited"
  | "timeout"
  | "unauthorized"
  | "upstream_error"

export class CopilotUsageFetchError extends Error {
  readonly cacheNeutral: boolean
  readonly code: CopilotUsageErrorCode
  readonly kind: "aborted" | "permanent" | "retryable" | "timeout"
  readonly retryAfterMs: number | null
  readonly staleEligible: boolean
  readonly status: number | null

  constructor(input: {
    cacheNeutral?: boolean
    code: CopilotUsageErrorCode
    retryAfterMs?: number | null
    staleEligible?: boolean
    status?: number | null
  }) {
    super(`Copilot usage refresh failed (${input.code})`)
    this.name = "CopilotUsageFetchError"
    this.cacheNeutral = input.cacheNeutral ?? false
    this.code = input.code
    this.kind =
      input.code === "aborted" ? "aborted"
      : input.code === "timeout" ? "timeout"
      : isTransientErrorCode(input.code) ? "retryable"
      : "permanent"
    this.retryAfterMs = input.retryAfterMs ?? null
    this.staleEligible = input.staleEligible ?? false
    this.status = input.status ?? null
  }
}

/**
 * Gateway-owned refresh metadata. The `/usage` route exposes this under
 * `_copilot_api` while preserving every upstream usage field at the top level.
 */
export interface CopilotUsageRefreshStatus {
  error_code: CopilotUsageErrorCode | null
  freshness: "fresh" | "stale"
  last_attempt_at_ms: number
  last_success_at_ms: number
  stale_since_at_ms: number | null
}

export interface CopilotUsageSnapshot {
  status: CopilotUsageRefreshStatus
  usage: CopilotUsageResponse
}

export interface GetCopilotUsageOptions extends AuthRequestOptions {
  expectedLogin?: string
  maxAttempts?: number
  requestTimeoutMs?: number
}

interface CopilotUsageFetchDependencies {
  fetch: AuthFetch
  maxAttempts: number
  maxRetryAfterMs: number
  maxScopes: number
  now: () => number
  requestTimeoutMs: number
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  staleTtlMs: number
}

export const copilotUsageFetchDependencies: CopilotUsageFetchDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  maxAttempts: 2,
  maxRetryAfterMs: 2_000,
  maxScopes: 8,
  now: () => Date.now(),
  requestTimeoutMs: 5_000,
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CopilotUsageFetchError({ code: "aborted" }))
        return
      }
      const onAbort = () => {
        clearTimeout(timeout)
        reject(new CopilotUsageFetchError({ code: "aborted" }))
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, milliseconds)
      signal.addEventListener("abort", onAbort, { once: true })
    }),
  staleTtlMs: 5 * 60_000,
}

interface CopilotUsageScopeState {
  errorCode: CopilotUsageErrorCode | null
  lastAttemptAtMs: number
  lastSuccessAtMs: number | null
  revision: number
  staleSinceAtMs: number | null
  usage: CopilotUsageResponse | null
}

interface ResolvedCopilotUsagePolicy {
  expectedLogin: string | null
  fetch?: AuthFetch
  maxAttempts: number
  requestTimeoutMs: number
}

interface InFlightUsageRefresh {
  controller: AbortController
  promise: Promise<CopilotUsageSnapshot>
  settled: boolean
  scope: string
  waiters: number
}

const inFlightByRefreshKey = new Map<string, InFlightUsageRefresh>()
const stateByScope = new Map<string, CopilotUsageScopeState>()
const fetchIdentityByFunction = new WeakMap<AuthFetch, number>()
let nextFetchIdentity = 0
let nextUsageRefreshRevision = 0

export function getCopilotUsageScopeId(githubToken: string): string {
  return createHash("sha256")
    .update(getGitHubApiBaseUrl())
    .update("\0")
    .update(githubToken)
    .digest("base64url")
}

export function resetCopilotUsageCacheForTests(): void {
  for (const refresh of inFlightByRefreshKey.values()) {
    refresh.controller.abort()
  }
  inFlightByRefreshKey.clear()
  stateByScope.clear()
}

export function invalidateCopilotUsageScope(githubToken: string): void {
  const scope = getCopilotUsageScopeId(githubToken)
  for (const [key, refresh] of inFlightByRefreshKey) {
    if (refresh.scope === scope) {
      refresh.controller.abort()
      inFlightByRefreshKey.delete(key)
    }
  }
  stateByScope.delete(scope)
}

export const getCopilotUsageSnapshot = async (
  githubToken?: string,
  options: GetCopilotUsageOptions = {},
): Promise<CopilotUsageSnapshot | null> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    return null
  }
  if (options.signal?.aborted) {
    throw new CopilotUsageFetchError({ code: "aborted" })
  }

  const scope = getCopilotUsageScopeId(resolvedGithubToken)
  const policy = resolveUsagePolicy(options)
  const refreshKey = getUsageRefreshKey(scope, policy)
  let refresh = inFlightByRefreshKey.get(refreshKey)
  if (refresh?.controller.signal.aborted) {
    inFlightByRefreshKey.delete(refreshKey)
    refresh = undefined
  }
  if (!refresh) {
    refresh = createInFlightUsageRefresh(
      refreshKey,
      scope,
      resolvedGithubToken,
      policy,
    )
    inFlightByRefreshKey.set(refreshKey, refresh)
  }
  return waitForRefresh(refresh, options.signal)
}

function resolveUsagePolicy(
  options: GetCopilotUsageOptions,
): ResolvedCopilotUsagePolicy {
  return {
    expectedLogin: options.expectedLogin?.trim().toLowerCase() || null,
    fetch: options.fetch,
    maxAttempts: clampFiniteInteger(
      options.maxAttempts ?? copilotUsageFetchDependencies.maxAttempts,
      2,
      1,
      3,
    ),
    requestTimeoutMs: clampFiniteInteger(
      options.requestTimeoutMs
        ?? options.timeoutMs
        ?? copilotUsageFetchDependencies.requestTimeoutMs,
      5_000,
      1,
      30_000,
    ),
  }
}

function getUsageRefreshKey(
  scope: string,
  policy: ResolvedCopilotUsagePolicy,
): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(String(policy.maxAttempts))
    .update("\0")
    .update(String(policy.requestTimeoutMs))
    .update("\0")
    .update(policy.expectedLogin ?? "")
    .update("\0")
    .update(String(getFetchIdentity(policy.fetch)))
    .digest("base64url")
}

function getFetchIdentity(fetcher: AuthFetch | undefined): number {
  if (!fetcher) return 0
  const existing = fetchIdentityByFunction.get(fetcher)
  if (existing !== undefined) return existing
  const identity = ++nextFetchIdentity
  fetchIdentityByFunction.set(fetcher, identity)
  return identity
}

function createInFlightUsageRefresh(
  refreshKey: string,
  scope: string,
  githubToken: string,
  policy: ResolvedCopilotUsagePolicy,
): InFlightUsageRefresh {
  const controller = new AbortController()
  const promise = refreshCopilotUsage(
    scope,
    githubToken,
    policy,
    controller.signal,
  )
  const refresh: InFlightUsageRefresh = {
    controller,
    promise,
    settled: false,
    scope,
    waiters: 0,
  }
  refresh.promise.then(
    () => settleInFlightUsageRefresh(refreshKey, refresh),
    () => settleInFlightUsageRefresh(refreshKey, refresh),
  )
  return refresh
}

function settleInFlightUsageRefresh(
  refreshKey: string,
  refresh: InFlightUsageRefresh,
): void {
  refresh.settled = true
  if (inFlightByRefreshKey.get(refreshKey) === refresh) {
    inFlightByRefreshKey.delete(refreshKey)
  }
}

function waitForRefresh(
  refresh: InFlightUsageRefresh,
  signal?: AbortSignal,
): Promise<CopilotUsageSnapshot> {
  if (signal?.aborted) {
    return Promise.reject(new CopilotUsageFetchError({ code: "aborted" }))
  }

  refresh.waiters += 1
  return new Promise<CopilotUsageSnapshot>((resolve, reject) => {
    let finished = false
    const finish = () => {
      if (finished) return false
      finished = true
      signal?.removeEventListener("abort", onAbort)
      refresh.waiters = Math.max(0, refresh.waiters - 1)
      if (refresh.waiters === 0 && !refresh.settled) {
        refresh.controller.abort()
      }
      return true
    }
    const onAbort = () => {
      if (finish()) {
        reject(new CopilotUsageFetchError({ code: "aborted" }))
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    refresh.promise.then(
      (snapshot) => {
        if (finish()) resolve(snapshot)
      },
      (error: unknown) => {
        if (finish()) reject(normalizeUsageFetchError(error))
      },
    )
  })
}

async function refreshCopilotUsage(
  scope: string,
  githubToken: string,
  policy: ResolvedCopilotUsagePolicy,
  signal: AbortSignal,
): Promise<CopilotUsageSnapshot> {
  const revision = ++nextUsageRefreshRevision
  const lastAttemptAtMs = copilotUsageFetchDependencies.now()
  const previous = stateByScope.get(scope)

  try {
    const usage = await fetchFreshCopilotUsage(githubToken, policy, signal)
    const lastSuccessAtMs = copilotUsageFetchDependencies.now()
    const nextState: CopilotUsageScopeState = {
      errorCode: null,
      lastAttemptAtMs,
      lastSuccessAtMs,
      revision,
      staleSinceAtMs: null,
      usage,
    }
    commitScopeState(scope, nextState)
    return toUsageSnapshot(nextState, "fresh")
  } catch (error) {
    const safeError = normalizeUsageFetchError(error)
    if (safeError.code === "aborted" || safeError.cacheNeutral) {
      throw safeError
    }
    const current = stateByScope.get(scope)
    const fallbackState =
      (
        current
        && current.revision > (previous?.revision ?? Number.NEGATIVE_INFINITY)
      ) ?
        current
      : previous
    const authFailure =
      safeError.code === "unauthorized" || safeError.code === "forbidden"
    const now = copilotUsageFetchDependencies.now()
    const staleTtlMs = clampFiniteInteger(
      copilotUsageFetchDependencies.staleTtlMs,
      5 * 60_000,
      0,
      60 * 60_000,
    )
    const canUseStale =
      !authFailure
      && (safeError.staleEligible || isTransientErrorCode(safeError.code))
      && fallbackState?.usage !== null
      && fallbackState?.usage !== undefined
      && fallbackState.lastSuccessAtMs !== null
      && matchesExpectedLogin(fallbackState.usage, policy.expectedLogin)
      && now - fallbackState.lastSuccessAtMs >= 0
      && now - fallbackState.lastSuccessAtMs <= staleTtlMs

    if (
      canUseStale
      && fallbackState?.usage
      && fallbackState.lastSuccessAtMs !== null
    ) {
      const nextState: CopilotUsageScopeState = {
        errorCode: safeError.code,
        lastAttemptAtMs,
        lastSuccessAtMs: fallbackState.lastSuccessAtMs,
        revision,
        staleSinceAtMs: fallbackState.staleSinceAtMs ?? lastAttemptAtMs,
        usage: fallbackState.usage,
      }
      commitScopeState(scope, nextState)
      return toUsageSnapshot(nextState, "stale")
    }

    commitScopeState(scope, {
      errorCode: safeError.code,
      lastAttemptAtMs,
      lastSuccessAtMs:
        authFailure ? null : (fallbackState?.lastSuccessAtMs ?? null),
      revision,
      staleSinceAtMs:
        authFailure ? null : (fallbackState?.staleSinceAtMs ?? lastAttemptAtMs),
      usage: null,
    })
    throw safeError
  }
}

function commitScopeState(
  scope: string,
  scopeState: CopilotUsageScopeState,
): boolean {
  const current = stateByScope.get(scope)
  if (current && current.revision > scopeState.revision) {
    return false
  }
  setScopeState(scope, scopeState)
  return true
}

function matchesExpectedLogin(
  usage: CopilotUsageResponse,
  expectedLogin: string | null,
): boolean {
  return expectedLogin === null || usage.login.toLowerCase() === expectedLogin
}

function toUsageSnapshot(
  scopeState: CopilotUsageScopeState,
  freshness: CopilotUsageRefreshStatus["freshness"],
): CopilotUsageSnapshot {
  if (!scopeState.usage || scopeState.lastSuccessAtMs === null) {
    throw new CopilotUsageFetchError({ code: "invalid_response" })
  }

  return {
    status: {
      error_code: scopeState.errorCode,
      freshness,
      last_attempt_at_ms: scopeState.lastAttemptAtMs,
      last_success_at_ms: scopeState.lastSuccessAtMs,
      stale_since_at_ms: scopeState.staleSinceAtMs,
    },
    usage: scopeState.usage,
  }
}

function setScopeState(
  scope: string,
  scopeState: CopilotUsageScopeState,
): void {
  stateByScope.delete(scope)
  stateByScope.set(scope, scopeState)

  const maxScopes = clampFiniteInteger(
    copilotUsageFetchDependencies.maxScopes,
    8,
    1,
    64,
  )
  while (stateByScope.size > maxScopes) {
    const oldestScope = stateByScope.keys().next().value
    if (!oldestScope) break
    stateByScope.delete(oldestScope)
  }
}

function clampFiniteInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value) ?
      Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function normalizeUsageFetchError(error: unknown): CopilotUsageFetchError {
  return error instanceof CopilotUsageFetchError ? error : (
      new CopilotUsageFetchError({ code: "network_error" })
    )
}

function isTransientErrorCode(code: CopilotUsageErrorCode): boolean {
  return (
    code === "network_error"
    || code === "rate_limited"
    || code === "timeout"
    || code === "upstream_error"
  )
}

async function fetchFreshCopilotUsage(
  githubToken: string,
  policy: ResolvedCopilotUsagePolicy,
  signal: AbortSignal,
): Promise<CopilotUsageResponse> {
  const authState = { ...state, githubToken }
  let response: AuthJsonResponse | null = null

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      response = await fetchCopilotUsageAttempt(
        `${getGitHubApiBaseUrl()}/copilot_internal/user`,
        {
          headers: githubHeaders(authState),
        },
        policy.requestTimeoutMs,
        signal,
        policy.fetch,
      )
    } catch (error) {
      const safeError = normalizeUsageFetchError(error)
      if (safeError.code === "aborted") {
        throw safeError
      }
      if (attempt >= policy.maxAttempts) {
        throw safeError
      }
      await copilotUsageFetchDependencies.sleep(
        resolveRetryDelayMs(null, attempt),
        signal,
      )
      continue
    }

    if (response.ok || !isTransientStatus(response.status)) {
      break
    }

    if (attempt < policy.maxAttempts) {
      await copilotUsageFetchDependencies.sleep(
        resolveRetryDelayMs(response, attempt),
        signal,
      )
    }
  }

  if (!response) {
    throw new CopilotUsageFetchError({ code: "network_error" })
  }
  if (!response.ok) {
    throw createResponseError(response)
  }

  if (!response.jsonValid) {
    throw new CopilotUsageFetchError({
      code: "invalid_response",
      staleEligible: true,
      status: response.status,
    })
  }
  const parsed = response.payload

  if (!isCopilotUsageResponse(parsed)) {
    throw new CopilotUsageFetchError({
      code: "invalid_response",
      staleEligible: true,
      status: response.status,
    })
  }
  if (
    policy.expectedLogin !== null
    && parsed.login.toLowerCase() !== policy.expectedLogin
  ) {
    throw new CopilotUsageFetchError({
      cacheNeutral: true,
      code: "invalid_response",
      status: response.status,
    })
  }
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  )
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function isQuotaDetail(value: unknown): value is QuotaDetail {
  if (!isRecord(value)) return false
  return (
    isOptionalFiniteNumber(value.entitlement)
    && isOptionalFiniteNumber(value.overage_count)
    && isOptionalBoolean(value.overage_permitted)
    && isOptionalFiniteNumber(value.percent_remaining)
    && isOptionalString(value.quota_id)
    && isOptionalFiniteNumber(value.quota_remaining)
    && isOptionalFiniteNumber(value.remaining)
    && isOptionalBoolean(value.unlimited)
  )
}

function isQuotaSnapshots(value: unknown): value is QuotaSnapshots {
  if (!isRecord(value)) return false
  return (
    (value.chat === undefined || isQuotaDetail(value.chat))
    && (value.completions === undefined || isQuotaDetail(value.completions))
    && (value.premium_interactions === undefined
      || isQuotaDetail(value.premium_interactions))
  )
}

function isCopilotUsageResponse(value: unknown): value is CopilotUsageResponse {
  if (!isRecord(value)) return false
  const endpoints = value.endpoints
  return (
    typeof value.login === "string"
    && value.login.trim().length > 0
    && isRecord(endpoints)
    && isHttpsUrl(endpoints.api)
    && isHttpsUrl(endpoints.telemetry)
    && isOptionalString(value.copilot_plan)
    && isOptionalString(value.quota_reset_date)
    && (value.quota_snapshots === undefined
      || isQuotaSnapshots(value.quota_snapshots))
    && isOptionalBoolean(value.token_based_billing)
  )
}

function createResponseError(
  response: Pick<AuthJsonResponse, "headers" | "status">,
): CopilotUsageFetchError {
  const code: CopilotUsageErrorCode =
    response.status === 401 ? "unauthorized"
    : response.status === 403 ? "forbidden"
    : response.status === 429 ? "rate_limited"
    : response.status >= 500 ? "upstream_error"
    : "invalid_response"

  return new CopilotUsageFetchError({
    code,
    retryAfterMs: response.status === 429 ? parseRetryAfterMs(response) : null,
    status: response.status,
  })
}

async function fetchCopilotUsageAttempt(
  input: string | URL | Request,
  init: RequestInit,
  requestTimeoutMs?: number,
  signal?: AbortSignal,
  fetcher?: AuthFetch,
): Promise<AuthJsonResponse> {
  try {
    return await fetchAuthJson(input, init, {
      action: "GitHub Copilot usage request",
      fetch: fetcher ?? copilotUsageFetchDependencies.fetch,
      signal,
      timeoutMs: clampFiniteInteger(
        requestTimeoutMs ?? copilotUsageFetchDependencies.requestTimeoutMs,
        5_000,
        1,
        30_000,
      ),
    })
  } catch (error) {
    if (error instanceof AuthTransportError) {
      throw new CopilotUsageFetchError({
        code:
          error.kind === "aborted" ? "aborted"
          : error.kind === "timeout" ? "timeout"
          : "network_error",
      })
    }
    if (error instanceof AuthProtocolError) {
      throw new CopilotUsageFetchError({
        code: "invalid_response",
        staleEligible: error.retryDisposition === "retryable",
      })
    }
    throw error
  }
}

function isTransientStatus(status: number): boolean {
  return (
    status === 408
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
  )
}

function resolveRetryDelayMs(
  response: Pick<AuthJsonResponse, "headers"> | null,
  attempt: number,
): number {
  const maxDelayMs = clampFiniteInteger(
    copilotUsageFetchDependencies.maxRetryAfterMs,
    2_000,
    0,
    30_000,
  )
  const requestedDelayMs =
    response ?
      (parseRetryAfterMs(response) ?? 100 * 2 ** (attempt - 1))
    : 100 * 2 ** (attempt - 1)

  return Math.min(maxDelayMs, Math.max(0, requestedDelayMs))
}

function parseRetryAfterMs(
  response: Pick<AuthJsonResponse, "headers">,
): number | null {
  const retryAfter = response.headers["retry-after"]?.trim()
  if (!retryAfter) return null

  const retryAfterSeconds = Number(retryAfter)
  const rawDelayMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ?
      retryAfterSeconds * 1_000
    : Math.max(0, Date.parse(retryAfter) - copilotUsageFetchDependencies.now())
  if (!Number.isFinite(rawDelayMs)) return null

  return Math.min(
    clampFiniteInteger(
      copilotUsageFetchDependencies.maxRetryAfterMs,
      2_000,
      0,
      30_000,
    ),
    rawDelayMs,
  )
}

export const getCopilotUsage = async (
  githubToken?: string,
  options?: GetCopilotUsageOptions,
): Promise<CopilotUsageResponse | null> => {
  const snapshot = await getCopilotUsageSnapshot(githubToken, options)
  return snapshot?.usage ?? null
}

export const getCopilotAccountType = async (
  githubToken?: string,
  options: GetCopilotUsageOptions = {},
): Promise<CopilotAccountType> => {
  const usage = await getCopilotUsage(githubToken, options)
  if (!usage) {
    throw new Error("GitHub token not found")
  }

  return resolveCopilotAccountType(usage)
}

export function resolveCopilotAccountType(
  usage: Pick<CopilotUsageResponse, "copilot_plan">,
): CopilotAccountType {
  const plan = (usage.copilot_plan ?? "").toLowerCase()

  if (plan.includes("enterprise")) return "enterprise"
  if (plan.includes("business")) return "business"
  return "individual"
}

export interface QuotaDetail {
  entitlement?: number
  overage_count?: number
  overage_permitted?: boolean
  percent_remaining?: number
  quota_id?: string
  quota_remaining?: number
  remaining?: number
  unlimited?: boolean
}

interface QuotaSnapshots {
  chat?: QuotaDetail
  completions?: QuotaDetail
  premium_interactions?: QuotaDetail
}

export interface CopilotUsageResponse {
  login: string
  access_type_sku?: string
  analytics_tracking_id?: string
  assigned_date?: string
  can_signup_for_limited?: boolean
  chat_enabled?: boolean
  copilot_plan?: string
  organization_login_list?: Array<unknown>
  organization_list?: Array<unknown>
  quota_reset_date?: string
  quota_snapshots?: QuotaSnapshots
  endpoints: {
    api: string
    telemetry: string
  }
  token_based_billing?: boolean
}
