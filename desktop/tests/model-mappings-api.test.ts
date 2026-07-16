import { expect, mock, test } from 'bun:test'

import { saveModelMappingsRequest } from '../electron/model-mappings-api'
import type { ModelMappingsSaveResult } from '../src/types/ipc'

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

  expect(result).toEqual(expected)
  expect(fetchRequest.mock.calls[0]?.[0]).toBe(
    'http://localhost/admin/config/model-mappings',
  )
  expect(JSON.parse(fetchRequest.mock.calls[0]?.[1].body as string)).toEqual({
    modelMappings: { source: 'target' },
  })
  expect(fetchRequest.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
})
