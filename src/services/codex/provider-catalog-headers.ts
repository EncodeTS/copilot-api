import type { CodexProviderCatalogSnapshot } from "./provider-catalog-types"

export const getCodexProviderCatalogHeaders = (
  snapshot: CodexProviderCatalogSnapshot,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "x-copilot-api-codex-catalog-freshness": snapshot.freshness,
    "x-copilot-api-codex-catalog-source": snapshot.source,
  }
  if (snapshot.fetchedAt !== null) {
    headers["x-copilot-api-codex-catalog-fetched-at"] = new Date(
      snapshot.fetchedAt,
    ).toISOString()
  }
  const diagnosticCodes = [
    ...new Set(snapshot.diagnostics.map(({ code }) => code)),
  ]
  if (diagnosticCodes.length > 0) {
    headers["x-copilot-api-codex-catalog-diagnostics"] =
      diagnosticCodes.join(",")
  }
  return headers
}
