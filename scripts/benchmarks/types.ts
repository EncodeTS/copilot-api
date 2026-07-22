import type { BenchmarkCounterSnapshot } from "./counters"

export interface BenchmarkMetadata {
  architecture: string
  bun: string
  commit: string
  fixtureSha256: string
  iterations: number
  os: string
  warmupIterations: number
}

export interface BenchmarkReport {
  counters: BenchmarkCounterSnapshot
  metadata: BenchmarkMetadata
  name: string
  schemaVersion: 1
  timingMilliseconds: {
    median: number
    p95: number
  }
}
