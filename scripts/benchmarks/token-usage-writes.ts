import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

export const TOKEN_USAGE_WRITE_BENCHMARK_BURST_SIZES = [1, 8, 64, 256] as const

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

export interface TokenUsageWriteBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

/**
 * Measures what a burst of queued usage events costs the drain loop.
 *
 * Recording is off the request path, so this is a throughput and event-loop
 * occupancy measurement rather than a request-latency one: `bun:sqlite` is
 * synchronous, so however long a drain takes is time the loop is not serving
 * traffic.
 *
 * Measured on 2026-07-27 against the pre-batching drain, which re-parsed the
 * INSERT per event and committed each one on its own: 500 events cost 26.9 µs
 * each, versus 1.8 µs each once the statement is prepared once and the burst
 * shares a transaction.
 */
export const runTokenUsageWriteBenchmarks = async (
  options: TokenUsageWriteBenchmarkOptions = {},
): Promise<Array<BenchmarkReport>> => {
  const { closeUsageStore, enqueueTokenUsageWrite, getTokenUsageEventsPage } =
    await import("../../src/lib/token-usage/store")
  const reports: Array<BenchmarkReport> = []
  const directory = mkdtempSync(path.join(tmpdir(), "copilot-usage-bench-"))
  const previousDbPath = process.env[DB_PATH_ENV]

  try {
    for (const burstSize of TOKEN_USAGE_WRITE_BENCHMARK_BURST_SIZES) {
      process.env[DB_PATH_ENV] = path.join(directory, `burst-${burstSize}.db`)
      await closeUsageStore()
      const counters = new BenchmarkCounters()

      reports.push(
        await runBenchmark({
          commit: options.commit,
          counters,
          fixture: JSON.stringify({ burstSize }),
          iterations: options.iterations ?? 20,
          name: `token-usage-writes-${burstSize}`,
          run: async ({ counters: iterationCounters }) => {
            for (let index = 0; index < burstSize; index += 1) {
              enqueueTokenUsageWrite(createEvent(index))
            }
            // Reading the events page flushes the queue, which is the same
            // drain the runtime performs on its own microtask.
            await getTokenUsageEventsPage({
              page: 1,
              pageSize: 1,
              period: "day",
            })
            iterationCounters.add("serializations", burstSize)
            iterationCounters.observe("rssBytes", process.memoryUsage().rss)
          },
          warmupIterations: options.warmupIterations ?? 5,
        }),
      )
    }
  } finally {
    await closeUsageStore()
    if (previousDbPath === undefined) {
      Reflect.deleteProperty(process.env, DB_PATH_ENV)
    } else {
      process.env[DB_PATH_ENV] = previousDbPath
    }
    rmSync(directory, { force: true, recursive: true })
  }

  return reports
}

const createEvent = (index: number) => ({
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_currency: "USD",
  cost_source: "estimated",
  created_at_ms: 1_753_500_000_000 + index,
  created_at_utc: new Date(1_753_500_000_000 + index).toISOString(),
  endpoint: "responses" as const,
  error_code: null,
  input_tokens: 1_200,
  model: `benchmark-model-${index % 5}`,
  outcome: "completed" as const,
  output_tokens: 340,
  provider_name: null,
  session_id: `session-${index % 7}`,
  source: "copilot" as const,
  terminal: null,
  total_cost_nanos: 0,
  total_nano_aiu: 0,
  total_tokens: 1_540,
  trace_id: `trace-${index}`,
  user_id: "benchmark-user",
})

if (import.meta.main) {
  console.log(JSON.stringify(await runTokenUsageWriteBenchmarks(), null, 2))
}
