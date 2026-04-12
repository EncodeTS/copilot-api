import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { findEndpointModel } from "../src/lib/models"
import { state } from "../src/lib/state"

const makeModel = (id: string, endpoints: Array<string> = []) => ({
  id,
  name: id,
  object: "model" as const,
  version: id,
  vendor: "Anthropic",
  preview: false,
  model_picker_enabled: true,
  model_picker_category: "powerful" as const,
  policy: { state: "enabled" as const, terms: "" },
  supported_endpoints: endpoints,
  capabilities: {
    family: id,
    object: "model_capabilities" as const,
    type: "chat" as const,
    tokenizer: "o200k_base",
    limits: {
      max_context_window_tokens: 200000,
      max_output_tokens: 32000,
      max_prompt_tokens: 168000,
    },
    supports: {
      adaptive_thinking: false,
      streaming: true,
      tool_calls: true,
      vision: true,
      parallel_tool_calls: true,
      structured_outputs: true,
    },
  },
})

describe("findEndpointModel", () => {
  const originalModels = state.models

  beforeEach(() => {
    state.models = {
      object: "list",
      data: [
        makeModel("claude-opus-4.6", ["/v1/messages"]),
        makeModel("claude-opus-4.6-1m", ["/v1/messages"]),
        makeModel("claude-sonnet-4.6", ["/v1/messages"]),
      ],
    }
  })

  afterEach(() => {
    state.models = originalModels
  })

  test("exact match without suffix", () => {
    const model = findEndpointModel("claude-opus-4.6")
    expect(model?.id).toBe("claude-opus-4.6")
  })

  test("normalizes SDK format to dotted format", () => {
    const model = findEndpointModel("claude-opus-4-6")
    expect(model?.id).toBe("claude-opus-4.6")
  })

  test("suffix: exact match with suffix takes priority", () => {
    const model = findEndpointModel("claude-opus-4.6", "-1m")
    expect(model?.id).toBe("claude-opus-4.6-1m")
  })

  test("suffix: normalized match with suffix", () => {
    const model = findEndpointModel("claude-opus-4-6", "-1m")
    expect(model?.id).toBe("claude-opus-4.6-1m")
  })

  test("suffix: falls back to base model when suffixed model not found", () => {
    const model = findEndpointModel("claude-sonnet-4-6", "-1m")
    // claude-sonnet-4.6-1m doesn't exist, falls back to claude-sonnet-4.6
    expect(model?.id).toBe("claude-sonnet-4.6")
  })

  test("suffix: returns undefined when neither suffixed nor base model found", () => {
    const model = findEndpointModel("claude-haiku-4-5", "-1m")
    expect(model).toBeUndefined()
  })

  test("returns undefined for completely unknown model", () => {
    const model = findEndpointModel("gpt-5-mini")
    expect(model).toBeUndefined()
  })

  test("no suffix: does not match suffixed model by accident", () => {
    // Without suffix, "claude-opus-4-6" should match "claude-opus-4.6" not "claude-opus-4.6-1m"
    const model = findEndpointModel("claude-opus-4-6")
    expect(model?.id).toBe("claude-opus-4.6")
  })
})
