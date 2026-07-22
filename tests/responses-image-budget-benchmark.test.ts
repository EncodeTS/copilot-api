import { describe, expect, test } from "bun:test"

import {
  RESPONSES_IMAGE_BENCHMARK_COUNTS,
  runResponsesImageBudgetBenchmarks,
} from "../scripts/benchmarks/responses-image-budget"

describe("Responses image budget benchmark", () => {
  test("records structure, RSS, and timing for the required image counts", async () => {
    const reports = await runResponsesImageBudgetBenchmarks({
      commit: "1111111111111111111111111111111111111111",
      iterations: 1,
      warmupIterations: 0,
    })

    expect(reports.map((report) => report.name)).toEqual(
      RESPONSES_IMAGE_BENCHMARK_COUNTS.map(
        (count) => `responses-image-budget-${count}`,
      ),
    )
    for (const report of reports) {
      expect(report.counters.traversals).toBe(1)
      expect(report.counters.serializations).toBe(1)
      expect(report.counters.decodedBuffers).toBe(0)
      expect(report.counters.clones).toBe(1)
      expect(report.counters.rssBytes).toBeGreaterThan(0)
      expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
      expect(report.timingMilliseconds.p95).toBeGreaterThanOrEqual(0)
    }
  })
})
