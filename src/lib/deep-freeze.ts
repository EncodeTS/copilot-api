/** Recursively freezes an object graph without revisiting cycles. */
export const deepFreeze = <T extends object>(
  value: T,
  seen = new WeakSet<object>(),
): T => {
  if (seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      deepFreeze(nested, seen)
    }
  }
  return Object.freeze(value)
}
