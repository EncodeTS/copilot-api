import type { ModelMappingsSaveResult } from '../src/types/ipc'

interface ConfigApiErrorResponse {
  error?: {
    message?: string
  }
}

export async function readConfigApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ConfigApiErrorResponse
    return payload.error?.message ?? response.statusText
  } catch {
    return response.statusText
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
}): Promise<ModelMappingsSaveResult> {
  const response = await fetchRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ modelMappings }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(await readConfigApiError(response))
  }
  return (await response.json()) as ModelMappingsSaveResult
}
