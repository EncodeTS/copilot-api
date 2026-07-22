import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createImageCompressionRuntime,
  type ImageCompressionRuntimeSnapshot,
} from "../../src/routes/responses/image-compression-runtime"
import { createSharpImageCompressionAdapter } from "../../src/routes/responses/image-compression"
import type { ImageCompressionInput } from "../../src/routes/responses/utils"

import { assertBenchmarkCounterCaps, BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

const CACHE_BYTES_CAP = 8192
const PENDING_BYTES_CAP = 8192
const REQUESTS_PER_ITERATION = 16

export interface ResponsesImageCompressionBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

export const runResponsesImageCompressionBenchmark = async (
  options: ResponsesImageCompressionBenchmarkOptions = {},
): Promise<BenchmarkReport> => {
  process.env.COPILOT_API_HOME ??= join(
    tmpdir(),
    `copilot-api-image-compression-benchmark-${process.pid}`,
  )
  const runtime = createImageCompressionRuntime()
  let releaseWork: (() => void) | undefined
  let workGate = Promise.resolve()
  const adapter = createSharpImageCompressionAdapter({
    binaryCompressor: async () => {
      await workGate
      return { buffer: Buffer.from([1]), mimeType: "image/jpeg" }
    },
    cacheBytes: CACHE_BYTES_CAP,
    cacheEntries: 16,
    concurrency: 2,
    format: "jpeg",
    maxPendingBytes: PENDING_BYTES_CAP,
    maxPendingEntries: REQUESTS_PER_ITERATION,
    namespace: {
      account: "benchmark-account",
      model: "benchmark-model",
      origin: "benchmark-origin",
      tenant: "benchmark-tenant",
    },
    runtime,
    timeoutMs: 5000,
  })
  const counters = new BenchmarkCounters()
  const iterations = options.iterations ?? 5
  const report = await runBenchmark({
    commit: options.commit,
    counters,
    fixture: JSON.stringify({
      cacheBytes: CACHE_BYTES_CAP,
      concurrency: 2,
      pendingBytes: PENDING_BYTES_CAP,
      requests: REQUESTS_PER_ITERATION,
    }),
    iterations,
    name: "responses-image-compression-runtime",
    run: async ({ counters: iterationCounters, iteration, phase }) => {
      workGate = new Promise<void>((resolve) => {
        releaseWork = resolve
      })
      let decodedBuffers = 0
      const requests = Array.from(
        { length: REQUESTS_PER_ITERATION },
        (_, index) =>
          adapter.compress(
            createInput(`${phase}:${iteration}:${index}`, () => {
              decodedBuffers += 1
            }),
          ),
      )
      observeRuntime(iterationCounters, runtime.snapshot())
      releaseWork?.()
      await Promise.all(requests)
      observeRuntime(iterationCounters, runtime.snapshot())
      iterationCounters.add("decodedBuffers", decodedBuffers)
    },
    warmupIterations: options.warmupIterations ?? 2,
  })
  assertBenchmarkCounterCaps(report.counters, {
    cacheWeightBytes: CACHE_BYTES_CAP,
    decodedBuffers: REQUESTS_PER_ITERATION * iterations,
    queuedBytes: PENDING_BYTES_CAP,
  })
  return report
}

const createInput = (
  identity: string,
  onBase64Decoded: () => void,
): ImageCompressionInput => {
  const content = Buffer.alloc(256, identity)
  return {
    dataUrl: `data:image/png;base64,${content.toString("base64")}`,
    decodedBytes: content.byteLength,
    group: "history_user",
    mimeType: "image/png",
    onBase64Decoded,
    profile: {
      detail: "keep-original",
      jpegQuality: 82,
      maxLongEdge: 600,
      name: "history-soft",
    },
  }
}

const observeRuntime = (
  counters: BenchmarkCounters,
  snapshot: ImageCompressionRuntimeSnapshot,
): void => {
  counters.observe("cacheWeightBytes", snapshot.cacheWeightBytes)
  counters.observe("queuedBytes", snapshot.queuedBytes)
}

if (import.meta.main) {
  console.log(
    JSON.stringify(await runResponsesImageCompressionBenchmark(), null, 2),
  )
}
