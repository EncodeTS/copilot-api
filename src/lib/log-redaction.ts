const DATA_URL_BASE64_PATTERN =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(?:;[^,\s"']*)?;base64,[A-Za-z0-9+/=\r\n-]+/gu

const REMOTE_MEDIA_URL_PATTERN = /^(?:https?|file):\/\//iu
const CREDENTIAL_HEADER_PATTERN =
  /(\b(?:authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/giu
const BEARER_TOKEN_PATTERN = /\bBearer\s+[a-zA-Z0-9._~+/=-]+/gu
const JSON_CREDENTIAL_PATTERN =
  /((["'])(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credentials?|github[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?key|token|x-api-key)\2\s*:\s*)(["'])(?:\\[\s\S]|(?!\3)[^\\])*\3/giu
const JSON_MEDIA_PATTERN =
  /((["'])(?:file_data|file_id|image_url|input_audio)\2\s*:\s*)(["'])(?!\[redacted_media\b)(?:\\[\s\S]|(?!\3)[^\\])*\3/giu
const JSON_WEB_SEARCH_CARRIER_PATTERN =
  /((["'])_copilot_api_web_search_history\2\s*:\s*)(["'])(?:\\[\s\S]|(?!\3)[^\\])*\3/giu
const JSON_OPAQUE_PATTERN =
  /((["'])(?:encrypted_content|encrypted_index)\2\s*:\s*)(["'])(?:\\[\s\S]|(?!\3)[^\\])*\3/giu
const QUERY_CREDENTIAL_PATTERN =
  /([?&](?:access[_-]?token|api[_-]?key|authorization|key|password|refresh[_-]?token|secret|sig|signature|token)=)[^&#\s"']+/giu
const WEB_SEARCH_PROTOCOL_JSON_PATTERN =
  /_copilot_api_web_search_history|["'](?:name|type)["']\s*:\s*["'](?:web_search|web_search_call|web_search_result|web_search_result_location|web_search_tool_result)["']/iu

const REDACTED_WEB_SEARCH_HISTORY = "[redacted_web_search_history]"
const REDACTED_OPAQUE = "[redacted_opaque]"

type PropertyPath = Array<string>

interface RedactionOptions {
  stableMediaMarker?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const redactPayloadForDebug = (value: unknown): unknown =>
  redactValue(value, [], new WeakMap<object, unknown>(), {
    stableMediaMarker: false,
  })

export const redactPayloadForStableId = (value: unknown): unknown =>
  redactValue(value, [], new WeakMap<object, unknown>(), {
    stableMediaMarker: true,
  })

export const redactLogString = (value: string): string => {
  if (WEB_SEARCH_PROTOCOL_JSON_PATTERN.test(value)) {
    return `${REDACTED_WEB_SEARCH_HISTORY} ${REDACTED_OPAQUE}`
  }
  return value
    .replaceAll(DATA_URL_BASE64_PATTERN, (_match, mimeType: string) =>
      createMediaMarker({
        kind: "data_url",
        mimeType,
        options: { stableMediaMarker: false },
      }),
    )
    .replaceAll(
      CREDENTIAL_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}[redacted_credential]`,
    )
    .replaceAll(BEARER_TOKEN_PATTERN, "Bearer [redacted_credential]")
    .replaceAll(
      JSON_CREDENTIAL_PATTERN,
      (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
        `${prefix}${valueQuote}[redacted_credential]${valueQuote}`,
    )
    .replaceAll(
      JSON_MEDIA_PATTERN,
      (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
        `${prefix}${valueQuote}[redacted_media kind=json_field]${valueQuote}`,
    )
    .replaceAll(
      JSON_WEB_SEARCH_CARRIER_PATTERN,
      (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
        `${prefix}${valueQuote}[redacted_web_search_history]${valueQuote}`,
    )
    .replaceAll(
      JSON_OPAQUE_PATTERN,
      (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
        `${prefix}${valueQuote}[redacted_opaque]${valueQuote}`,
    )
    .replaceAll(
      QUERY_CREDENTIAL_PATTERN,
      (_match, prefix: string) => `${prefix}[redacted_credential]`,
    )
}

const redactValue = (
  value: unknown,
  path: PropertyPath,
  seen: WeakMap<object, unknown>,
  options: RedactionOptions,
): unknown => {
  const webSearchProtocolValue = redactWebSearchProtocolValue(value)
  if (webSearchProtocolValue !== undefined) {
    return webSearchProtocolValue
  }

  if (isMediaContainerPath(path)) {
    return createMediaMarker({ kind: "input_audio", options })
  }

  if (isWebSearchCarrierPath(path)) {
    return REDACTED_WEB_SEARCH_HISTORY
  }

  if (isOpaqueCarrierPath(path)) {
    return REDACTED_OPAQUE
  }

  if (isCredentialPath(path)) {
    return "[redacted_credential]"
  }

  if (typeof value === "string") {
    return redactStringValue(value, path, options)
  }

  if (Array.isArray(value)) {
    const cached = seen.get(value)
    if (cached) {
      return cached
    }

    const redacted: Array<unknown> = []
    seen.set(value, redacted)
    for (let index = 0; index < value.length; index += 1) {
      redacted.push(
        redactValue(value[index], [...path, String(index)], seen, options),
      )
    }
    return redacted
  }

  if (typeof value !== "object" || value === null) {
    return value
  }

  const cached = seen.get(value)
  if (cached) {
    return cached
  }

  const redacted: Record<string, unknown> = {}
  seen.set(value, redacted)
  for (const [key, childValue] of Object.entries(value)) {
    redacted[key] = redactValue(childValue, [...path, key], seen, options)
  }
  return redacted
}

const redactWebSearchProtocolValue = (value: unknown): unknown => {
  if (!isRecord(value)) return undefined
  const hasResponsesHistory = [value.input, value.output].some(
    (items) =>
      Array.isArray(items)
      && items.some(
        (item) => isRecord(item) && item.type === "web_search_call",
      ),
  )
  if (hasResponsesHistory) {
    return {
      kind: "web_search_payload_summary",
      history: REDACTED_WEB_SEARCH_HISTORY,
      opaque: REDACTED_OPAQUE,
    }
  }
  if (value.type === "web_search_call") {
    return {
      type: value.type,
      status: value.status,
      id: REDACTED_OPAQUE,
      action: REDACTED_WEB_SEARCH_HISTORY,
    }
  }
  if (value.type === "server_tool_use" && value.name === "web_search") {
    return {
      type: value.type,
      name: value.name,
      id: REDACTED_OPAQUE,
      input: REDACTED_WEB_SEARCH_HISTORY,
    }
  }
  if (value.type === "web_search_tool_result") {
    return {
      type: value.type,
      tool_use_id: REDACTED_OPAQUE,
      content: REDACTED_WEB_SEARCH_HISTORY,
    }
  }
  if (
    value.type === "web_search_result"
    || value.type === "web_search_result_location"
    || value.type === "url_citation"
  ) {
    return { type: value.type, value: REDACTED_OPAQUE }
  }
  if (
    value.type === "text"
    && Array.isArray(value.citations)
    && value.citations.some(
      (citation) =>
        isRecord(citation) && citation.type === "web_search_result_location",
    )
  ) {
    return {
      type: value.type,
      text: REDACTED_WEB_SEARCH_HISTORY,
      citations: REDACTED_OPAQUE,
    }
  }
  return undefined
}

const isCredentialPath = (path: PropertyPath): boolean => {
  const key = path
    .at(-1)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
  if (!key) return false

  return (
    key === "authorization"
    || key === "cookie"
    || key === "credentials"
    || key === "password"
    || key === "privatekey"
    || key === "secret"
    || key === "setcookie"
    || key === "xapikey"
    || key === "apikey"
    || key === "token"
    || key.endsWith("apikey")
    || key.endsWith("secret")
    || key.endsWith("token")
  )
}

const normalizedPathKey = (path: PropertyPath): string | undefined =>
  path
    .at(-1)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")

const isWebSearchCarrierPath = (path: PropertyPath): boolean =>
  normalizedPathKey(path) === "copilotapiwebsearchhistory"

const isOpaqueCarrierPath = (path: PropertyPath): boolean => {
  const key = normalizedPathKey(path)
  return key === "encryptedcontent" || key === "encryptedindex"
}

const isMediaContainerPath = (path: PropertyPath): boolean =>
  path
    .at(-1)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "") === "inputaudio"

const redactStringValue = (
  value: string,
  path: PropertyPath,
  options: RedactionOptions,
): string => {
  if (isFileIdPath(path)) {
    return createMediaMarker({ kind: "file_id", options })
  }

  if (isSourceDataPath(path)) {
    return createMediaMarker({
      kind: "source_data",
      mimeType: inferSiblingMimeType(path),
      options,
    })
  }

  if (isFileDataPath(path)) {
    return createMediaMarker({ kind: "file_data", options })
  }

  const withDataUrlsRedacted = redactLogString(value)
  if (withDataUrlsRedacted !== value) {
    return options.stableMediaMarker ?
        createMediaMarker({ kind: "data_url", options })
      : withDataUrlsRedacted
  }

  if (isMediaLocatorPath(path) && REMOTE_MEDIA_URL_PATTERN.test(value)) {
    return createMediaMarker({ kind: "remote_url", options })
  }

  return value
}

const isSourceDataPath = (path: PropertyPath): boolean =>
  path.at(-1) === "data" && path.at(-2) === "source"

const isFileDataPath = (path: PropertyPath): boolean =>
  path.at(-1) === "file_data"

const isFileIdPath = (path: PropertyPath): boolean => path.at(-1) === "file_id"

const isMediaLocatorPath = (path: PropertyPath): boolean => {
  const key = path.at(-1)
  const parent = path.at(-2)
  return (
    key === "image_url"
    || key === "file_data"
    || key === "file_id"
    || (key === "url" && parent === "image_url")
  )
}

const inferSiblingMimeType = (_path: PropertyPath): string | undefined =>
  undefined

const createMediaMarker = ({
  kind,
  mimeType,
  options,
}: {
  kind: string
  mimeType?: string
  options: RedactionOptions
}): string => {
  if (options.stableMediaMarker) {
    return `[redacted_media kind=${kind}]`
  }

  return [
    "[redacted_media",
    `kind=${kind}`,
    ...(mimeType ? [`mime=${mimeType}`] : []),
    "]",
  ].join(" ")
}
