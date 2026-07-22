import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ResponseInputItem } from "../src/services/copilot/create-responses"
import {
  createReasoningRecoveryScope,
  ReasoningRecoveryRegistry,
} from "../src/services/copilot/responses-reasoning-recovery-registry"

const reasoning = (encryptedContent: string): ResponseInputItem => ({
  encrypted_content: encryptedContent,
  type: "reasoning",
})

const scope = (sessionId: string) =>
  createReasoningRecoveryScope({ model: "gpt-test", sessionId })!

test("reasoning recovery scopes isolate sessions, models, and subagents", () => {
  const scopes = [
    createReasoningRecoveryScope({ model: "gpt-a", sessionId: "session-a" }),
    createReasoningRecoveryScope({ model: "gpt-b", sessionId: "session-a" }),
    createReasoningRecoveryScope({ model: "gpt-a", sessionId: "session-b" }),
    createReasoningRecoveryScope({
      agentId: "agent-a",
      agentType: "review",
      model: "gpt-a",
      sessionId: "session-a",
    }),
  ]

  expect(new Set(scopes).size).toBe(4)
  expect(createReasoningRecoveryScope({ model: "gpt-a" })).toBeNull()
})

test("reasoning recovery registry expires idle scopes", () => {
  let now = 0
  const registry = new ReasoningRecoveryRegistry({
    idleTtlMs: 10,
    now: () => now,
  })
  const input = [reasoning("old")]
  const recoveryScope = scope("ttl")
  registry.rememberRejected(recoveryScope, input)

  now = 10

  expect(registry.filterKnown(recoveryScope, input)).toEqual({
    input,
    removedCount: 0,
  })
})

test("reasoning recovery registry evicts the least recently used scope", () => {
  const registry = new ReasoningRecoveryRegistry({ maxScopes: 2 })
  const first = [reasoning("first")]
  const second = [reasoning("second")]
  const third = [reasoning("third")]
  const firstScope = scope("lru-1")
  const secondScope = scope("lru-2")
  const thirdScope = scope("lru-3")
  registry.rememberRejected(firstScope, first)
  registry.rememberRejected(secondScope, second)
  registry.filterKnown(firstScope, first)
  registry.rememberRejected(thirdScope, third)

  expect(registry.filterKnown(firstScope, first).removedCount).toBe(1)
  expect(registry.filterKnown(secondScope, second).removedCount).toBe(0)
  expect(registry.filterKnown(thirdScope, third).removedCount).toBe(1)
})

test("reasoning recovery registry bounds fingerprints per scope", () => {
  const registry = new ReasoningRecoveryRegistry({
    maxFingerprintsPerScope: 2,
  })
  const first = reasoning("first")
  const second = reasoning("second")
  const third = reasoning("third")
  const recoveryScope = scope("fingerprint-limit")
  registry.rememberRejected(recoveryScope, [first, second, third])

  expect(registry.filterKnown(recoveryScope, [first, second, third])).toEqual({
    input: [first],
    removedCount: 2,
  })
})

test("reasoning recovery registry restores hashed state after restart", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-api-recovery-"),
  )
  const persistencePath = path.join(tempDir, "reasoning-recovery.json")
  const recoveryScope = scope("restart-persist")
  const rejected = reasoning("legacy-encrypted-reasoning")
  const secondRejected = reasoning("second-legacy-encrypted-reasoning")
  const fresh = reasoning("fresh-encrypted-reasoning")

  try {
    const firstProcess = new ReasoningRecoveryRegistry({ persistencePath })
    firstProcess.rememberRejected(recoveryScope, [rejected])
    await firstProcess.flush()
    firstProcess.rememberRejected(recoveryScope, [secondRejected])
    await firstProcess.flush()

    const secondProcess = new ReasoningRecoveryRegistry({ persistencePath })
    await secondProcess.initialize()

    expect(
      secondProcess.filterKnown(recoveryScope, [
        rejected,
        secondRejected,
        fresh,
      ]),
    ).toEqual({
      input: [fresh],
      removedCount: 2,
    })

    const persisted = await fs.readFile(persistencePath, "utf8")
    expect(persisted).not.toContain("restart-persist")
    expect(persisted).not.toContain("gpt-test")
    expect(persisted).not.toContain("legacy-encrypted-reasoning")
    expect(persisted).not.toContain("second-legacy-encrypted-reasoning")
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true })
  }
})

test("reasoning recovery registry falls back to memory after persistence errors", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-api-recovery-"),
  )
  const recoveryScope = scope("persistence-fallback")
  const rejected = reasoning("rejected-after-storage-error")
  let persistenceErrors = 0

  try {
    const registry = new ReasoningRecoveryRegistry({
      onPersistenceError: () => {
        persistenceErrors += 1
      },
      persistencePath: tempDir,
    })

    await registry.initialize()
    registry.rememberRejected(recoveryScope, [rejected])
    await registry.flush()
    await registry.flush()

    expect(registry.filterKnown(recoveryScope, [rejected]).removedCount).toBe(1)
    expect(persistenceErrors).toBe(1)
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true })
  }
})

test("reasoning recovery registry checkpoints active scope access times", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-api-recovery-"),
  )
  const persistencePath = path.join(tempDir, "reasoning-recovery.json")
  const recoveryScope = scope("active-persisted-ttl")
  const rejected = reasoning("active-rejected-reasoning")
  let now = 0

  try {
    const activeProcess = new ReasoningRecoveryRegistry({
      idleTtlMs: 10,
      now: () => now,
      persistencePath,
      persistenceTouchIntervalMs: 5,
    })
    activeProcess.rememberRejected(recoveryScope, [rejected])
    await activeProcess.flush()

    now = 6
    expect(
      activeProcess.filterKnown(recoveryScope, [rejected]).removedCount,
    ).toBe(1)
    await activeProcess.flush()

    now = 12
    const restartedProcess = new ReasoningRecoveryRegistry({
      idleTtlMs: 10,
      now: () => now,
      persistencePath,
      persistenceTouchIntervalMs: 5,
    })
    await restartedProcess.initialize()

    expect(
      restartedProcess.filterKnown(recoveryScope, [rejected]).removedCount,
    ).toBe(1)
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true })
  }
})
