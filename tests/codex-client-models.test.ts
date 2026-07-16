import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  codexClientModelsDependencies,
  createCodexModelsResponse,
  getCodexClientVersion,
  isCodexClientUserAgent,
  projectCodexModels,
} from "../src/services/codex/client-models"
import type { CodexModelsResponse } from "../src/services/codex/installed-catalog"
import type { Model } from "../src/services/copilot/get-models"

const originalLoadBundledCatalog =
  codexClientModelsDependencies.loadBundledCatalog
const originalIsResponsesApiWebSocketEnabled =
  codexClientModelsDependencies.isResponsesApiWebSocketEnabled

const bundledCatalog: CodexModelsResponse = {
  models: [
    {
      slug: "gpt-5.6-sol",
      base_instructions: "bundled instructions",
      context_window: 372_000,
    },
  ],
}

const aliasCatalog: CodexModelsResponse = {
  models: [
    {
      slug: "gpt-5.4-mini",
      base_instructions: "mini instructions",
      description: "Mini description",
      display_name: "GPT-5.4 Mini",
      priority: 10,
      supported_reasoning_levels: [{ effort: "low", description: "Mini low" }],
      tool_mode: "mini_tools",
      visibility: "list",
    },
    {
      slug: "gpt-5.6-luna",
      base_instructions: "luna instructions",
      compatibility_hash: "luna-hash",
      description: "Luna description",
      display_name: "GPT-5.6 Luna",
      priority: 20,
      supported_reasoning_levels: [
        { effort: "low", description: "Luna low" },
        { effort: "medium", description: "Luna medium" },
        { effort: "max", description: "Luna max" },
      ],
      tool_mode: "luna_tools",
      unknown_target_behavior: { enabled: true },
      visibility: "list",
    },
  ],
}

