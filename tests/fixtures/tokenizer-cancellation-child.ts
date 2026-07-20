import {
  getTokenCount,
  type TokenizerSchedulingOptions,
  type TokenizerYieldControl,
} from "../../src/lib/tokenizer"
import {
  getTokenizerWorkerLoadSnapshot,
  type TokenizerWorkerLoadSnapshot,
} from "../../src/lib/tokenizer-worker-client"
import type { Model } from "../../src/services/copilot/get-models"

type YieldRequiresSignal =
  { yieldControl: TokenizerYieldControl } extends TokenizerSchedulingOptions ?
    false
  : true
const yieldRequiresSignal: YieldRequiresSignal = true
void yieldRequiresSignal

export interface TokenizerCancellationFixtureResult {
  afterColdCancellation: TokenizerWorkerLoadSnapshot
  afterCompletion: TokenizerWorkerLoadSnapshot
  afterWarmCancellation: TokenizerWorkerLoadSnapshot
  coldAborted: boolean
  coldPending: TokenizerWorkerLoadSnapshot | undefined
  coldYieldCalls: number
  exactCount: { input: number; output: number }
  initial: TokenizerWorkerLoadSnapshot
  warmAborted: boolean
  warmPending: TokenizerWorkerLoadSnapshot | undefined
  warmYieldCalls: number
}

const model = {
  id: "gpt-5",
  capabilities: { tokenizer: "o200k_base" },
} as Model

await getTokenCount(
  { messages: [{ content: "warm", role: "user" }], model: model.id },
  model,
)

const messages = Array.from({ length: 4_000 }, () => ({
  content: "hello",
  role: "user" as const,
}))
const payload = { messages, model: model.id }
const initial = getTokenizerWorkerLoadSnapshot()
const coldController = new AbortController()
const coldReason = new Error("cancel repeated tokenization")
let coldThrown: unknown
let coldPending: TokenizerWorkerLoadSnapshot | undefined
let coldYieldCalls = 0

try {
  await getTokenCount(payload, model, {
    signal: coldController.signal,
    yieldControl: () => {
      coldYieldCalls += 1
      coldPending = getTokenizerWorkerLoadSnapshot()
      coldController.abort(coldReason)
      return Promise.resolve()
    },
  })
} catch (error) {
  coldThrown = error
}
const afterColdCancellation = getTokenizerWorkerLoadSnapshot()

const exactCount = await getTokenCount(payload, model, {
  signal: new AbortController().signal,
})
const afterCompletion = getTokenizerWorkerLoadSnapshot()
const warmController = new AbortController()
const warmReason = "cancel warm tokenization"
let warmThrown: unknown
let warmPending: TokenizerWorkerLoadSnapshot | undefined
let warmYieldCalls = 0

try {
  await getTokenCount(payload, model, {
    signal: warmController.signal,
    yieldControl: () => {
      warmYieldCalls += 1
      warmPending = getTokenizerWorkerLoadSnapshot()
      warmController.abort(warmReason)
      return Promise.resolve()
    },
  })
} catch (error) {
  warmThrown = error
}
const afterWarmCancellation = getTokenizerWorkerLoadSnapshot()

const result: TokenizerCancellationFixtureResult = {
  afterColdCancellation,
  afterCompletion,
  afterWarmCancellation,
  coldAborted: coldThrown === coldReason,
  coldPending,
  coldYieldCalls,
  exactCount,
  initial,
  warmAborted: warmThrown === warmReason,
  warmPending,
  warmYieldCalls,
}
console.log(JSON.stringify(result))
