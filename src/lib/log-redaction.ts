const DATA_URL_BASE64_PATTERN =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(?:;[^,\s"']*)?;base64,[A-Za-z0-9+/=\r\n-]+/gu

const REMOTE_MEDIA_URL_PATTERN = /^(?:https?|file):\/\//iu

type PropertyPath = Array<string>

interface RedactionOptions {
  stableMediaMarker?: boolean
}

export const redactPayloadForDebug = (value: unknown): unknown =>
  redactValue(value, [], new WeakMap<object, unknown>(), {
    stableMediaMarker: false,
  })

export const redactPayloadForStableId = (value: unknown): unknown =>
  redactValue(value, [], new WeakMap<object, unknown>(), {
    stableMediaMarker: true,
  })

export const redactLogString = (value: string): string =>
  value.replaceAll(DATA_URL_BASE64_PATTERN, (_match, mimeType: string) =>
    createMediaMarker({
      kind: "data_url",
      mimeType,
      options: { stableMediaMarker: false },
    }),
  )

const redactValue = (
  value: unknown,
  path: PropertyPath,
  seen: WeakMap<object, unknown>,
  options: RedactionOptions,
): unknown => {
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
