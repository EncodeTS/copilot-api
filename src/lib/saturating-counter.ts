export const incrementSaturatingCounter = <TKey extends PropertyKey>(
  record: Record<TKey, number>,
  key: TKey,
  increment = 1,
): void => {
  record[key] = addSaturatingCounter(record[key], increment)
}

export const addSaturatingCounter = (
  current: number,
  increment = 1,
): number => {
  const normalizedCurrent = normalizeCounter(current)
  const normalizedIncrement = normalizeCounter(increment)
  if (normalizedIncrement === 0) return normalizedCurrent
  if (normalizedCurrent >= Number.MAX_SAFE_INTEGER - normalizedIncrement) {
    return Number.MAX_SAFE_INTEGER
  }
  return normalizedCurrent + normalizedIncrement
}

const normalizeCounter = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}
