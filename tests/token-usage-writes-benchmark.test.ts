import { describe, expect, test } from "bun:test"

import {
  runTokenUsageWriteBenchmarks,
  TOKEN_USAGE_WRITE_BENCHMARK_BURST_SIZES,
} from "../scripts/benchmarks/token-usage-writes"

describe("token usage write benchmark", () => {
  test("records a drain cost that does not scale linearly with burst size", async () => {
    const reports = await runTokenUsageWriteBenchmarks({
      commit: "1111111111111111111111111111111111111111",
      iterations: 3,
      warmupIterations: 1,
    })

    expect(reports.map((report) => report.name)).toEqual(
      TOKEN_USAGE_WRITE_BENCHMARK_BURST_SIZES.map(
        (size) => `token-usage-writes-${size}`,
      ),
    )

    for (const report of reports) {
      expect(report.counters.rssBytes).toBeGreaterThan(0)
      expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
      expect(report.timingMilliseconds.p95).toBeGreaterThanOrEqual(0)
    }

    // The behavioural guarantee behind the timing — one prepared statement and
    // one transaction per burst — is asserted deterministically in
    // tests/token-usage.test.ts. Timing is not asserted here because a loaded
    // CI runner makes wall-clock comparisons flaky.
    const largest = reports.at(-1)
    expect(largest?.counters.serializations).toBeGreaterThan(0)
  })
})
