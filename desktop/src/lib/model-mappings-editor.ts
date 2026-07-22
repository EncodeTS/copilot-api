import type {
  ModelMappingsDiagnostic,
  ModelMappingsSaveResult,
} from '../../../shared-types'

export interface ModelMappingRow {
  diagnostics?: ModelMappingsDiagnostic[]
  id: string
  source: string
  target: string
}

export type ModelMappingsValidationResult =
  | {
      modelMappings: Record<string, string>
      ok: true
    }
  | {
      diagnostics: ModelMappingsDiagnostic[]
      ok: false
    }

export type ModelMappingsSavePresentationOutcome =
  'refresh_failed' | 'refresh_skipped' | 'restart_required' | 'saved'

export type ModelMappingsSaveMessageKey =
  | 'saved'
  | 'savedDegraded'
  | 'savedRefreshFailed'
  | 'savedRefreshSkipped'
  | 'savedRestartRequired'

export interface ModelMappingsSavePresentation {
  degradedMessageKey: 'savedDegraded' | null
  messageKey: Exclude<ModelMappingsSaveMessageKey, 'savedDegraded'>
  outcome: ModelMappingsSavePresentationOutcome
  tone: 'error' | 'info' | 'success' | 'warning'
}

function createModelMappingRowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createModelMappingRow(
  source = '',
  target = '',
  id = createModelMappingRowId(),
): ModelMappingRow {
  return {
    id,
    source,
    target,
  }
}

export function modelMappingsToRows(
  modelMappings: Record<string, string>,
): ModelMappingRow[] {
  return Object.entries(modelMappings).map(([source, target]) =>
    createModelMappingRow(source, target),
  )
}

export function applyModelMappingsDiagnostics(
  rows: ModelMappingRow[],
  diagnostics: ModelMappingsDiagnostic[],
): ModelMappingRow[] {
  return rows.map((row) => ({
    ...row,
    diagnostics: diagnostics.filter((diagnostic) => {
      if (diagnostic.source === undefined && diagnostic.target === undefined) {
        return false
      }
      if (diagnostic.source !== undefined && diagnostic.source !== row.source) {
        return false
      }
      if (diagnostic.target !== undefined && diagnostic.target !== row.target) {
        return false
      }
      return true
    }),
  }))
}

export function formatModelMappingsDiagnostic(
  diagnostic: ModelMappingsDiagnostic,
): string {
  return [
    diagnostic.code,
    ...(diagnostic.source === undefined ?
      []
    : [`source=${JSON.stringify(diagnostic.source)}`]),
    ...(diagnostic.target === undefined ?
      []
    : [`target=${JSON.stringify(diagnostic.target)}`]),
  ].join(' · ')
}

export function buildModelMappingsFromRows(
  rows: ModelMappingRow[],
): ModelMappingsValidationResult {
  const modelMappings = Object.create(null) as Record<string, string>

  for (const row of rows) {
    if (!row.source.trim() && !row.target.trim()) {
      continue
    }

    if (!row.source.trim()) {
      return {
        diagnostics: [
          {
            code: 'whitespace_source',
            source: row.source,
            target: row.target,
          },
        ],
        ok: false,
      }
    }

    if (!row.target.trim()) {
      return {
        diagnostics: [
          {
            code: 'whitespace_target',
            source: row.source,
            target: row.target,
          },
        ],
        ok: false,
      }
    }

    if (Object.hasOwn(modelMappings, row.source)) {
      return {
        diagnostics: [{ code: 'duplicate_source', source: row.source }],
        ok: false,
      }
    }

    modelMappings[row.source] = row.target
  }

  return { modelMappings, ok: true }
}

export function getModelMappingsSavePresentation(
  result: ModelMappingsSaveResult,
): ModelMappingsSavePresentation {
  const refresh = result.catalogRefresh
  const degradedMessageKey = refresh.degraded ? 'savedDegraded' : null

  if (refresh.status === 'failed') {
    return {
      degradedMessageKey,
      messageKey: 'savedRefreshFailed',
      outcome: 'refresh_failed',
      tone: 'error',
    }
  }
  if (refresh.status === 'skipped') {
    return {
      degradedMessageKey,
      messageKey: 'savedRefreshSkipped',
      outcome: 'refresh_skipped',
      tone: 'warning',
    }
  }
  if (refresh.status === 'updated' && refresh.restartRequired) {
    return {
      degradedMessageKey,
      messageKey: 'savedRestartRequired',
      outcome: 'restart_required',
      tone: refresh.degraded ? 'warning' : 'info',
    }
  }
  return {
    degradedMessageKey,
    messageKey: 'saved',
    outcome: 'saved',
    tone: refresh.degraded ? 'warning' : 'success',
  }
}
