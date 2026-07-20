import {
  countTextsInTokenizerWorker,
  getTokenizerWorkerLoadSnapshot,
  tokenizerWorkerClientDependencies,
  type TokenizerWorkerLoadSnapshot,
  type TokenizerWorkerTransport,
} from "../../src/lib/tokenizer-worker-client"

type WorkerBehavior = "complete" | "exit" | "malformed"

interface TokenizerWorkerRequest {
  id: number
  texts: Array<string>
}

export interface TokenizerWorkerLivenessFixtureResult {
  exitActiveError: string | undefined
  exitQueuedCounts: Array<number> | undefined
  exitSnapshot: TokenizerWorkerLoadSnapshot
  malformedActiveError: string | undefined
  malformedQueuedCounts: Array<number> | undefined
  malformedSnapshot: TokenizerWorkerLoadSnapshot
  malformedWorkerTerminated: boolean
  workersCreated: number
}

class FakeTokenizerWorker implements TokenizerWorkerTransport {
  readonly behaviors: Array<WorkerBehavior>
  terminated = false

  private readonly errorListeners = new Array<(error: Error) => void>()
  private readonly exitListeners = new Array<(code: number) => void>()
  private readonly messageListeners = new Array<(value: unknown) => void>()

  constructor(behaviors: Array<WorkerBehavior>) {
    this.behaviors = [...behaviors]
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener)
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListeners.push(listener)
  }

  postMessage(value: unknown): void {
    const request = value as TokenizerWorkerRequest
    const behavior = this.behaviors.shift()
    if (!behavior) throw new Error("Fake tokenizer worker has no behavior")

    queueMicrotask(() => {
      if (behavior === "malformed") {
        for (const listener of this.messageListeners) {
          listener({ counts: "invalid", id: request.id })
        }
        return
      }
      if (behavior === "exit") {
        for (const listener of this.exitListeners) listener(0)
        return
      }
      for (const listener of this.messageListeners) {
        listener({
          counts: request.texts.map(() => 1),
          id: request.id,
        })
      }
    })
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }

  unref(): void {}
}

export const runTokenizerWorkerLivenessFixture =
  async (): Promise<TokenizerWorkerLivenessFixtureResult> => {
    const workerPlans: Array<Array<WorkerBehavior>> = [
      ["malformed"],
      ["complete", "exit"],
      ["complete"],
    ]
    const workers = new Array<FakeTokenizerWorker>()
    const originalCreateWorker = tokenizerWorkerClientDependencies.createWorker
    tokenizerWorkerClientDependencies.createWorker = () => {
      const plan = workerPlans[workers.length]
      if (!plan) throw new Error("Unexpected tokenizer worker creation")
      const worker = new FakeTokenizerWorker(plan)
      workers.push(worker)
      return worker
    }

    let malformedActiveError: string | undefined
    let malformedQueuedCounts: Array<number> | undefined
    let exitActiveError: string | undefined
    let exitQueuedCounts: Array<number> | undefined
    let malformedSnapshot: TokenizerWorkerLoadSnapshot
    let exitSnapshot: TokenizerWorkerLoadSnapshot

    try {
      const malformedActive = countTextsInTokenizerWorker(
        ["malformed active"],
        "o200k_base",
        new AbortController().signal,
      )
      void malformedActive.catch(() => undefined)
      const malformedQueued = countTextsInTokenizerWorker(
        ["malformed queued"],
        "o200k_base",
        new AbortController().signal,
      )
      try {
        await malformedActive
      } catch (error) {
        malformedActiveError =
          error instanceof Error ? error.message : String(error)
      }
      malformedQueuedCounts = await malformedQueued
      malformedSnapshot = getTokenizerWorkerLoadSnapshot()

      const exitActive = countTextsInTokenizerWorker(
        ["exit active"],
        "o200k_base",
        new AbortController().signal,
      )
      void exitActive.catch(() => undefined)
      const exitQueued = countTextsInTokenizerWorker(
        ["exit queued"],
        "o200k_base",
        new AbortController().signal,
      )
      try {
        await exitActive
      } catch (error) {
        exitActiveError = error instanceof Error ? error.message : String(error)
      }
      exitQueuedCounts = await exitQueued
      exitSnapshot = getTokenizerWorkerLoadSnapshot()
    } finally {
      tokenizerWorkerClientDependencies.createWorker = originalCreateWorker
    }

    return {
      exitActiveError,
      exitQueuedCounts,
      exitSnapshot,
      malformedActiveError,
      malformedQueuedCounts,
      malformedSnapshot,
      malformedWorkerTerminated: workers[0]?.terminated ?? false,
      workersCreated: workers.length,
    }
  }
