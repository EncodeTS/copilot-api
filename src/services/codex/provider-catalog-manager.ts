import type { ModelsResponse } from "~/services/copilot/get-models"

import {
  getCodexCredentialAccountKey,
  getCodexCredentialScopeKey,
  type CodexCredentialSnapshot,
} from "./credential-snapshot"
import {
  CODEX_STATIC_FALLBACK_DIAGNOSTICS,
  getStaticCodexModels,
  projectOfficialCodexCatalog,
} from "./provider-model-projector"
import {
  CodexProviderCatalogStore,
  type CodexCatalogRefresh,
} from "./provider-catalog-store"
import type {
  CodexOfficialCatalogProjection,
  CodexProviderCatalogDiagnostic,
  CodexProviderCatalogDiagnosticCode,
  CodexProviderCatalogManager,
  CodexProviderCatalogSnapshot,
} from "./provider-catalog-types"
import { fetchCodexProviderCatalog } from "./models-transport"

type FetchOfficialCodexCatalog = (
  credentials: CodexCredentialSnapshot,
  signal?: AbortSignal,
) => Promise<Response>

class CodexCatalogDiscoveryError extends Error {
  readonly diagnosticCode: CodexProviderCatalogDiagnosticCode

  constructor(
    message: string,
    diagnosticCode: CodexProviderCatalogDiagnosticCode,
  ) {
    super(message)
    this.diagnosticCode = diagnosticCode
  }
}

const appendDiagnostic = (
  diagnostics: ReadonlyArray<CodexProviderCatalogDiagnostic>,
  code: CodexProviderCatalogDiagnosticCode,
): Array<CodexProviderCatalogDiagnostic> =>
  diagnostics.some((diagnostic) => diagnostic.code === code) ?
    [...diagnostics]
  : [...diagnostics, { code }]

const appendStaticFallbackDiagnostics = (
  diagnostics: ReadonlyArray<CodexProviderCatalogDiagnostic>,
): Array<CodexProviderCatalogDiagnostic> => [
  ...diagnostics,
  ...CODEX_STATIC_FALLBACK_DIAGNOSTICS.filter(
    ({ code }) => !diagnostics.some((diagnostic) => diagnostic.code === code),
  ),
]

const toWaiterAbortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error(
    typeof reason === "string" ? reason : "Codex catalog waiter aborted",
  )
  error.name = "AbortError"
  return error
}

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error("Codex catalog refresh failed")

const waitForRefresh = async <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) {
    return await promise
  }
  if (signal.aborted) {
    throw toWaiterAbortError(signal.reason)
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () =>
      settle(() => reject(toWaiterAbortError(signal.reason)))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(toError(error))),
    )
  })
}

