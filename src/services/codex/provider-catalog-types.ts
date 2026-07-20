import type { ModelsResponse } from "~/services/copilot/get-models"
import type { CodexCredentialSnapshot } from "./credential-snapshot"

export type CodexProviderCatalogSource =
  | "official"
  | "last_known_good"
  | "static_fallback"

export type CodexProviderCatalogFreshness = "fresh" | "stale" | "degraded"

export type CodexProviderCatalogDiagnosticCode =
  | "official_catalog_invalid"
  | "official_unavailable"
  | "static_capability_degraded"
  | "static_effort_filtered"
  | "unsupported_reasoning_effort"

export interface CodexProviderCatalogDiagnostic {
  code: CodexProviderCatalogDiagnosticCode
  model?: string
  value?: string
}

export interface CodexProviderCatalogSnapshot {
  catalog: ModelsResponse
  diagnostics: Array<CodexProviderCatalogDiagnostic>
  fetchedAt: number | null
  freshness: CodexProviderCatalogFreshness
  source: CodexProviderCatalogSource
}

export interface CodexProviderCatalogManager {
  clear: () => void
  load: (options: {
    credentials: CodexCredentialSnapshot
    forceRefresh?: boolean
    signal?: AbortSignal
  }) => Promise<CodexProviderCatalogSnapshot>
}

export interface CodexOfficialCatalogProjection {
  catalog: ModelsResponse
  diagnostics: Array<CodexProviderCatalogDiagnostic>
  upstreamModelCount: number
}
