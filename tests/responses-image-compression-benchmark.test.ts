import { expect, test } from "bun:test"

import { runResponsesImageCompressionBenchmark } from "../scripts/benchmarks/responses-image-compression"

test("image compression benchmark enforces structural caps without an absolute clock gate", async () => {
  const report = await runResponsesImageCompressionBenchmark({
    commit: "1111111111111111111111111111111111111111",
    iterations: 1,
    warmupIterations: 0,
  })

  expect(report.name).toBe("responses-image-compression-runtime")
  expect(report.counters.decodedBuffers).toBe(16)
  expect(report.counters.cacheWeightBytes).toBeLessThanOrEqual(8192)
  expect(report.counters.queuedBytes).toBeLessThanOrEqual(8192)
  expect(report.timingMilliseconds.median).toBeGreaterThanOrEqual(0)
})