const createCopilotModel = (
  limits: Model["capabilities"]["limits"],
  {
    id = "gpt-5.6-sol",
    reasoningEfforts,
  }: {
    id?: string
    reasoningEfforts?: Array<string>
  } = {},
): Model => ({
  capabilities: {
    family: id,
    limits,
    object: "model_capabilities",
    supports: {
      ...(reasoningEfforts === undefined ?
        {}
      : { reasoning_effort: reasoningEfforts }),
    },
    tokenizer: "o200k_base",
    type: "chat",
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  supported_endpoints: ["/responses"],
  vendor: "openai",
  version: "test",
})

beforeEach(() => {
  codexClientModelsDependencies.isResponsesApiWebSocketEnabled = () => true
})

afterEach(() => {
  codexClientModelsDependencies.loadBundledCatalog = originalLoadBundledCatalog
  codexClientModelsDependencies.isResponsesApiWebSocketEnabled =
    originalIsResponsesApiWebSocketEnabled
})

describe("Codex client models", () => {
  test("parses the client version without trusting malformed query values", () => {
    expect(
      getCodexClientVersion(
        "http://localhost/v1/models?client_version=invalid",
        "Codex Desktop/0.145.0",
      ),
    ).toBe("0.145.0")
    expect(
      getCodexClientVersion("http://localhost/v1/models", undefined),
    ).toBeNull()
    expect(isCodexClientUserAgent(" Codex Desktop/0.145.0")).toBeTrue()
    expect(isCodexClientUserAgent("curl/8.0")).toBeFalse()
  })

  test("rejects conflicting query and user-agent versions", () => {
    expect(
      getCodexClientVersion(
        "http://localhost/v1/models?client_version=0.144.1",
        "codex-tui/0.144.2",
      ),
    ).toBeNull()
    expect(
      getCodexClientVersion(
        "http://localhost/v1/models?client_version=0.144.1",
        "codex-tui/0.144.1",
      ),
    ).toBe("0.144.1")
  })

  test("rejects client versions longer than the supported limit", () => {
    const longVersion = `0.144.1-${"a".repeat(100)}`

    expect(
      getCodexClientVersion(
        `http://localhost/v1/models?client_version=${longVersion}`,
        undefined,
      ),
    ).toBeNull()
    expect(
      getCodexClientVersion(
        "http://localhost/v1/models",
        `codex-tui/${longVersion}`,
      ),
    ).toBeNull()
  })

  test("preserves the bundled descriptor when Copilot omits context limits", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(bundledCatalog)

    expect(await createCodexModelsResponse(null, [])).toEqual({ models: [] })
    expect(
      await createCodexModelsResponse("0.144.1", [createCopilotModel({})]),
    ).toEqual(bundledCatalog)
  })

  test("keeps WebSocket-only models only when that transport is enabled", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(bundledCatalog)
    const model = createCopilotModel({
      max_context_window_tokens: 1_050_000,
    })
    model.supported_endpoints = ["ws:/responses"]

    expect(await createCodexModelsResponse("0.144.1", [model])).toEqual({
      models: [
        {
          ...bundledCatalog.models[0],
          auto_compact_token_limit: 945_000,
          context_window: 1_050_000,
          max_context_window: 1_050_000,
        },
      ],
    })

    codexClientModelsDependencies.isResponsesApiWebSocketEnabled = () => false
    expect(await createCodexModelsResponse("0.144.1", [model])).toEqual({
      models: [],
    })
  })

  test("keeps smaller models on their own context and compact limits", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(bundledCatalog)
    const model = createCopilotModel({
      max_context_window_tokens: 400_000,
      max_output_tokens: 128_000,
      max_prompt_tokens: 272_000,
    })

    expect(await createCodexModelsResponse("0.144.1", [model])).toEqual({
      models: [
        {
          ...bundledCatalog.models[0],
          auto_compact_token_limit: 240_000,
          context_window: 400_000,
          max_context_window: 400_000,
        },
      ],
    })
  })

  test("projects a mapped source identity from the complete target descriptor and live target capabilities", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(aliasCatalog)
    const luna = createCopilotModel(
      {
        max_context_window_tokens: 1_050_000,
        max_output_tokens: 128_000,
        max_prompt_tokens: 922_000,
      },
      {
        id: "gpt-5.6-luna",
        reasoningEfforts: ["medium", "max"],
      },
    )

    const result = await projectCodexModels({
      clientVersion: "0.144.1",
      copilotModels: [luna],
      modelMappings: { "gpt-5.4-mini": "gpt-5.6-luna" },
    })

    expect(result.status).toBe("complete")
    expect(result.diagnostics).toEqual([])
    expect(result.catalog.models).toHaveLength(2)
    expect(result.catalog.models[0]).toEqual({
      ...aliasCatalog.models[1],
      auto_compact_token_limit: 890_000,
      context_window: 1_050_000,
      description: "Mini description",
      display_name: "GPT-5.4 Mini",
      max_context_window: 1_050_000,
      priority: 10,
      slug: "gpt-5.4-mini",
      supported_reasoning_levels: [
        { effort: "medium", description: "Luna medium" },
        { effort: "max", description: "Luna max" },
      ],
      visibility: "list",
    })
    expect(result.catalog.models[0]?.base_instructions).toBe(
      "luna instructions",
    )
    expect(result.catalog.models[0]?.tool_mode).toBe("luna_tools")
    expect(result.catalog.models[0]?.unknown_target_behavior).toEqual({
      enabled: true,
    })
  })

  test("restores the real source descriptor and live limits after mapping removal", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(aliasCatalog)
    const mini = createCopilotModel(
      {
        max_context_window_tokens: 400_000,
        max_prompt_tokens: 272_000,
      },
      { id: "gpt-5.4-mini", reasoningEfforts: ["low"] },
    )
    const luna = createCopilotModel(
      {
        max_context_window_tokens: 1_050_000,
        max_prompt_tokens: 922_000,
      },
      { id: "gpt-5.6-luna" },
    )

    const result = await projectCodexModels({
      clientVersion: "0.144.1",
      copilotModels: [mini, luna],
      modelMappings: {},
    })

    expect(result.status).toBe("complete")
    expect(result.catalog.models[0]).toMatchObject({
      auto_compact_token_limit: 240_000,
      base_instructions: "mini instructions",
      context_window: 400_000,
      display_name: "GPT-5.4 Mini",
      slug: "gpt-5.4-mini",
      tool_mode: "mini_tools",
    })
  })

  test("returns a degraded catalog when an alias cannot be composed safely", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(aliasCatalog)
    const mini = createCopilotModel(
      { max_context_window_tokens: 400_000 },
      { id: "gpt-5.4-mini" },
    )

    const result = await projectCodexModels({
      clientVersion: "0.144.1",
      copilotModels: [mini],
      modelMappings: {
        "gpt-5.4-mini": "gpt-missing",
        "virtual-role": "provider/model",
      },
    })

    expect(result.status).toBe("degraded")
    expect(result.catalog.models.map(({ slug }) => slug)).toEqual([])
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "target_descriptor_missing",
      "source_descriptor_missing",
    ])
  })

  test("omits aliases with invalid live capacity or incompatible reasoning", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(aliasCatalog)

    for (const luna of [
      createCopilotModel({}, { id: "gpt-5.6-luna" }),
      createCopilotModel(
        { max_context_window_tokens: 1_050_000 },
        { id: "gpt-5.6-luna", reasoningEfforts: ["ultra"] },
      ),
    ]) {
      const result = await projectCodexModels({
        clientVersion: "0.144.1",
        copilotModels: [luna],
        modelMappings: { "gpt-5.4-mini": "gpt-5.6-luna" },
      })

      expect(result.status).toBe("degraded")
      expect(result.catalog.models.map(({ slug }) => slug)).not.toContain(
        "gpt-5.4-mini",
      )
    }
  })

  test("keeps target descriptor reasoning authoritative when live metadata is absent", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(aliasCatalog)
    const luna = createCopilotModel(
      { max_context_window_tokens: 1_050_000 },
      { id: "gpt-5.6-luna" },
    )

    const result = await projectCodexModels({
      clientVersion: "0.144.1",
      copilotModels: [luna],
      modelMappings: { "gpt-5.4-mini": "gpt-5.6-luna" },
    })

    expect(result.catalog.models[0]?.supported_reasoning_levels).toEqual(
      aliasCatalog.models[1]?.supported_reasoning_levels,
    )
  })

  test("reports an unavailable projection when no trustworthy base catalog exists", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(null)

    expect(
      await projectCodexModels({
        clientVersion: "0.144.1",
        copilotModels: [],
        modelMappings: {},
      }),
    ).toEqual({
      catalog: { models: [] },
      diagnostics: [{ code: "base_catalog_unavailable" }],
      status: "unavailable",
    })
  })
})
