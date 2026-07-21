import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ResponsesPayload } from "../../src/services/copilot/create-responses"

import { BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

export const RESPONSES_IMAGE_BENCHMARK_COUNTS = [0, 1, 8, 24, 40, 64] as const

export interface ResponsesImageBudgetBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

export const runResponsesImageBudgetBenchmarks = async (
  options: ResponsesImageBudgetBenchmarkOptions = {},
): Promise<Array<BenchmarkReport>> => {
  process.env.COPILOT_API_HOME ??= join(
    tmpdir(),
    `copilot-api-image-budget-benchmark-${process.pid}`,
  )
  const { prepareCopilotResponsesPayloadForSend } = await import(
    "../../src/routes/responses/optimized-create"
  )
  const reports: Array<BenchmarkReport> = []
  for (const imageCount of RESPONSES_IMAGE_BENCHMARK_COUNTS) {
    const fixture = createImageBudgetFixture(imageCount)
    const counters = new BenchmarkCounters()
    reports.push(
      await runBenchmark({
        commit: options.commit,
        counters,
        fixture: JSON.stringify({ imageCount }),
        iterations: options.iterations ?? 5,
        name: `responses-image-budget-${imageCount}`,
        run: async ({ counters: iterationCounters }) => {
          const prepared = await prepareCopilotResponsesPayloadForSend(
            fixture,
            {
              createResponses: (() => {
                throw new Error("benchmark preparation must not dispatch")
              }) as never,
              maxInputImageBytesOverride: Number.MAX_SAFE_INTEGER,
              mode: "normal",
              requestOptions: {
                initiator: "user",
                requestId: "benchmark-request",
                transport: "http",
                vision: imageCount > 0,
              },
            },
          )
          const result = prepared.imageBudget
          iterationCounters.add(
            "decodedBuffers",
            result.budgetInstrumentation.decodedBuffers,
          )
          iterationCounters.add("clones", result.budgetInstrumentation.clones)
          iterationCounters.add(
            "serializations",
            result.budgetInstrumentation.serializations,
          )
          iterationCounters.add(
            "traversals",
            result.budgetInstrumentation.traversals,
          )
          iterationCounters.observe("rssBytes", process.memoryUsage().rss)
        },
        warmupIterations: options.warmupIterations ?? 2,
      }),
    )
  }
  return reports
}

const createImageBudgetFixture = (imageCount: number): ResponsesPayload =>
  ({
    input: Array.from({ length: imageCount }, (_, index) => ({
      content: [
        { text: `image ${index}`, type: "input_text" as const },
        {
          detail: "low" as const,
          image_url: `data:image/png;base64,${"A".repeat(64)}`,
          type: "input_image" as const,
        },
      ],
      role: "user" as const,
    })),
    model: "benchmark-model",
  }) as ResponsesPayload

if (import.meta.main) {
  console.log(
    JSON.stringify(await runResponsesImageBudgetBenchmarks(), null, 2),
  )
}
