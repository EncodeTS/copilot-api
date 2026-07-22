import { captureCodexCredentialSnapshot } from "./credential-snapshot"
import { createCodexProviderCatalogManager } from "./provider-catalog-manager"
import type { CodexProviderCatalogSnapshot } from "./provider-catalog-types"

export { createCodexProviderCatalogManager } from "./provider-catalog-manager"
export {
  captureCodexCredentialSnapshot,
  getCodexCredentialAccountKey,
  getCodexCredentialScopeKey,
  type CodexCredentialSnapshot,
} from "./credential-snapshot"
export { getCodexProviderCatalogHeaders } from "./provider-catalog-headers"
export {
  fetchCodexProviderCatalog,
  forwardCodexModels,
  resolveCodexModelsUrl,
} from "./models-transport"
export {
  CODEX_PROVIDER_ADAPTER_INVARIANTS,
  getStaticCodexModels,
} from "./provider-model-projector"
export type {
  CodexProviderCatalogDiagnostic,
  CodexProviderCatalogDiagnosticCode,
  CodexProviderCatalogFreshness,
  CodexProviderCatalogManager,
  CodexProviderCatalogSnapshot,
  CodexProviderCatalogSource,
} from "./provider-catalog-types"

const codexProviderCatalogManager = createCodexProviderCatalogManager()

export const loadCodexProviderModels = async (
  signal?: AbortSignal,
): Promise<CodexProviderCatalogSnapshot> =>
  await codexProviderCatalogManager.load({
    credentials: captureCodexCredentialSnapshot(),
    signal,
  })

export const clearCodexProviderCatalogCache = (): void => {
  codexProviderCatalogManager.clear()
}
