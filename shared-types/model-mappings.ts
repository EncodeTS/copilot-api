export const MODEL_MAPPINGS_DIAGNOSTIC_CODE_VALUES = [
  "chain",
  "duplicate_source",
  "invalid_record",
  "self_mapping",
  "unsafe_name",
  "whitespace_source",
  "whitespace_target",
] as const

export type ModelMappingsDiagnosticCode =
  (typeof MODEL_MAPPINGS_DIAGNOSTIC_CODE_VALUES)[number]

export interface ModelMappingsDiagnostic {
  code: ModelMappingsDiagnosticCode
  source?: string
  target?: string
}

export type ModelMappingsValidationOutcome =
  | {
      modelMappings: Record<string, string>
      ok: true
    }
  | {
      diagnostics: ModelMappingsDiagnostic[]
      ok: false
    }

export type CodexStartupCatalogUpdateResult =
  | {
      clientVersion: string
      degraded: boolean
      inputRevision: number
      modelCount: number
      path: string
      restartRequired: boolean
      status: "unchanged" | "updated"
    }
  | {
      clientVersion?: string
      degraded: boolean
      inputRevision: number
      path: string
      reason:
        | "invalid_catalog"
        | "invalid_client_version"
        | "no_installed_client"
        | "older_client_version"
        | "projection_unavailable"
        | "superseded_input"
      restartRequired: false
      status: "skipped"
    }
  | {
      clientVersion?: string
      degraded: boolean
      inputRevision: number
      path: string
      reason: "generation_failed" | "persistence_failed"
      restartRequired: false
      status: "failed"
    }

export interface ModelMappingsConfig {
  configPath: string
  modelMappings: Record<string, string>
}

export interface ModelMappingsSaveResult extends ModelMappingsConfig {
  catalogRefresh: CodexStartupCatalogUpdateResult
}

export type ModelMappingsRequestErrorKind =
  | "invalid_response"
  | "request_failed"
  | "validation_failed"

export interface ModelMappingsRequestError {
  diagnostics: ModelMappingsDiagnostic[]
  kind: ModelMappingsRequestErrorKind
  message: string
}

export type ModelMappingsConfigOutcome =
  | { config: ModelMappingsConfig; ok: true }
  | { error: ModelMappingsRequestError; ok: false }

export type ModelMappingsSaveOutcome =
  | { ok: true; result: ModelMappingsSaveResult }
  | { error: ModelMappingsRequestError; ok: false }
