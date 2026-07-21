export interface BenchmarkCounterDescriptor {
  aggregation: "cumulative" | "peak"
  name: string
  unit: "bytes" | "count"
}

export const benchmarkCounterDescriptors = [
  {
    aggregation: "cumulative",
    name: "tokenizerMediaBytes",
    unit: "bytes",
  },
  {
    aggregation: "cumulative",
    name: "decodedBuffers",
    unit: "count",
  },
  { aggregation: "cumulative", name: "clones", unit: "count" },
  { aggregation: "cumulative", name: "traversals", unit: "count" },
  {
    aggregation: "cumulative",
    name: "serializations",
    unit: "count",
  },
  { aggregation: "peak", name: "cacheWeightBytes", unit: "bytes" },
  { aggregation: "peak", name: "sockets", unit: "count" },
  { aggregation: "peak", name: "frames", unit: "count" },
  { aggregation: "peak", name: "queuedBytes", unit: "bytes" },
  { aggregation: "peak", name: "rssBytes", unit: "bytes" },
] as const satisfies readonly BenchmarkCounterDescriptor[]

type CounterDescriptor = (typeof benchmarkCounterDescriptors)[number]

export type BenchmarkCounterName = CounterDescriptor["name"]
export type CumulativeBenchmarkCounterName = Extract<
  CounterDescriptor,
  { aggregation: "cumulative" }
>["name"]
export type PeakBenchmarkCounterName = Extract<
  CounterDescriptor,
  { aggregation: "peak" }
>["name"]
export type BenchmarkCounterSnapshot = Record<BenchmarkCounterName, number>
export type BenchmarkCounterCaps = Partial<BenchmarkCounterSnapshot>

export const benchmarkCounterNames: readonly BenchmarkCounterName[] =
  benchmarkCounterDescriptors.map((descriptor) => descriptor.name)

function emptyCounterSnapshot(): BenchmarkCounterSnapshot {
  return {
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
  }
}

function validateCounterValue(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
}

export class BenchmarkCounters {
  readonly #values = emptyCounterSnapshot()

  add(name: CumulativeBenchmarkCounterName, amount = 1): void {
    validateCounterValue(amount, `${name} increment`)
    this.#values[name] += amount
  }

  observe(name: PeakBenchmarkCounterName, value: number): void {
    validateCounterValue(value, `${name} observation`)
    this.#values[name] = Math.max(this.#values[name], value)
  }

  reset(): void {
    for (const name of benchmarkCounterNames) {
      this.#values[name] = 0
    }
  }

  snapshot(): BenchmarkCounterSnapshot {
    return { ...this.#values }
  }
}

export function assertBenchmarkCounterCaps(
  counters: BenchmarkCounterSnapshot,
  caps: BenchmarkCounterCaps,
): void {
  for (const name of benchmarkCounterNames) {
    const cap = caps[name]
    if (cap === undefined) {
      continue
    }

    validateCounterValue(cap, `${name} structural cap`)
    if (counters[name] > cap) {
      throw new Error(
        `${name} counter ${counters[name]} exceeds structural cap ${cap}`,
      )
    }
  }
}
