import { describe, expect, test } from "bun:test"

import {
  createPreparedMessagesPolicyPort,
  type PreparedMessagesPolicySnapshot,
} from "~/routes/messages/prepared-messages/policy"
import type { Model } from "~/services/copilot/get-models"

const createModel = (id: string): Model =>
  ({
    capabilities: {
      family: "benchmark",
      limits: { max_prompt_tokens: 128_000, vision: { max_prompt_images: 5 } },
      supports: { reasoning_effort: ["low", "high"], tool_calls: true },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    supported_endpoints: ["/chat/completions"],
    vendor: "benchmark",
  }) as unknown as Model

const createSource = (
  models: ReadonlyArray<Model>,
  overrides: Partial<PreparedMessagesPolicySnapshot> = {},
): (() => PreparedMessagesPolicySnapshot) => {
  return () => ({
    catalogLoaded: models.length > 0,
    claudeTokenMultiplier: 1.15,
    contextManagementMessages: true,
    extraPrompt: "",
    modelMappings: {},
    modelResponsesApiCompactThresholds: {},
    models,
    reasoningEffort: "high",
    useMessagesApi: true,
    useResponsesApiWebSocket: true,
    ...overrides,
  })
}

describe("prepared messages policy snapshot", () => {
  test("reuses one frozen catalog across snapshots of the same source array", () => {
    const models = [createModel("a"), createModel("b")]
    const port = createPreparedMessagesPolicyPort(createSource(models))

    const first = port.snapshot("a")
    const second = port.snapshot("a")

    // The catalog only changes when the models refresh replaces it, so
    // deep-copying and deep-freezing it per request was pure overhead.
    expect(second.models).toBe(first.models)
  })

  test("does not hand callers the caller's own array", () => {
    const models = [createModel("a")]
    const port = createPreparedMessagesPolicyPort(createSource(models))

    const snapshot = port.snapshot("a")

    expect(snapshot.models).not.toBe(models)
    expect(snapshot.models).toEqual(models)
  })

  test("deep-freezes the catalog it shares", () => {
    const models = [createModel("a")]
    const port = createPreparedMessagesPolicyPort(createSource(models))

    const snapshot = port.snapshot("a")

    expect(Object.isFrozen(snapshot.models)).toBe(true)
    expect(Object.isFrozen(snapshot.models[0])).toBe(true)
    expect(Object.isFrozen(snapshot.models[0].capabilities)).toBe(true)
    expect(Object.isFrozen(snapshot.models[0].capabilities.limits)).toBe(true)
    expect(Object.isFrozen(snapshot.models[0].supported_endpoints)).toBe(true)
  })

  test("mutating a shared catalog entry does not leak across snapshots", () => {
    const models = [createModel("a")]
    const port = createPreparedMessagesPolicyPort(createSource(models))

    const first = port.snapshot("a")
    expect(() => {
      ;(first.models[0] as { id: string }).id = "mutated"
    }).toThrow()

    expect(port.snapshot("a").models[0].id).toBe("a")
  })

  test("refreshing the catalog produces a new frozen array", () => {
    const original = [createModel("a")]
    let models: ReadonlyArray<Model> = original
    const port = createPreparedMessagesPolicyPort(() => createSource(models)())

    const before = port.snapshot("a")
    // `refreshModels` replaces `state.models` wholesale, so identity changes
    // exactly when the catalog does.
    models = [createModel("a"), createModel("c")]
    const after = port.snapshot("a")

    expect(after.models).not.toBe(before.models)
    expect(after.models.map((model) => model.id)).toEqual(["a", "c"])
    expect(before.models.map((model) => model.id)).toEqual(["a"])
  })

  test("still deep-freezes the non-catalog part of the snapshot", () => {
    const port = createPreparedMessagesPolicyPort(
      createSource([createModel("a")], {
        modelMappings: { alias: "a" },
        modelResponsesApiCompactThresholds: { a: 0.8 },
      }),
    )

    const snapshot = port.snapshot("alias")

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.modelMappings)).toBe(true)
    expect(Object.isFrozen(snapshot.modelResponsesApiCompactThresholds)).toBe(
      true,
    )
    expect(snapshot.modelMappings.alias).toBe("a")
    expect(snapshot.modelResponsesApiCompactThresholds.a).toBe(0.8)
  })

  test("copies non-catalog fields rather than sharing the source objects", () => {
    const mappings = { alias: "a" }
    const port = createPreparedMessagesPolicyPort(
      createSource([createModel("a")], { modelMappings: mappings }),
    )

    const snapshot = port.snapshot("alias")

    expect(snapshot.modelMappings).not.toBe(mappings)
    expect(Object.isFrozen(mappings)).toBe(false)
  })

  test("handles an absent catalog", () => {
    const port = createPreparedMessagesPolicyPort(createSource([]))

    const snapshot = port.snapshot()

    expect(snapshot.catalogLoaded).toBe(false)
    expect(snapshot.models).toEqual([])
    expect(Object.isFrozen(snapshot.models)).toBe(true)
  })
})
