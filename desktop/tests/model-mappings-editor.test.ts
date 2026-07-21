import { describe, expect, test } from 'bun:test'

import {
  applyModelMappingsDiagnostics,
  buildModelMappingsFromRows,
  createModelMappingRow,
  formatModelMappingsDiagnostic,
  getModelMappingsSavePresentation,
  modelMappingsToRows,
} from '../src/lib/model-mappings-editor'
import type { ModelMappingsSaveResult } from '../../shared-types'

const createSaveResult = (
  catalogRefresh: ModelMappingsSaveResult['catalogRefresh'],
): ModelMappingsSaveResult => ({
  catalogRefresh,
  configPath: '/tmp/config.json',
  modelMappings: { source: 'target' },
})

describe('model mappings editor', () => {
  test('converts mapping rows without hiding incomplete input', () => {
    expect(createModelMappingRow('source', 'target', 'row-1')).toEqual({
      id: 'row-1',
      source: 'source',
      target: 'target',
    })
    expect(
      modelMappingsToRows({ alpha: 'target-a', beta: 'target-b' }).map(
        ({ source, target }) => ({ source, target }),
      ),
    ).toEqual([
      { source: 'alpha', target: 'target-a' },
      { source: 'beta', target: 'target-b' },
    ])
    expect(
      buildModelMappingsFromRows([
        { id: 'blank', source: ' ', target: '' },
        { id: 'valid', source: 'source', target: 'target' },
      ]),
    ).toEqual({
      modelMappings: { source: 'target' },
      ok: true,
    })
    expect(
      buildModelMappingsFromRows([
        { id: 'missing-source', source: '', target: 'target' },
      ]),
    ).toEqual({
      diagnostics: [
        { code: 'whitespace_source', source: '', target: 'target' },
      ],
      ok: false,
    })
    expect(
      buildModelMappingsFromRows([
        { id: 'missing-target', source: 'source', target: '' },
      ]),
    ).toEqual({
      diagnostics: [
        { code: 'whitespace_target', source: 'source', target: '' },
      ],
      ok: false,
    })
  })

  test('keeps duplicate rows observable before converting them to a safe record', () => {
    expect(
      buildModelMappingsFromRows([
        { id: '1', source: 'source', target: 'target-a' },
        { id: '2', source: 'source', target: 'target-b' },
      ]),
    ).toEqual({
      diagnostics: [{ code: 'duplicate_source', source: 'source' }],
      ok: false,
    })
  })

  test('marks the exact row without changing server diagnostics', () => {
    const rows = [
      createModelMappingRow('alias', 'target', 'row-1'),
      createModelMappingRow('target', 'live', 'row-2'),
    ]
    const diagnostic = {
      code: 'chain',
      source: 'alias',
      target: 'target',
    } as const

    expect(applyModelMappingsDiagnostics(rows, [diagnostic])).toEqual([
      {
        diagnostics: [diagnostic],
        id: 'row-1',
        source: 'alias',
        target: 'target',
      },
      {
        diagnostics: [],
        id: 'row-2',
        source: 'target',
        target: 'live',
      },
    ])
    expect(formatModelMappingsDiagnostic(diagnostic)).toBe(
      'chain · source="alias" · target="target"',
    )
  })

  test('keeps projection degradation orthogonal to every refresh status', () => {
    const cases: Array<{
      degraded: boolean
      expected: ReturnType<typeof getModelMappingsSavePresentation>
      restartRequired: boolean
      status: ModelMappingsSaveResult['catalogRefresh']['status']
    }> = [
      {
        degraded: false,
        expected: {
          degradedMessageKey: null,
          messageKey: 'savedRestartRequired',
          outcome: 'restart_required',
          tone: 'info',
        },
        restartRequired: true,
        status: 'updated',
      },
      {
        degraded: true,
        expected: {
          degradedMessageKey: 'savedDegraded',
          messageKey: 'savedRestartRequired',
          outcome: 'restart_required',
          tone: 'warning',
        },
        restartRequired: true,
        status: 'updated',
      },
      {
        degraded: false,
        expected: {
          degradedMessageKey: null,
          messageKey: 'saved',
          outcome: 'saved',
          tone: 'success',
        },
        restartRequired: false,
        status: 'unchanged',
      },
      {
        degraded: true,
        expected: {
          degradedMessageKey: 'savedDegraded',
          messageKey: 'saved',
          outcome: 'saved',
          tone: 'warning',
        },
        restartRequired: false,
        status: 'unchanged',
      },
      {
        degraded: false,
        expected: {
          degradedMessageKey: null,
          messageKey: 'savedRefreshSkipped',
          outcome: 'refresh_skipped',
          tone: 'warning',
        },
        restartRequired: false,
        status: 'skipped',
      },
      {
        degraded: true,
        expected: {
          degradedMessageKey: 'savedDegraded',
          messageKey: 'savedRefreshSkipped',
          outcome: 'refresh_skipped',
          tone: 'warning',
        },
        restartRequired: false,
        status: 'skipped',
      },
      {
        degraded: false,
        expected: {
          degradedMessageKey: null,
          messageKey: 'savedRefreshFailed',
          outcome: 'refresh_failed',
          tone: 'error',
        },
        restartRequired: false,
        status: 'failed',
      },
      {
        degraded: true,
        expected: {
          degradedMessageKey: 'savedDegraded',
          messageKey: 'savedRefreshFailed',
          outcome: 'refresh_failed',
          tone: 'error',
        },
        restartRequired: false,
        status: 'failed',
      },
    ]

    for (const { degraded, expected, restartRequired, status } of cases) {
      const reason =
        status === 'skipped' ? 'no_installed_client'
        : status === 'failed' ? 'persistence_failed'
        : undefined
      expect(
        getModelMappingsSavePresentation(
          createSaveResult({
            clientVersion: '0.144.2',
            degraded,
            inputRevision: 1,
            ...(status === 'updated' || status === 'unchanged' ?
              { modelCount: 2 }
            : { reason }),
            path: '/tmp/models.json',
            restartRequired,
            status,
          } as ModelMappingsSaveResult['catalogRefresh']),
        ),
      ).toEqual(expected)
    }
  })
})
