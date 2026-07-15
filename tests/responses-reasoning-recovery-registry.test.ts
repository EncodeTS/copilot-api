import { expect, test } from "bun:test"

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
