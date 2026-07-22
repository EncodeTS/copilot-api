import type {
  ModelMappingsConfig,
  ModelMappingsConfigOutcome,
  ModelMappingsDiagnostic,
  ModelMappingsRequestError,
  ModelMappingsSaveOutcome,
  ModelMappingsSaveResult,
} from '../../shared-types'
import { MODEL_MAPPINGS_DIAGNOSTIC_CODE_VALUES } from '../../shared-types'

function readDiagnostics(value: unknown): ModelMappingsDiagnostic[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((diagnostic): ModelMappingsDiagnostic[] => {
    if (!diagnostic || typeof diagnostic !== 'object') return []
    const candidate = diagnostic as Record<string, unknown>
    if (
      typeof candidate.code !== 'string'
      || !MODEL_MAPPINGS_DIAGNOSTIC_CODE_VALUES.includes(
        candidate.code as ModelMappingsDiagnostic['code'],
      )
    ) {
      return []
    }
    if (
      candidate.source !== undefined
      && typeof candidate.source !== 'string'
    ) {
      return []
    }
    if (
      candidate.target !== undefined
      && typeof candidate.target !== 'string'
    ) {
      return []
    }
    return [
      {
        code: candidate.code as ModelMappingsDiagnostic['code'],
        ...(candidate.source === undefined ? {} : { source: candidate.source }),
        ...(candidate.target === undefined ? {} : { target: candidate.target }),
      },
    ]
  })
}

export async function readConfigApiError(
  response: Response,
): Promise<ModelMappingsRequestError> {
  try {
    const payload: unknown = await response.json()
    const errorPayload =
      isRecord(payload) && isRecord(payload.error) ? payload.error : null
    const diagnostics = readDiagnostics(errorPayload?.diagnostics)
    return {
      diagnostics,
      kind: diagnostics.length > 0 ? 'validation_failed' : 'request_failed',
      message:
        typeof errorPayload?.message === 'string' ?
          errorPayload.message
        : response.statusText,
    }
  } catch {
    return {
      diagnostics: [],
      kind: 'request_failed',
      message: response.statusText,
    }
  }
}

function requestFailure(error: unknown): ModelMappingsRequestError {
  return {
    diagnostics: [],
    kind: 'request_failed',
    message: error instanceof Error ? error.message : 'Request failed.',
  }
}

function invalidResponse(): ModelMappingsRequestError {
  return {
    diagnostics: [],
    kind: 'invalid_response',
    message: 'Invalid model mappings response.',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readModelMappings(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  return Object.values(value).every((target) => typeof target === 'string') ?
      (value as Record<string, string>)
    : null
}

function readModelMappingsConfig(value: unknown): ModelMappingsConfig | null {
  if (!isRecord(value) || typeof value.configPath !== 'string') return null
  const modelMappings = readModelMappings(value.modelMappings)
  return modelMappings ? { configPath: value.configPath, modelMappings } : null
}

const catalogSkippedReasons = new Set([
  'invalid_catalog',
  'invalid_client_version',
  'no_installed_client',
  'older_client_version',
  'projection_unavailable',
  'superseded_input',
])
const catalogFailedReasons = new Set([
  'generation_failed',
  'persistence_failed',
])

function isCatalogRefresh(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value.degraded !== 'boolean'
    || !Number.isSafeInteger(value.inputRevision)
    || typeof value.path !== 'string'
    || typeof value.restartRequired !== 'boolean'
    || typeof value.status !== 'string'
    || (value.clientVersion !== undefined
      && typeof value.clientVersion !== 'string')
  ) {
    return false
  }

  if (value.status === 'updated' || value.status === 'unchanged') {
    return (
      typeof value.clientVersion === 'string'
      && Number.isSafeInteger(value.modelCount)
    )
  }
  if (value.status === 'skipped') {
    return (
      value.restartRequired === false
      && catalogSkippedReasons.has(value.reason as string)
    )
  }
  if (value.status === 'failed') {
    return (
      value.restartRequired === false
      && catalogFailedReasons.has(value.reason as string)
    )
  }
  return false
}

function readModelMappingsSaveResult(
  value: unknown,
): ModelMappingsSaveResult | null {
  const config = readModelMappingsConfig(value)
  if (!config || !isRecord(value) || !isCatalogRefresh(value.catalogRefresh)) {
    return null
  }
  return {
    ...config,
    catalogRefresh:
      value.catalogRefresh as ModelMappingsSaveResult['catalogRefresh'],
  }
}

export async function readModelMappingsRequest({
  fetchRequest = fetch,
  headers,
  timeoutMs = 5_000,
  url,
}: {
  fetchRequest?: typeof fetch
  headers?: Record<string, string>
  timeoutMs?: number
  url: string
}): Promise<ModelMappingsConfigOutcome> {
  let response: Response
  try {
    response = await fetchRequest(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { error: requestFailure(error), ok: false }
  }

  if (!response.ok) {
    return { error: await readConfigApiError(response), ok: false }
  }

  try {
    const config = readModelMappingsConfig(await response.json())
    if (!config) return { error: invalidResponse(), ok: false }
    return {
      config,
      ok: true,
    }
  } catch {
    return { error: invalidResponse(), ok: false }
  }
}

export async function saveModelMappingsRequest({
  fetchRequest = fetch,
  headers,
  modelMappings,
  timeoutMs = 30_000,
  url,
}: {
  fetchRequest?: typeof fetch
  headers?: Record<string, string>
  modelMappings: Record<string, string>
  timeoutMs?: number
  url: string
}): Promise<ModelMappingsSaveOutcome> {
  let response: Response
  try {
    response = await fetchRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ modelMappings }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      error: requestFailure(error),
      ok: false,
    }
  }
  if (!response.ok) {
    return { error: await readConfigApiError(response), ok: false }
  }
  try {
    const result = readModelMappingsSaveResult(await response.json())
    if (!result) return { error: invalidResponse(), ok: false }
    return {
      ok: true,
      result,
    }
  } catch {
    return { error: invalidResponse(), ok: false }
  }
}
