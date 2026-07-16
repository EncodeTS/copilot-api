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
  outcome: ModelMappingsSaveOutcome
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
import type { ModelMappingsSaveResult } from '../types/ipc'
