import type { PreparedMessagesPolicySnapshot } from "../../src/routes/messages/prepared-messages/policy"
import type { Model } from "../../src/services/copilot/get-models"

import { BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

export const POLICY_SNAPSHOT_BENCHMARK_MODEL_COUNTS = [0, 8, 25, 60] as const

export interface PolicySnapshotBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

/**
 * Measures what one `preparedMessagesPolicy.snapshot()` costs per request.
 *
 * The snapshot embeds the whole Copilot model catalog, and the port deep-copies
 * and deep-freezes everything it is handed. The catalog only changes when the
 * 30-minute refresh replaces `state.models`, so the per-request share of that
 * work is pure overhead.
 *
 * The 25-model fixture is calibrated against a live enterprise catalog measured
 * on 2026-07-27: 25 models, 34,220 bytes, 1,518 object-graph nodes.
 */
export const runPolicySnapshotBenchmarks = async (
  options: PolicySnapshotBenchmarkOptions = {},
): Promise<Array<BenchmarkReport>> => {
  const { createPreparedMessagesPolicyPort } = await import(
    "../../src/routes/messages/prepared-messages/policy"
  )
  const reports: Array<BenchmarkReport> = []

  for (const modelCount of POLICY_SNAPSHOT_BENCHMARK_MODEL_COUNTS) {
    const catalog = createCatalog(modelCount)
    const source = (): PreparedMessagesPolicySnapshot => ({
      catalogLoaded: catalog.length > 0,
      claudeTokenMultiplier: 1.15,
      contextManagementMessages: true,
      extraPrompt: "",
      modelMappings: {},
      modelResponsesApiCompactThresholds: {},
      // Identity is stable across calls, exactly as `state.models.data` is
      // between refreshes.
      models: catalog,
      reasoningEffort: "high",
      useMessagesApi: true,
      useResponsesApiWebSocket: true,
    })
    const port = createPreparedMessagesPolicyPort(source)
    const counters = new BenchmarkCounters()

    reports.push(
      await runBenchmark({
        commit: options.commit,
        counters,
        fixture: JSON.stringify({ modelCount }),
        iterations: options.iterations ?? 50,
        name: `policy-snapshot-${modelCount}`,
        run: ({ counters: iterationCounters }) => {
          const snapshot = port.snapshot("model-0")
          iterationCounters.add(
            "traversals",
            snapshot.models.length > 0 ? 1 : 0,
          )
          iterationCounters.observe("rssBytes", process.memoryUsage().rss)
          return Promise.resolve()
        },
        warmupIterations: options.warmupIterations ?? 10,
      }),
    )
  }

  return reports
}

const createCatalog = (modelCount: number): ReadonlyArray<Model> =>
  Object.freeze(
    Array.from(
      { length: modelCount },
      (_, index) =>
        ({
          billing: { is_premium: index % 3 === 0, multiplier: 1 },
          capabilities: {
            family: `family-${index % 5}`,
            limits: {
              max_context_window_tokens: 128_000,
              max_output_tokens: 16_000,
              max_prompt_tokens: 120_000,
              vision: {
                max_prompt_image_size: 3_145_728,
                max_prompt_images: 5,
                supported_media_types: [
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                  "image/gif",
                ],
              },
            },
            object: "model_capabilities",
            supports: {
              parallel_tool_calls: true,
              reasoning_effort: ["low", "medium", "high"],
              streaming: true,
              structured_outputs: true,
              tool_calls: true,
              vision: true,
            },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: `model-${index}`,
          is_chat_default: index === 0,
          is_chat_fallback: false,
          model_picker_category: "versatile",
          model_picker_enabled: true,
          model_picker_price_category: "standard",
          name: `Benchmark Model ${index}`,
          policy: { state: "enabled", terms: "" },
          preview: false,
          supported_endpoints: [
            "/chat/completions",
            "/responses",
            "/v1/messages",
          ],
          vendor: "benchmark",
          version: "1.0.0",
        }) as unknown as Model,
    ),
  )

if (import.meta.main) {
  console.log(JSON.stringify(await runPolicySnapshotBenchmarks(), null, 2))
}
