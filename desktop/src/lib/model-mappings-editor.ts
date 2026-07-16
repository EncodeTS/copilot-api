export interface ModelMappingRow {
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
      model?: string
      ok: false
      reason: 'duplicate' | 'incomplete'
    }

export type ModelMappingsSaveOutcome =
  | 'degraded'
  | 'refresh_failed'
  | 'refresh_skipped'
  | 'restart_required'
  | 'saved'

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

export function buildModelMappingsFromRows(
  rows: ModelMappingRow[],
): ModelMappingsValidationResult {
  const modelMappings = Object.create(null) as Record<string, string>

  for (const row of rows) {
    if (!row.source.trim() && !row.target.trim()) {
      continue
    }

    if (!row.source.trim() || !row.target.trim()) {
      return { ok: false, reason: 'incomplete' }
    }

    if (Object.hasOwn(modelMappings, row.source)) {
      return { ok: false, model: row.source, reason: 'duplicate' }
    }

    modelMappings[row.source] = row.target
  }

  return { modelMappings, ok: true }
}

export function getModelMappingsSaveOutcome(
  result: ModelMappingsSaveResult,
): ModelMappingsSaveOutcome {
  const refresh = result.catalogRefresh
  if (refresh.status === 'failed') return 'refresh_failed'
  if (refresh.degraded) return 'degraded'
  if (refresh.restartRequired) return 'restart_required'
  if (refresh.status === 'skipped') return 'refresh_skipped'
  return 'saved'
}
import type { ModelMappingsSaveResult } from '../types/ipc'
