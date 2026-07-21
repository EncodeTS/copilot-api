/** Recursively freezes an object graph without revisiting cycles. */
export const deepFreeze = <T extends object>(
  value: T,
  seen = new WeakSet<object>(),
): T => {
  const pending: object[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    for (const nested of Object.values(current as Record<string, unknown>)) {
      if (typeof nested === "object" && nested !== null) {
        pending.push(nested)
      }
    }
    Object.freeze(current)
  }
  return value
}
