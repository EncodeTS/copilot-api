export const normalizeToken = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

export const normalizeOptionalToken = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : normalizeToken(value)
