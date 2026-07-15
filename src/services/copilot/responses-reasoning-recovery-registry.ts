import { createHash } from "node:crypto"

import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

const DEFAULT_MAX_SCOPES = 256
const DEFAULT_MAX_FINGERPRINTS_PER_SCOPE = 2_048
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000

declare const reasoningFingerprintBrand: unique symbol
declare const reasoningRecoveryScopeBrand: unique symbol

export type ReasoningFingerprint = string & {
  readonly [reasoningFingerprintBrand]: true
}

export type ReasoningRecoveryScope = string & {
  readonly [reasoningRecoveryScopeBrand]: true
}

interface RecoveryScopeEntry {
  fingerprints: Set<ReasoningFingerprint>
  lastAccessedAt: number
}

export interface ReasoningFilterResult {
  input: ResponsesPayload["input"]
  removedCount: number
}

export interface ReasoningRecoveryRegistryOptions {
  idleTtlMs?: number
  maxFingerprintsPerScope?: number
  maxScopes?: number
  now?: () => number
}

export class ReasoningRecoveryRegistry {
  private readonly entries = new Map<
    ReasoningRecoveryScope,
    RecoveryScopeEntry
  >()
  private readonly idleTtlMs: number
  private readonly maxFingerprintsPerScope: number
  private readonly maxScopes: number
  private readonly now: () => number

  constructor({
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxFingerprintsPerScope = DEFAULT_MAX_FINGERPRINTS_PER_SCOPE,
    maxScopes = DEFAULT_MAX_SCOPES,
    now = Date.now,
  }: ReasoningRecoveryRegistryOptions = {}) {
    this.idleTtlMs = idleTtlMs
    this.maxFingerprintsPerScope = maxFingerprintsPerScope
    this.maxScopes = maxScopes
    this.now = now
  }

  filterKnown(
    scope: ReasoningRecoveryScope | null,
    input: ResponsesPayload["input"],
  ): ReasoningFilterResult {
    if (!scope || !Array.isArray(input)) {
      return { input, removedCount: 0 }
    }

    const now = this.now()
    this.pruneExpired(now)
    const entry = this.entries.get(scope)
    if (!entry) {
      return { input, removedCount: 0 }
    }

    this.touch(scope, entry, now)
    const filtered = input.filter((item) => {
      const fingerprint = fingerprintReasoningItem(item)
      return !fingerprint || !entry.fingerprints.has(fingerprint)
    })
    return {
      input: filtered.length === input.length ? input : filtered,
      removedCount: input.length - filtered.length,
    }
  }

  rememberRejected(
    scope: ReasoningRecoveryScope | null,
    input: ResponsesPayload["input"],
  ): number {
    if (!scope || !Array.isArray(input)) {
      return 0
    }

    const now = this.now()
    this.pruneExpired(now)
    const entry = this.entries.get(scope) ?? {
      fingerprints: new Set<ReasoningFingerprint>(),
      lastAccessedAt: now,
    }
    let added = 0
    for (const item of input) {
      const fingerprint = fingerprintReasoningItem(item)
      if (!fingerprint || entry.fingerprints.has(fingerprint)) {
        continue
      }
      entry.fingerprints.add(fingerprint)
      added += 1
      while (entry.fingerprints.size > this.maxFingerprintsPerScope) {
        const oldest = entry.fingerprints.values().next().value
        if (oldest === undefined) break
        entry.fingerprints.delete(oldest)
      }
    }

    if (entry.fingerprints.size === 0) {
      return 0
    }
    this.touch(scope, entry, now)
    while (this.entries.size > this.maxScopes) {
      const oldestScope = this.entries.keys().next().value
      if (oldestScope === undefined) break
      this.entries.delete(oldestScope)
    }
    return added
  }

  clear(): void {
    this.entries.clear()
  }

  private pruneExpired(now: number): void {
    for (const [scope, entry] of this.entries) {
      if (now - entry.lastAccessedAt >= this.idleTtlMs) {
        this.entries.delete(scope)
      }
    }
  }

  private touch(
    scope: ReasoningRecoveryScope,
    entry: RecoveryScopeEntry,
    now: number,
  ): void {
    entry.lastAccessedAt = now
    this.entries.delete(scope)
    this.entries.set(scope, entry)
  }
}

export const responsesReasoningRecoveryRegistry =
  new ReasoningRecoveryRegistry()

export const createReasoningRecoveryScope = ({
  agentId,
  agentType,
  model,
  sessionId,
}: {
  agentId?: string
  agentType?: string
  model: string
  sessionId?: string
}): ReasoningRecoveryScope | null => {
  if (!sessionId) return null
  return hashValue(
    JSON.stringify([sessionId, model, agentType ?? "main", agentId ?? "main"]),
  ) as ReasoningRecoveryScope
}

const fingerprintReasoningItem = (
  item: ResponseInputItem,
): ReasoningFingerprint | null => {
  if (!isRecord(item) || item.type !== "reasoning") {
    return null
  }

  const encryptedContent = item.encrypted_content
  if (typeof encryptedContent === "string" && encryptedContent.length > 0) {
    return hashValue(`encrypted:${encryptedContent}`) as ReasoningFingerprint
  }

  const id = item.id
  if (typeof id === "string" && id.length > 0) {
    return hashValue(`id:${id}`) as ReasoningFingerprint
  }
  return null
}

const hashValue = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
