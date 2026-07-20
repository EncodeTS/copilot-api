export const GATEWAY_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const

export type GatewayReasoningEffort = (typeof GATEWAY_REASONING_EFFORTS)[number]

export type MessageReasoningEffort = Exclude<
  GatewayReasoningEffort,
  "none" | "minimal"
>

export interface NormalizedReasoningEfforts {
  efforts: Array<GatewayReasoningEffort>
  rejected: Array<string>
  validArray: boolean
}

export function normalizeGatewayReasoningEffort(
  value: unknown,
): GatewayReasoningEffort | null {
  return typeof value === "string" ?
      (GATEWAY_REASONING_EFFORTS.find((effort) => effort === value) ?? null)
    : null
}

export function normalizeMessageReasoningEffort(
  value: unknown,
): MessageReasoningEffort | null {
  const effort = normalizeGatewayReasoningEffort(value)
  return effort && effort !== "none" && effort !== "minimal" ? effort : null
}

export function normalizeGatewayReasoningEfforts(
  value: unknown,
): NormalizedReasoningEfforts {
  if (!Array.isArray(value)) {
    return { efforts: [], rejected: [], validArray: false }
  }

  const efforts: Array<GatewayReasoningEffort> = []
  const rejected: Array<string> = []
  let validArray = true
  for (const item of value) {
    if (typeof item !== "string") {
      validArray = false
      continue
    }
    const effort = normalizeGatewayReasoningEffort(item)
    if (!effort) {
      if (!rejected.includes(item)) {
        rejected.push(item)
      }
      continue
    }
    if (!efforts.includes(effort)) {
      efforts.push(effort)
    }
  }
  return { efforts, rejected, validArray }
}
