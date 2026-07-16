import { describe, expect, test } from 'bun:test'

import {
  buildModelMappingsFromRows,
  getModelMappingsSaveOutcome,
} from '../src/lib/model-mappings-editor'
import type { ModelMappingsSaveResult } from '../src/types/ipc'

const createSaveResult = (
  catalogRefresh: ModelMappingsSaveResult['catalogRefresh'],
): ModelMappingsSaveResult => ({
  catalogRefresh,
  configPath: '/tmp/config.json',
  modelMappings: { source: 'target' },
})

describe('model mappings editor', () => {
  test('keeps duplicate rows observable before converting them to a safe record', () => {
    expect(
      buildModelMappingsFromRows([
        { id: '1', source: 'source', target: 'target-a' },
        { id: '2', source: 'source', target: 'target-b' },
      ]),
    ).toEqual({ model: 'source', ok: false, reason: 'duplicate' })
  })

  test('derives distinct renderer outcomes from the preserved admin response', () => {
    expect(
      getModelMappingsSaveOutcome(
        createSaveResult({
          clientVersion: '0.144.2',
          degraded: false,
          inputRevision: 1,
          modelCount: 2,
          path: '/tmp/models.json',
          restartRequired: false,
          status: 'unchanged',
        }),
      ),
    ).toBe('saved')
    expect(
      getModelMappingsSaveOutcome(
        createSaveResult({
          clientVersion: '0.144.2',
          degraded: false,
          inputRevision: 2,
          modelCount: 2,
          path: '/tmp/models.json',
          restartRequired: true,
          status: 'updated',
        }),
      ),
    ).toBe('restart_required')
    expect(
      getModelMappingsSaveOutcome(
        createSaveResult({
          clientVersion: '0.144.2',
          degraded: true,
          inputRevision: 3,
          modelCount: 1,
          path: '/tmp/models.json',
          restartRequired: true,
          status: 'updated',
        }),
      ),
    ).toBe('degraded')
    expect(
      getModelMappingsSaveOutcome(
        createSaveResult({
          clientVersion: '0.144.2',
          degraded: false,
          inputRevision: 4,
          path: '/tmp/models.json',
          reason: 'no_installed_client',
          restartRequired: false,
          status: 'skipped',
        }),
      ),
    ).toBe('refresh_skipped')
    expect(
      getModelMappingsSaveOutcome(
        createSaveResult({
          clientVersion: '0.144.2',
          degraded: false,
          inputRevision: 5,
          path: '/tmp/models.json',
          reason: 'persistence_failed',
          restartRequired: false,
          status: 'failed',
        }),
      ),
    ).toBe('refresh_failed')
  })
})
