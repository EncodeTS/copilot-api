import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  codexClientModelsDependencies,
  createCodexModelsResponse,
  getCodexClientVersion,
  isCodexClientUserAgent,
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

const createCopilotModel = (
  limits: Model["capabilities"]["limits"],
): Model => ({
  capabilities: {
    family: "gpt-5.6-sol",
    limits,
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-5.6-sol",
  model_picker_enabled: true,
  name: "GPT-5.6 Sol",
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
})
