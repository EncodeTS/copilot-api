import {
  MEDIA_FACT_MAX_DEPTH,
  MEDIA_FACT_MAX_FACTS,
  MEDIA_FACT_MAX_NODES,
  type MediaCollectionWarning,
  type MediaFact,
  type MediaFactCollection,
  type MediaFactLimits,
  type CollectMediaFactsOptions,
} from "~/lib/media-facts/types"

export interface Ancestor {
  parent?: Ancestor
  value: object
}

export interface VisitResult {
  accepted: boolean
  ancestor?: Ancestor
}

const HARD_LIMITS: Readonly<MediaFactLimits> = Object.freeze({
  maxDepth: MEDIA_FACT_MAX_DEPTH,
  maxFacts: MEDIA_FACT_MAX_FACTS,
  maxNodes: MEDIA_FACT_MAX_NODES,
})

const freezeFact = (fact: MediaFact): Readonly<MediaFact> =>
  Object.freeze({
    ...fact,
    ...(fact.base64 ? { base64: Object.freeze({ ...fact.base64 }) } : {}),
    ...(fact.image ? { image: Object.freeze({ ...fact.image }) } : {}),
    path: Object.freeze([...fact.path]),
    warnings: Object.freeze([...fact.warnings]),
  })

export class FactCollector {
  readonly facts: Array<MediaFact> = []
  readonly warnings: Array<MediaCollectionWarning> = []
  halted = false
  maxDepthVisited = 0
  nodesVisited = 0
  readonly options: CollectMediaFactsOptions

  constructor(options: CollectMediaFactsOptions) {
    this.options = options
  }

  visit(value: unknown, depth: number, ancestors?: Ancestor): VisitResult {
    if (this.halted) return { accepted: false }
    if (depth > HARD_LIMITS.maxDepth) {
      this.warn("max_depth_exceeded")
      return { accepted: false }
    }
    if (this.nodesVisited >= HARD_LIMITS.maxNodes) {
      this.warn("max_nodes_exceeded")
      this.halted = true
      return { accepted: false }
    }
    this.nodesVisited += 1
    this.maxDepthVisited = Math.max(this.maxDepthVisited, depth)

    if (typeof value !== "object" || value === null) {
      return { accepted: true }
    }
    let ancestor = ancestors
    while (ancestor) {
      if (ancestor.value === value) {
        this.warn("cycle_detected")
        return { accepted: false }
      }
      ancestor = ancestor.parent
    }
    return {
      accepted: true,
      ancestor: {
        ...(ancestors ? { parent: ancestors } : {}),
        value,
      },
    }
  }

  add(fact: MediaFact): void {
    if (this.halted) return
    if (this.facts.length >= HARD_LIMITS.maxFacts) {
      this.warn("max_facts_exceeded")
      this.halted = true
      return
    }
    this.facts.push(fact)
  }

  warn(warning: MediaCollectionWarning): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning)
  }

  result(): MediaFactCollection {
    const facts = Object.freeze(this.facts.map(freezeFact))
    const limits = Object.freeze({ ...HARD_LIMITS })
    const warnings = Object.freeze([...this.warnings])
    const stats = Object.freeze({
      factsCollected: facts.length,
      maxDepthVisited: this.maxDepthVisited,
      nodesVisited: this.nodesVisited,
      truncated: warnings.length > 0,
    })
    return Object.freeze({ facts, limits, stats, warnings })
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
