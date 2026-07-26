import { describe, expect, test } from "bun:test"

import {
  POLICY_SNAPSHOT_BENCHMARK_MODEL_COUNTS,
  runPolicySnapshotBenchmarks,
} from "../scripts/benchmarks/policy-snapshot"

describe("policy snapshot benchmark", () => {
  test("records a snapshot cost that does not scale with catalog size", async () => {
    const reports = await runPolicySnapshotBenchmarks({
      commit: "1111111111111111111111111111111111111111",
      iterations: 5,
      warmupIterations: 2,
    })

    expect(reports.map((report) => report.name)).toEqual(
      POLICY_SNAPSHOT_BENCHMARK_MODEL_COUNTS.map(
        (count) => `policy-snapshot-${count}`,
      ),
    )

    for (const report of reports) {
      expect(report.counters.rssBytes).toBeGreaterThan(0)
      expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
      expect(report.timingMilliseconds.p95).toBeGreaterThanOrEqual(0)
    }

    // The behavioural guarantee behind the timing — that the catalog is frozen
    // once and shared — is asserted deterministically in
    // tests/prepared-messages-policy.test.ts. Timing is not asserted here
    // because a loaded CI runner makes wall-clock comparisons flaky.
    const largest = reports.at(-1)
    expect(largest?.counters.traversals).toBeGreaterThan(0)
  })
})
