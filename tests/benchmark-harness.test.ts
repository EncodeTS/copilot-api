import { describe, expect, test } from "bun:test"

import {
  BenchmarkCounters,
  assertBenchmarkCounterCaps,
  benchmarkCounterDescriptors,
  evaluateRelativeTimingRegression,
  runBenchmark,
  type BenchmarkReport,
} from "../scripts/benchmarks/harness"

const commit = "1111111111111111111111111111111111111111"

describe("benchmark harness", () => {
  test("records reproducible metadata, robust timings, and measured counters", async () => {
    const counters = new BenchmarkCounters()
    const clockValues = [0, 10, 10, 30, 30, 60, 60, 100, 100, 200]
    let clockIndex = 0

    const report = await runBenchmark({
      clock: () => clockValues[clockIndex++] ?? 0,
      commit,
      counters,
      fixture: "abc",
      iterations: 5,
      name: "deterministic-fixture",
      run: ({ counters: iterationCounters }) => {
        iterationCounters.add("tokenizerMediaBytes", 3)
        iterationCounters.add("decodedBuffers")
      },
      warmupIterations: 2,
    })

    expect(report.metadata.fixtureSha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(report.metadata.commit).toBe(commit)
    expect(report.metadata.bun).toBe(Bun.version)
    expect(report.metadata.os.length).toBeGreaterThan(0)
    expect(report.metadata.architecture.length).toBeGreaterThan(0)
    expect(report.metadata.warmupIterations).toBe(2)
    expect(report.timingMilliseconds).toEqual({ median: 30, p95: 100 })
    expect(report.counters.tokenizerMediaBytes).toBe(15)
    expect(report.counters.decodedBuffers).toBe(5)
    expect(JSON.stringify(report)).not.toContain('"fixture":"abc"')
  })

  test("hard-fails structural counter caps without a clock threshold", () => {
    const counters = new BenchmarkCounters()
    counters.add("serializations", 3)
    counters.observe("queuedBytes", 4096)

    expect(() =>
      assertBenchmarkCounterCaps(counters.snapshot(), {
        queuedBytes: 4096,
        serializations: 2,
      }),
    ).toThrow("serializations counter 3 exceeds structural cap 2")
  })

  test("declares cumulative and peak counter semantics", () => {
    expect(benchmarkCounterDescriptors).toContainEqual({
      aggregation: "cumulative",
      name: "decodedBuffers",
      unit: "count",
    })
    expect(benchmarkCounterDescriptors).toContainEqual({
      aggregation: "peak",
      name: "cacheWeightBytes",
      unit: "bytes",
    })
    expect(benchmarkCounterDescriptors).toContainEqual({
      aggregation: "peak",
      name: "sockets",
      unit: "count",
    })
    expect(benchmarkCounterDescriptors).toContainEqual({
      aggregation: "peak",
      name: "frames",
      unit: "count",
    })
    expect(benchmarkCounterDescriptors).toContainEqual({
      aggregation: "peak",
      name: "queuedBytes",
      unit: "bytes",
    })

    const counters = new BenchmarkCounters()
    counters.observe("frames", 8)
    counters.observe("frames", 3)
    expect(counters.snapshot().frames).toBe(8)
  })

  test("requires repeated same-runner evidence for relative timing regression", () => {
    const baseline = createReport(100, 120)
    const twoRegressions = [createReport(125, 150), createReport(130, 155)]
    const threeRegressions = [...twoRegressions, createReport(128, 151)]

    const insufficient = evaluateRelativeTimingRegression(
      baseline,
      twoRegressions,
      {
        metric: "median",
        relativeThreshold: 0.2,
        requiredRuns: 3,
      },
    )
    expect(insufficient).toMatchObject({
      receivedRuns: 2,
      requiredRuns: 3,
      status: "insufficient-runs",
    })
    expect("regressed" in insufficient).toBe(false)

    expect(
      evaluateRelativeTimingRegression(baseline, threeRegressions, {
        metric: "median",
        relativeThreshold: 0.2,
        requiredRuns: 3,
      }),
    ).toMatchObject({ regressed: true, status: "evaluated" })

    const differentRunner = createReport(140, 170)
    differentRunner.metadata.architecture = "different-architecture"
    expect(
      evaluateRelativeTimingRegression(
        baseline,
        [...twoRegressions, differentRunner],
        {
          metric: "median",
          relativeThreshold: 0.2,
          requiredRuns: 3,
        },
      ),
    ).toMatchObject({ status: "incomparable" })
  })

  test("defaults to the project 20 percent and three-run regression policy", () => {
    const baseline = createReport(100, 120)
    const candidates = [
      createReport(121, 145),
      createReport(125, 150),
      createReport(130, 160),
    ]

    expect(
      evaluateRelativeTimingRegression(baseline, candidates),
    ).toMatchObject({ regressed: true, status: "evaluated" })
    expect(
      evaluateRelativeTimingRegression(baseline, candidates.slice(0, 2)),
    ).toMatchObject({ status: "insufficient-runs" })
  })

  test("allows stricter overrides but rejects policy relaxation", () => {
    const baseline = createReport(100, 120)
    const candidates = [
      createReport(111, 135),
      createReport(112, 136),
      createReport(113, 137),
      createReport(114, 138),
    ]

    expect(
      evaluateRelativeTimingRegression(baseline, candidates, {
        relativeThreshold: 0.1,
        requiredRuns: 4,
      }),
    ).toMatchObject({ regressed: true, status: "evaluated" })
    expect(() =>
      evaluateRelativeTimingRegression(baseline, candidates, {
        relativeThreshold: 0.21,
      }),
    ).toThrow("relativeThreshold must be between 0 and the project maximum 0.2")
    expect(() =>
      evaluateRelativeTimingRegression(baseline, candidates, {
        requiredRuns: 2,
      }),
    ).toThrow("requiredRuns must be at least 3")
  })
})

function createReport(median: number, p95: number): BenchmarkReport {
  return {
    counters: {
      cacheWeightBytes: 0,
      clones: 0,
      decodedBuffers: 0,
      frames: 0,
      queuedBytes: 0,
      rssBytes: 0,
      serializations: 0,
      sockets: 0,
      tokenizerMediaBytes: 0,
      traversals: 0,
    },
    metadata: {
      architecture: "arm64",
      bun: "1.3.14",
      commit,
      fixtureSha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      iterations: 5,
      os: "darwin 25.0.0",
      warmupIterations: 2,
    },
    name: "deterministic-fixture",
    schemaVersion: 1,
    timingMilliseconds: { median, p95 },
  }
}
