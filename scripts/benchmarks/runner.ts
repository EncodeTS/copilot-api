import { createHash } from "node:crypto"
import { arch, platform, release } from "node:os"

import { resolveGitCommit } from "../lib/git"
import { BenchmarkCounters } from "./counters"
import type { BenchmarkReport } from "./types"

export interface BenchmarkIterationContext {
  counters: BenchmarkCounters
  iteration: number
  phase: "measure" | "warmup"
}

export interface RunBenchmarkOptions {
  clock?: () => number
  commit?: string
  counters?: BenchmarkCounters
  fixture: string | Uint8Array
  iterations: number
  name: string
  repository?: string
  run: (context: BenchmarkIterationContext) => Promise<void> | void
  warmupIterations: number
}

function validateIterations(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function validateCommit(commit: string): void {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("benchmark commit must be a full Git commit SHA")
  }
}

function fixtureHash(fixture: string | Uint8Array): string {
  return createHash("sha256").update(fixture).digest("hex")
}

function median(sortedDurations: number[]): number {
  const middle = Math.floor(sortedDurations.length / 2)
  if (sortedDurations.length % 2 === 1) {
    return sortedDurations[middle] ?? 0
  }

  return (
    ((sortedDurations[middle - 1] ?? 0) + (sortedDurations[middle] ?? 0)) / 2
  )
}

function percentile95(sortedDurations: number[]): number {
  const index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)
  return sortedDurations[index] ?? 0
}

export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  validateIterations(options.warmupIterations, "warmupIterations")
  validateIterations(options.iterations, "iterations")
  if (options.iterations === 0) {
    throw new Error("iterations must be greater than zero")
  }

  const commit =
    options.commit ?? resolveGitCommit(options.repository ?? process.cwd())
  validateCommit(commit)
  const counters = options.counters ?? new BenchmarkCounters()
  const clock = options.clock ?? performance.now.bind(performance)

  for (
    let iteration = 0;
    iteration < options.warmupIterations;
    iteration += 1
  ) {
    await options.run({ counters, iteration, phase: "warmup" })
  }

  counters.reset()
  const durations: number[] = []
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const startedAt = clock()
    await options.run({ counters, iteration, phase: "measure" })
    const duration = clock() - startedAt
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error("benchmark clock produced an invalid duration")
    }
    durations.push(duration)
  }

  durations.sort((left, right) => left - right)

  return {
    counters: counters.snapshot(),
    metadata: {
      architecture: arch(),
      bun: Bun.version,
      commit,
      fixtureSha256: fixtureHash(options.fixture),
      iterations: options.iterations,
      os: `${platform()} ${release()}`,
      warmupIterations: options.warmupIterations,
    },
    name: options.name,
    schemaVersion: 1,
    timingMilliseconds: {
      median: median(durations),
      p95: percentile95(durations),
    },
  }
}