export const createCodexProviderCatalogManager = ({
  cacheMaxEntries = 8,
  cacheTtlMs = 5 * 60 * 1000,
  fetchOfficialCatalog = fetchCodexProviderCatalog,
  lastKnownGoodTtlMs = 24 * 60 * 60 * 1000,
  negativeCacheTtlMs = 30 * 1000,
  now = Date.now,
  projectOfficialCatalog = projectOfficialCodexCatalog,
  requestTimeoutMs = 3_000,
  staticFallback = getStaticCodexModels(),
}: {
  cacheMaxEntries?: number
  cacheTtlMs?: number
  fetchOfficialCatalog?: FetchOfficialCodexCatalog
  lastKnownGoodTtlMs?: number
  negativeCacheTtlMs?: number
  now?: () => number
  projectOfficialCatalog?: (
    value: unknown,
  ) => CodexOfficialCatalogProjection | null
  requestTimeoutMs?: number
  staticFallback?: ModelsResponse
} = {}): CodexProviderCatalogManager => {
  const store = new CodexProviderCatalogStore(cacheMaxEntries)
  let nextGeneration = 0

  const getFallback = (
    accountKey: string,
    currentTime: number,
    failureCode: CodexProviderCatalogDiagnosticCode,
  ): CodexProviderCatalogSnapshot => {
    const lastKnownGood = store.getLastKnownGood(accountKey, currentTime)
    if (lastKnownGood) {
      return {
        ...lastKnownGood.snapshot,
        diagnostics: appendDiagnostic(
          lastKnownGood.snapshot.diagnostics,
          failureCode,
        ),
        freshness: "stale",
        source: "last_known_good",
      }
    }
    return {
      catalog: structuredClone(staticFallback),
      diagnostics: appendStaticFallbackDiagnostics([{ code: failureCode }]),
      fetchedAt: null,
      freshness: "degraded",
      source: "static_fallback",
    }
  }

  const createRefresh = (
    accountKey: string,
    refreshKey: string,
    credentials: CodexCredentialSnapshot,
  ): CodexCatalogRefresh => {
    const generation = (nextGeneration += 1)
    const startedAt = now()
    let resolveRefresh!: (snapshot: CodexProviderCatalogSnapshot) => void
    let rejectRefresh!: (error: Error) => void
    const refreshPromise = new Promise<CodexProviderCatalogSnapshot>(
      (resolve, reject) => {
        resolveRefresh = resolve
        rejectRefresh = reject
      },
    )
    const refresh: CodexCatalogRefresh = {
      expiresAt: startedAt + cacheTtlMs,
      generation,
      promise: refreshPromise,
      retired: false,
    }
    const executeRefresh = async (): Promise<CodexProviderCatalogSnapshot> => {
      const requestController = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            const error = new Error("Codex models request timed out")
            requestController.abort(error)
            reject(error)
          },
          Math.max(1, requestTimeoutMs),
        )
      })

      try {
        const response = await Promise.race([
          Promise.resolve().then(() =>
            fetchOfficialCatalog(credentials, requestController.signal),
          ),
          timeoutPromise,
        ])
        if (!response.ok) {
          throw new CodexCatalogDiscoveryError(
            `Codex models request failed with ${response.status}`,
            "official_unavailable",
          )
        }
        let projection: CodexOfficialCatalogProjection | null
        try {
          projection = projectOfficialCatalog(await response.json())
        } catch {
          throw new CodexCatalogDiscoveryError(
            "Codex models response could not be parsed",
            "official_catalog_invalid",
          )
        }
        if (
          !projection
          || (projection.upstreamModelCount > 0
            && projection.catalog.data.length === 0)
        ) {
          throw new CodexCatalogDiscoveryError(
            "Codex models response has no valid projections",
            "official_catalog_invalid",
          )
        }

        const snapshot: CodexProviderCatalogSnapshot = {
          catalog: projection.catalog,
          diagnostics: projection.diagnostics,
          fetchedAt: now(),
          freshness: "fresh",
          source: "official",
        }
        store.commitLastKnownGood(
          accountKey,
          refreshKey,
          credentials.credentialRevision,
          refresh,
          {
            credentialRevision: credentials.credentialRevision,
            expiresAt: now() + lastKnownGoodTtlMs,
            generation,
            snapshot,
          },
        )
        refresh.expiresAt = now() + cacheTtlMs
        return snapshot
      } catch (error) {
        refresh.expiresAt = now() + negativeCacheTtlMs
        return getFallback(
          accountKey,
          now(),
          error instanceof CodexCatalogDiscoveryError ?
            error.diagnosticCode
          : "official_unavailable",
        )
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
      }
    }

    const accepted = store.setRefresh(
      accountKey,
      refreshKey,
      credentials.credentialRevision,
      refresh,
    )
    if (!accepted) {
      const current = store.getCurrentRefresh(accountKey, now())
      if (current) {
        return current.refresh
      }
      resolveRefresh(getFallback(accountKey, now(), "official_unavailable"))
      return refresh
    }
    void executeRefresh().then(resolveRefresh, (error: unknown) =>
      rejectRefresh(toError(error)),
    )
    return refresh
  }

  return {
    clear: () => {
      store.clear()
      nextGeneration = 0
    },
    load: async ({ credentials, forceRefresh = false, signal }) => {
      if (signal?.aborted) {
        throw toWaiterAbortError(signal.reason)
      }
      const accountKey = getCodexCredentialAccountKey(credentials)
      const refreshKey = getCodexCredentialScopeKey(credentials)
      const latestRevision = store.getLatestCredentialRevision(accountKey)
      if (
        latestRevision !== undefined
        && credentials.credentialRevision < latestRevision
      ) {
        const current = store.getCurrentRefresh(accountKey, now())
        if (current) {
          return await waitForRefresh(current.refresh.promise, signal)
        }
        return await waitForRefresh(
          Promise.resolve(
            getFallback(accountKey, now(), "official_unavailable"),
          ),
          signal,
        )
      }
      const refresh =
        !forceRefresh ?
          store.getCachedRefresh(
            accountKey,
            refreshKey,
            credentials.credentialRevision,
            now(),
          )
        : null
      return await waitForRefresh(
        (refresh ?? createRefresh(accountKey, refreshKey, credentials)).promise,
        signal,
      )
    },
  }
}
