import type { ResponsesPayload } from "../../src/services/copilot/create-responses"

import { BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

export const IMAGE_LEDGER_BENCHMARK_IMAGE_COUNTS = [4, 12, 32, 64] as const

export interface ImageLedgerBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

/**
 * Drives the image budget mutation loop under real budget pressure.
 *
 * The existing `responses-image-budget` benchmark reports one serialization
 * because its fixture never exceeds the budget, so the mutation loop never
 * runs. This one sets a small explicit `budgetBytes` so every image has to be
 * replaced, which is the path where `reconcileImagePayloadLedger` re-serializes
 * the whole payload once per candidate.
 */
export const runImageLedgerBenchmarks = async (
  options: ImageLedgerBenchmarkOptions = {},
): Promise<Array<BenchmarkReport>> => {
  const { optimizeInputImagesForPayloadBudget } = await import(
    "../../src/routes/responses/utils"
  )
  const reports: Array<BenchmarkReport> = []

  for (const imageCount of IMAGE_LEDGER_BENCHMARK_IMAGE_COUNTS) {
    const counters = new BenchmarkCounters()

    reports.push(
      await runBenchmark({
        commit: options.commit,
        counters,
        fixture: JSON.stringify({ imageCount }),
        iterations: options.iterations ?? 5,
        name: `responses-image-ledger-${imageCount}`,
        run: async ({ counters: iterationCounters }) => {
          const result = await optimizeInputImagesForPayloadBudget(
            createOversizedImagePayload(imageCount),
            {
              allowNormalReplacement: true,
              allowReplacingLatestImages: true,
              // Small enough that every image must be replaced.
              budgetBytes: 8 * 1024,
              enabled: true,
              preserveLatestUserImageGroup: false,
              sendHardLimitBytes: 16 * 1024,
            },
          )
          const instrumentation = result.budgetInstrumentation
          iterationCounters.add("clones", instrumentation.clones)
          iterationCounters.add(
            "serializations",
            instrumentation.serializations,
          )
          iterationCounters.add("traversals", instrumentation.traversals)
          iterationCounters.add(
            "decodedBuffers",
            instrumentation.decodedBuffers,
          )
          iterationCounters.observe("rssBytes", process.memoryUsage().rss)
        },
        warmupIterations: options.warmupIterations ?? 2,
      }),
    )
  }

  return reports
}

const IMAGE_BASE64_LENGTH = 4 * 1024

const createOversizedImagePayload = (imageCount: number): ResponsesPayload =>
  ({
    input: Array.from({ length: imageCount }, (_, index) => ({
      content: [
        { text: `image ${index}`, type: "input_text" as const },
        {
          detail: "high" as const,
          image_url: `data:image/png;base64,${"A".repeat(IMAGE_BASE64_LENGTH)}`,
          type: "input_image" as const,
        },
      ],
      role: "user" as const,
    })),
    model: "benchmark-model",
  }) as ResponsesPayload

if (import.meta.main) {
  console.log(JSON.stringify(await runImageLedgerBenchmarks(), null, 2))
}
