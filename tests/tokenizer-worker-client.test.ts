import { expect, test } from "bun:test"

import type { SupportedEncoding } from "../src/lib/tokenizer-encodings"
import {
  closeIdleTokenizerWorker,
  countTextsInTokenizerWorker,
  getTokenizerWorkerLoadSnapshot,
} from "../src/lib/tokenizer-worker-client"
import { runTokenizerWorkerLivenessFixture } from "./fixtures/tokenizer-worker-liveness"

const emptySnapshot = {
  activeJobs: 0,
  pendingCodeUnits: 0,
  pendingJobs: 0,
  queuedJobs: 0,
}

test("tokenizer worker load accounts a job through completion", async () => {
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
  const pending = countTextsInTokenizerWorker(
    ["hello"],
    "o200k_base",
    new AbortController().signal,
  )

  expect(getTokenizerWorkerLoadSnapshot()).toEqual({
    activeJobs: 1,
    pendingCodeUnits: 5,
    pendingJobs: 1,
    queuedJobs: 0,
  })
  await pending
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
})

test("tokenizer worker load accounts queued and active cancellation", async () => {
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
  const activeController = new AbortController()
  const activeReason = new Error("cancel active worker job")
  const active = countTextsInTokenizerWorker(
    ["active"],
    "o200k_base",
    activeController.signal,
  )
  void active.catch(() => undefined)
  const queuedController = new AbortController()
  const queuedReason = "cancel queued worker job"
  const queued = countTextsInTokenizerWorker(
    ["queued"],
    "o200k_base",
    queuedController.signal,
  )
  void queued.catch(() => undefined)

  expect(getTokenizerWorkerLoadSnapshot()).toEqual({
    activeJobs: 1,
    pendingCodeUnits: 12,
    pendingJobs: 2,
    queuedJobs: 1,
  })
  queuedController.abort(queuedReason)
  expect(getTokenizerWorkerLoadSnapshot()).toEqual({
    activeJobs: 1,
    pendingCodeUnits: 6,
    pendingJobs: 1,
    queuedJobs: 0,
  })
  activeController.abort(activeReason)

  let activeThrown: unknown
  let queuedThrown: unknown
  try {
    await active
  } catch (error) {
    activeThrown = error
  }
  try {
    await queued
  } catch (error) {
    queuedThrown = error
  }
  expect(activeThrown).toBe(activeReason)
  expect(queuedThrown).toBe(queuedReason)
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
})

test("tokenizer worker load clears a failed job", async () => {
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
  const failed = countTextsInTokenizerWorker(
    ["failure fixture"],
    "unsupported_fixture_encoding" as SupportedEncoding,
    new AbortController().signal,
  )
  void failed.catch(() => undefined)
  const queued = countTextsInTokenizerWorker(
    ["hello"],
    "o200k_base",
    new AbortController().signal,
  )
  let thrown: unknown
  try {
    await failed
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(await queued).toEqual([1])
  expect(getTokenizerWorkerLoadSnapshot()).toEqual(emptySnapshot)
})

test("tokenizer worker replaces malformed and gracefully exited workers without stranding queued jobs", async () => {
  await closeIdleTokenizerWorker()
  let result
  try {
    result = await runTokenizerWorkerLivenessFixture()
  } finally {
    await closeIdleTokenizerWorker()
  }

  expect(result).toEqual({
    exitActiveError: "Tokenizer worker exited before completing its active job",
    exitQueuedCounts: [1],
    exitSnapshot: emptySnapshot,
    malformedActiveError: "Tokenizer worker returned an invalid response",
    malformedQueuedCounts: [1],
    malformedSnapshot: emptySnapshot,
    malformedWorkerTerminated: true,
    workersCreated: 3,
  })
})
