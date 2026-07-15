import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import consola from "consola"

import type {
  ResponseInputItem,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

const DEFAULT_MAX_SCOPES = 256
const DEFAULT_MAX_FINGERPRINTS_PER_SCOPE = 2_048
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000
const PERSISTENCE_VERSION = 1
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

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
  onPersistenceError?: (error: unknown) => void
  persistencePath?: string
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
  private readonly onPersistenceError: (error: unknown) => void
  private persistencePath: string | undefined
  private persistPromise: Promise<void> = Promise.resolve()
  private dirty = false
  private persistenceErrorReported = false

  constructor({
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxFingerprintsPerScope = DEFAULT_MAX_FINGERPRINTS_PER_SCOPE,
    maxScopes = DEFAULT_MAX_SCOPES,
    now = Date.now,
    onPersistenceError = () => {},
    persistencePath,
  }: ReasoningRecoveryRegistryOptions = {}) {
    this.idleTtlMs = idleTtlMs
    this.maxFingerprintsPerScope = maxFingerprintsPerScope
    this.maxScopes = maxScopes
    this.now = now
    this.onPersistenceError = onPersistenceError
    this.persistencePath = persistencePath
  }

  async initialize(persistencePath?: string): Promise<void> {
    if (persistencePath) {
      this.persistencePath = persistencePath
    }
    if (!this.persistencePath) return

    try {
      const persisted = JSON.parse(
        await fs.readFile(this.persistencePath, "utf8"),
      ) as unknown
      this.restorePersistedState(persisted)
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        this.reportPersistenceError(error)
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.persistencePath || !this.dirty) {
      await this.persistPromise
      return
    }

    this.dirty = false
    const persistencePath = this.persistencePath
    const snapshot = JSON.stringify(
      {
        scopes: [...this.entries].map(([scope, entry]) => ({
          fingerprints: [...entry.fingerprints],
          lastAccessedAt: entry.lastAccessedAt,
          scope,
        })),
        version: PERSISTENCE_VERSION,
      },
      null,
      2,
    )
    const writePromise = this.persistPromise.then(async () => {
      const directory = path.dirname(persistencePath)
      const temporaryPath = `${persistencePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(temporaryPath, `${snapshot}\n`, {
          encoding: "utf8",
          mode: 0o600,
        })
        await fs.rename(temporaryPath, persistencePath)
      } finally {
        await fs.rm(temporaryPath, { force: true })
      }
    })
    this.persistPromise = writePromise.catch((error: unknown) => {
      this.reportPersistenceError(error)
    })
    await this.persistPromise
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
    this.dirty = true
    void this.flush()
    return added
  }

  clear(): void {
    this.entries.clear()
    this.dirty = true
    void this.flush()
  }

  private restorePersistedState(value: unknown): void {
    if (
      !isRecord(value)
      || value.version !== PERSISTENCE_VERSION
      || !Array.isArray(value.scopes)
    ) {
      return
    }

    const now = this.now()
    const restored: Array<[ReasoningRecoveryScope, RecoveryScopeEntry]> = []
    for (const candidate of value.scopes) {
      if (
        !isRecord(candidate)
        || typeof candidate.scope !== "string"
        || !SHA256_PATTERN.test(candidate.scope)
        || typeof candidate.lastAccessedAt !== "number"
        || !Number.isFinite(candidate.lastAccessedAt)
        || now - candidate.lastAccessedAt >= this.idleTtlMs
        || !Array.isArray(candidate.fingerprints)
      ) {
        continue
      }
      const fingerprints = candidate.fingerprints
        .filter(
          (fingerprint): fingerprint is ReasoningFingerprint =>
            typeof fingerprint === "string" && SHA256_PATTERN.test(fingerprint),
        )
        .slice(-this.maxFingerprintsPerScope)
      if (fingerprints.length === 0) continue
      restored.push([
        candidate.scope as ReasoningRecoveryScope,
        {
          fingerprints: new Set(fingerprints),
          lastAccessedAt: candidate.lastAccessedAt,
        },
      ])
    }

    this.entries.clear()
    for (const [scope, entry] of restored.slice(-this.maxScopes)) {
      this.entries.set(scope, entry)
    }
  }

  private reportPersistenceError(error: unknown): void {
    if (this.persistenceErrorReported) return
    this.persistenceErrorReported = true
    this.onPersistenceError(error)
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

export const responsesReasoningRecoveryRegistry = new ReasoningRecoveryRegistry(
  {
    onPersistenceError: (error) => {
      consola.warn("responses.reasoning_history_persistence_unavailable", {
        message: error instanceof Error ? error.message : String(error),
      })
    },
  },
)

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

const isFileNotFoundError = (error: unknown): boolean =>
  error instanceof Error
  && "code" in error
  && (error as NodeJS.ErrnoException).code === "ENOENT"
