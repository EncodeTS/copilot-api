import { randomBytes } from "node:crypto"

import {
  estimateResponsesInputTokens,
  responsesTokenEstimateDependencies,
} from "../../src/routes/messages/prepared-messages/token-estimation"
import type { ResponsesPayload } from "../../src/services/copilot/create-responses"
import type { Model } from "../../src/services/copilot/get-models"
import { assertBenchmarkCounterCaps, runBenchmark } from "./harness"

const FIXTURE_BYTES = 4 * 1024 * 1024
const WARMUP_ITERATIONS = 2
const ITERATIONS = 7
const REQUIRED_SPEEDUP = 10

const model = {
  id: "gpt-5.6-sol",
  capabilities: {
    family: "gpt-5.6",
    limits: {},
    object: "model_capabilities",
    supports: { vision: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  model_picker_enabled: true,
  name: "GPT-5.6 Sol",
  object: "model",
  vendor: "OpenAI",
  version: "5.6",
  supported_endpoints: ["/responses"],
} satisfies Model

const randomMedia = randomBytes(FIXTURE_BYTES)
const mediaCarrier = `data:image/png;base64,${randomMedia.toString("base64")}`
const mediaSentinel = mediaCarrier.slice(0, 128)
const randomText = randomBytes(FIXTURE_BYTES)
  .toString("base64")
  .slice(0, FIXTURE_BYTES)

const mediaPayload = {
  model: model.id,
  input: [
    {
      role: "user",
      type: "message",
      content: [
        { type: "input_image", detail: "auto", image_url: mediaCarrier },
      ],
    },
  ],
} satisfies ResponsesPayload

const textPayload = {
  model: model.id,
  input: randomText,
} satisfies ResponsesPayload

const media = await runBenchmark({
  fixture: randomMedia,
  iterations: ITERATIONS,
  name: "responses-4mib-random-media-estimate",
  run: async ({ counters }) => {
    const countTexts = responsesTokenEstimateDependencies.countTexts
    responsesTokenEstimateDependencies.countTexts = (
      texts,
      encoding,
      signal,
    ) => {
      for (const text of texts) {
        if (text.includes(mediaSentinel)) {
          counters.add("tokenizerMediaBytes", Buffer.byteLength(text, "utf8"))
        }
      }
      return countTexts(texts, encoding, signal)
    }
    try {
      await estimateResponsesInputTokens(mediaPayload, model)
    } finally {
      responsesTokenEstimateDependencies.countTexts = countTexts
    }
  },
  warmupIterations: WARMUP_ITERATIONS,
})

const text = await runBenchmark({
  fixture: randomText,
  iterations: ITERATIONS,
  name: "responses-4mib-random-text-baseline",
  run: async () => {
    await estimateResponsesInputTokens(textPayload, model)
  },
  warmupIterations: WARMUP_ITERATIONS,
})

const speedup = text.timingMilliseconds.median / media.timingMilliseconds.median
assertBenchmarkCounterCaps(media.counters, { tokenizerMediaBytes: 0 })
if (!Number.isFinite(speedup) || speedup < REQUIRED_SPEEDUP) {
  throw new Error(
    `Responses media estimate speedup ${speedup.toFixed(2)}x is below ${REQUIRED_SPEEDUP}x`,
  )
}

console.log(
  JSON.stringify(
    {
      media,
      requiredSpeedup: REQUIRED_SPEEDUP,
      speedup,
      text,
    },
    null,
    2,
  ),
)
