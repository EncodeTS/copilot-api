import { describe, expect, test } from "bun:test"

import {
  IMAGE_LEDGER_BENCHMARK_IMAGE_COUNTS,
  runImageLedgerBenchmarks,
} from "../scripts/benchmarks/responses-image-ledger"

describe("Responses image ledger benchmark", () => {
  test("keeps serializations flat as the image count grows", async () => {
    // Counters are cumulative across iterations, so a single iteration makes
    // the reported count the per-request count.
    const reports = await runImageLedgerBenchmarks({
      commit: "1111111111111111111111111111111111111111",
      iterations: 1,
      warmupIterations: 0,
    })

    expect(reports.map((report) => report.name)).toEqual(
      IMAGE_LEDGER_BENCHMARK_IMAGE_COUNTS.map(
        (count) => `responses-image-ledger-${count}`,
      ),
    )

    // Before ticket 05 this was imageCount + 1, because the per-candidate
    // reconcile re-serialized the entire payload to verify a delta the caller
    // had already computed. The remaining serializations are the initial one
    // and the single terminal verification.
    const serializationCounts = reports.map(
      (report) => report.counters.serializations,
    )
    expect(new Set(serializationCounts).size).toBe(1)
    expect(serializationCounts[0]).toBeLessThanOrEqual(3)

    for (const report of reports) {
      expect(report.counters.rssBytes).toBeGreaterThan(0)
      expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
    }
  })
})
