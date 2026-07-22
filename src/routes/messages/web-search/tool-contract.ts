import { createHash } from "node:crypto"

import type { AnthropicTool } from "../anthropic-types"

export interface WebSearchToolContract {
  readonly algorithm: "sha256"
  readonly digest: string
}

const MAX_TOOL_CONTRACT_DEPTH = 64
const MAX_TOOL_CONTRACT_NODES = 100_000

export class WebSearchToolContractError extends Error {
  constructor() {
    super("Web Search tool contract is not canonical JSON")
    this.name = "WebSearchToolContractError"
  }
}

export const createWebSearchToolContract = (
  tools: ReadonlyArray<AnthropicTool> | undefined,
): WebSearchToolContract => {
  const budget = { nodes: 0 }
  const canonical = canonicalizeToolContractValue(tools ?? [], 0, budget)
  const serialized = JSON.stringify(canonical)
  return Object.freeze({
    algorithm: "sha256",
    digest: createHash("sha256").update(serialized, "utf8").digest("hex"),
  })
}

const canonicalizeToolContractValue = (
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown => {
  budget.nodes += 1
  if (
    budget.nodes > MAX_TOOL_CONTRACT_NODES
    || depth > MAX_TOOL_CONTRACT_DEPTH
  ) {
    throw new WebSearchToolContractError()
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new WebSearchToolContractError()
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      canonicalizeToolContractValue(item, depth + 1, budget),
    )
  }
  if (
    typeof value !== "object"
    || value === null
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new WebSearchToolContractError()
  }

  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child === undefined) throw new WebSearchToolContractError()
    canonical[key] = canonicalizeToolContractValue(child, depth + 1, budget)
  }
  return canonical
}

export const isWebSearchToolContract = (
  value: unknown,
): value is WebSearchToolContract =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && Object.keys(value).length === 2
  && Object.hasOwn(value, "algorithm")
  && Object.hasOwn(value, "digest")
  && (value as { algorithm?: unknown }).algorithm === "sha256"
  && typeof (value as { digest?: unknown }).digest === "string"
  && /^[a-f0-9]{64}$/u.test((value as { digest: string }).digest)
