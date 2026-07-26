import type { AnthropicMessagesPayload } from "../../src/routes/messages/anthropic-types"
import type { PreparedMessagesPolicySnapshot } from "../../src/routes/messages/prepared-messages/policy"
import type { MessagesRequestContext } from "../../src/routes/messages/request-context"
import type { Model } from "../../src/services/copilot/get-models"

import { BenchmarkCounters } from "./counters"
import { runBenchmark } from "./runner"
import type { BenchmarkReport } from "./types"

export const PREPARED_MESSAGES_BENCHMARK_TURN_COUNTS = [1, 8, 32, 96] as const

export interface PreparedMessagesBenchmarkOptions {
  commit?: string
  iterations?: number
  warmupIterations?: number
}

/**
 * Counts deep copies made while `run` executes, split two ways:
 *
 * - `payloadClones` — copies of a whole Messages payload, identified by the
 *   `messages` property. This is the number ticket 06 is about.
 * - `totalClones` — every `structuredClone` call, including small nested
 *   objects, so a change cannot shift cost into copies the first counter
 *   would miss.
 *
 * `structuredClone` is wrapped rather than instrumenting the facade so the
 * measurement costs nothing in production.
 */
const countClones = async (
  run: () => Promise<unknown>,
): Promise<{ payloadClones: number; totalClones: number }> => {
  const original = globalThis.structuredClone
  let payloadClones = 0
  let totalClones = 0
  globalThis.structuredClone = ((value: unknown) => {
    totalClones += 1
    if (
      typeof value === "object"
      && value !== null
      && "messages" in (value as Record<string, unknown>)
    ) {
      payloadClones += 1
    }
    return original(value)
  }) as typeof structuredClone

  try {
    await run()
  } finally {
    globalThis.structuredClone = original
  }

  return { payloadClones, totalClones }
}

export const runPreparedMessagesBenchmarks = async (
  options: PreparedMessagesBenchmarkOptions = {},
): Promise<Array<BenchmarkReport>> => {
  const { createPreparedMessagesFacade } = await import(
    "../../src/routes/messages/prepared-messages/facade"
  )
  const { createPreparedMessagesPolicyPort } = await import(
    "../../src/routes/messages/prepared-messages/policy"
  )

  const facade = createPreparedMessagesFacade()
  const reports: Array<BenchmarkReport> = []

  for (const turns of PREPARED_MESSAGES_BENCHMARK_TURN_COUNTS) {
    const payload = createToolHeavyPayload(turns)
    const context = createRequestContext(createPreparedMessagesPolicyPort)
    const counters = new BenchmarkCounters()

    reports.push(
      await runBenchmark({
        commit: options.commit,
        counters,
        fixture: JSON.stringify({ turns }),
        iterations: options.iterations ?? 5,
        name: `prepared-messages-count-${turns}`,
        run: async ({ counters: iterationCounters }) => {
          const clones = await countClones(async () => {
            await facade.count(context, payload)
          })
          iterationCounters.add("clones", clones.payloadClones)
          iterationCounters.add("traversals", clones.totalClones)
          iterationCounters.observe("rssBytes", process.memoryUsage().rss)
        },
        warmupIterations: options.warmupIterations ?? 2,
      }),
    )
  }

  return reports
}

/**
 * A chat-completions model is used deliberately: the native `/v1/messages`
 * count path dispatches to the upstream authoritative endpoint, which a
 * benchmark must not do. This keeps counting local while still exercising
 * `mapPayloadModel`, `preparePlan`, and the tokenizer.
 */
const BENCHMARK_MODEL = {
  id: "gpt-bench",
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    limits: { max_prompt_tokens: 128_000 },
    supports: {},
    tokenizer: "o200k_base",
  },
} as Model

const createRequestContext = (
  createPolicyPort: (read: () => PreparedMessagesPolicySnapshot) => {
    snapshot: () => PreparedMessagesPolicySnapshot
  },
): MessagesRequestContext =>
  Object.freeze({
    policy: createPolicyPort(() => ({
      catalogLoaded: true,
      claudeTokenMultiplier: 1.15,
      contextManagementMessages: true,
      extraPrompt: "",
      modelMappings: {},
      modelResponsesApiCompactThresholds: {},
      models: [BENCHMARK_MODEL],
      reasoningEffort: "high",
      useMessagesApi: false,
      useResponsesApiWebSocket: true,
    })).snapshot(),
    response: Object.freeze({
      json: (body: unknown, status?: number) =>
        Response.json(body, { status: status ?? 200 }),
      streamSSE: () => new Response(),
    }),
    signal: new AbortController().signal,
  }) as MessagesRequestContext

/**
 * Approximates a coding-agent conversation: a large tool catalog plus
 * alternating tool_use/tool_result turns carrying file-sized payloads.
 */
const createToolHeavyPayload = (turns: number): AnthropicMessagesPayload => {
  // Sized so a payload lands in the hundreds-of-KB to low-MB range that a real
  // tool-heavy coding-agent conversation reaches; below that, fixed tokenizer
  // startup cost dominates and clone cost is invisible.
  const fileBody = "export const value = 1\n".repeat(400)

  return {
    max_tokens: 4096,
    model: "gpt-bench",
    system: "You are a coding agent.".repeat(8),
    tools: Array.from({ length: 24 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool number ${index} used by the benchmark.`.repeat(4),
      input_schema: {
        type: "object" as const,
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (_, field) => [
            `field_${field}`,
            {
              type: "string",
              description: `Field ${field} of tool ${index}.`.repeat(3),
            },
          ]),
        ),
        required: ["field_0"],
      },
    })),
    messages: Array.from({ length: turns }, (_, index) =>
      index % 2 === 0 ?
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `Turn ${index}: please inspect the file.`,
            },
          ],
        }
      : {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: `toolu_${index}`,
              name: `tool_${index % 24}`,
              input: { field_0: fileBody },
            },
          ],
        },
    ),
  } as AnthropicMessagesPayload
}

if (import.meta.main) {
  console.log(JSON.stringify(await runPreparedMessagesBenchmarks(), null, 2))
}
