import { describe, expect, test } from "bun:test"

import {
  PREPARED_MESSAGES_BENCHMARK_TURN_COUNTS,
  runPreparedMessagesBenchmarks,
} from "../scripts/benchmarks/prepared-messages-clones"

describe("prepared messages clone benchmark", () => {
  test("records one whole-payload deep copy per count request", async () => {
    // Counters are cumulative across iterations, so a single iteration makes
    // the reported count the per-request count.
    const reports = await runPreparedMessagesBenchmarks({
      commit: "1111111111111111111111111111111111111111",
      iterations: 1,
      warmupIterations: 0,
    })

    expect(reports.map((report) => report.name)).toEqual(
      PREPARED_MESSAGES_BENCHMARK_TURN_COUNTS.map(
        (turns) => `prepared-messages-count-${turns}`,
      ),
    )

    for (const report of reports) {
      // Was 3 before ticket 06: mapPayloadModel cloned the payload only to
      // overwrite `model` and preparePlan immediately cloned that again, and
      // requestIdentityPayload cloned a third time to preserve one string.
      // Only preparePlan's defensive copy of the caller's payload remains.
      expect(report.counters.clones).toBe(1)
      expect(report.counters.traversals).toBe(1)
      expect(report.counters.rssBytes).toBeGreaterThan(0)
      expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
      expect(report.timingMilliseconds.p95).toBeGreaterThanOrEqual(0)
    }
  })
})
