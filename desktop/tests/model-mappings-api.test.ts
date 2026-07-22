import { expect, mock, test } from 'bun:test'

import {
  readModelMappingsRequest,
  saveModelMappingsRequest,
} from '../electron/model-mappings-api'
import type { ModelMappingsSaveResult } from '../../shared-types'

test('desktop model mappings adapter returns the complete admin save outcome', async () => {
  const expected: ModelMappingsSaveResult = {
    catalogRefresh: {
      clientVersion: '0.144.2',
      degraded: true,
      inputRevision: 3,
      modelCount: 1,
      path: '/tmp/models.json',
      restartRequired: true,
      status: 'updated',
    },
    configPath: '/tmp/config.json',
    modelMappings: { source: 'target' },
  }
  const fetchRequest = mock((_url: string, _init: RequestInit) =>
    Promise.resolve(Response.json(expected)),
  )

  const result = await saveModelMappingsRequest({
    fetchRequest: fetchRequest as unknown as typeof fetch,
    headers: { 'x-api-key': 'admin' },
    modelMappings: { source: 'target' },
    url: 'http://localhost/admin/config/model-mappings',
  })

  expect(result).toEqual({ ok: true, result: expected })
  expect(fetchRequest.mock.calls[0]?.[0]).toBe(
    'http://localhost/admin/config/model-mappings',
  )
  expect(JSON.parse(fetchRequest.mock.calls[0]?.[1].body as string)).toEqual({
    modelMappings: { source: 'target' },
  })
  expect(fetchRequest.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
})

test('desktop model mappings adapter preserves structured diagnostics', async () => {
  const fetchRequest = mock(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            diagnostics: [{ code: 'chain', source: 'alias', target: 'target' }],
            message: 'Invalid model mappings.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
    ),
  )

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { source: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [{ code: 'chain', source: 'alias', target: 'target' }],
      kind: 'validation_failed',
      message: 'Invalid model mappings.',
    },
    ok: false,
  })
})

test('desktop model mappings adapter falls back to HTTP status text', async () => {
  const fetchRequest = mock(() =>
    Promise.resolve(
      new Response('upstream failure', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    ),
  )

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { source: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [],
      kind: 'request_failed',
      message: 'Bad Gateway',
    },
    ok: false,
  })
})

test('desktop model mappings adapter serializes transport failures', async () => {
  const fetchRequest = mock(() =>
    Promise.reject(new TypeError('connection refused')),
  )

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { source: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [],
      kind: 'request_failed',
      message: 'connection refused',
    },
    ok: false,
  })
})

test('desktop model mappings read adapter returns a serializable outcome', async () => {
  const config = {
    configPath: '/tmp/config.json',
    modelMappings: { alias: 'provider/model' },
  }
  const fetchRequest = mock((_url: string, _init: RequestInit) =>
    Promise.resolve(Response.json(config)),
  )

  expect(
    await readModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      headers: { 'x-api-key': 'admin' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({ config, ok: true })
  expect(fetchRequest.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
})

test('desktop model mappings adapter serializes malformed success responses', async () => {
  const fetchRequest = mock(() =>
    Promise.resolve(new Response('not-json', { status: 200 })),
  )

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { source: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [],
      kind: 'invalid_response',
      message: 'Invalid model mappings response.',
    },
    ok: false,
  })
})

test('desktop model mappings adapter rejects schema-invalid JSON success', async () => {
  const fetchRequest = mock(() => Promise.resolve(Response.json({})))

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { source: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [],
      kind: 'invalid_response',
      message: 'Invalid model mappings response.',
    },
    ok: false,
  })
})

test('desktop model mappings adapter filters malformed diagnostics safely', async () => {
  const fetchRequest = mock(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            diagnostics: [
              null,
              { code: 'future_code' },
              { code: 'chain', source: 42, target: 'target' },
              { code: 'chain', source: 'alias', target: 42 },
            ],
            message: 42,
          },
        },
        { status: 400, statusText: 'Bad Request' },
      ),
    ),
  )

  expect(
    await saveModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      modelMappings: { alias: 'target' },
      url: 'http://localhost/admin/config/model-mappings',
    }),
  ).toEqual({
    error: {
      diagnostics: [],
      kind: 'request_failed',
      message: 'Bad Request',
    },
    ok: false,
  })
})

test('desktop model mappings adapter accepts skipped and failed refresh states', async () => {
  const refreshes: ModelMappingsSaveResult['catalogRefresh'][] = [
    {
      degraded: false,
      inputRevision: 2,
      path: '/tmp/models.json',
      reason: 'no_installed_client',
      restartRequired: false,
      status: 'skipped',
    },
    {
      degraded: true,
      inputRevision: 3,
      path: '/tmp/models.json',
      reason: 'persistence_failed',
      restartRequired: false,
      status: 'failed',
    },
  ]

  for (const catalogRefresh of refreshes) {
    const result = {
      catalogRefresh,
      configPath: '/tmp/config.json',
      modelMappings: { alias: 'target' },
    }
    expect(
      await saveModelMappingsRequest({
        fetchRequest: mock(() =>
          Promise.resolve(Response.json(result)),
        ) as unknown as typeof fetch,
        modelMappings: { alias: 'target' },
        url: 'http://localhost/admin/config/model-mappings',
      }),
    ).toEqual({ ok: true, result })
  }
})

test('desktop model mappings read adapter serializes every failure class', async () => {
  const inputs = [
    mock(() => Promise.reject(new TypeError('offline'))),
    mock(() => Promise.resolve(Response.json({}, { status: 503 }))),
    mock(() => Promise.resolve(Response.json({ configPath: 42 }))),
    mock(() => Promise.resolve(new Response('not-json'))),
  ]

  for (const fetchRequest of inputs) {
    const result = await readModelMappingsRequest({
      fetchRequest: fetchRequest as unknown as typeof fetch,
      url: 'http://localhost/admin/config/model-mappings',
    })
    expect(result.ok).toBeFalse()
  }
})
