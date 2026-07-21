import type {
  TokenLogger,
  TokenSetupOptions,
  TokenSleep,
} from "../../../src/lib/token-manager-types"
import type {
  ZstdWorkerDecoder,
  ZstdWorkerInput,
  ZstdWorkerOutput,
} from "../../../src/lib/zstd-worker-protocol"
import type {
  CodexOfficialCatalogProjection,
  CodexProviderCatalogManager,
  CodexProviderCatalogSnapshot,
} from "../../../src/services/codex/provider-catalog-types"

export interface DeclarationContractConsumer {
  catalog: CodexOfficialCatalogProjection
  catalogManager: CodexProviderCatalogManager
  catalogSnapshot: CodexProviderCatalogSnapshot
  decoder: ZstdWorkerDecoder
  logger: TokenLogger
  setup: TokenSetupOptions
  sleep: TokenSleep
  workerInput: ZstdWorkerInput
  workerOutput: ZstdWorkerOutput
}
