const SAFE_LOG_METADATA_PATTERN = /^[a-zA-Z0-9._:/+-]+$/u

export const toSafeLogMetadata = (value: unknown): string | undefined =>
  (
    typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && SAFE_LOG_METADATA_PATTERN.test(value)
  ) ?
    value
  : undefined
