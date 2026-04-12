import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "../src/lib/state"

const actualConfigModule = await import("../src/lib/config")

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getAnthropicApiKey: () => null,
  getClaudeTokenMultiplier: () => 1.15,
}))
await mock.module("~/lib/tokenizer", () => ({
  getTokenCount: () => Promise.resolve({ input: 100, output: 0 }),
}))

const { handleCountTokens } = await import(
  "../src/routes/messages/count-tokens-handler"
)

const makeModel = (id: string) => ({
  id,
  name: id,
  object: "model" as const,
  version: id,
  vendor: "Anthropic",
  preview: false,
  model_picker_enabled: true,
  model_picker_category: "powerful" as const,
  policy: { state: "enabled" as const, terms: "" },
  supported_endpoints: ["/v1/messages"],
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

const createApp = () => {
  const app = new Hono()
  app.post("/", handleCountTokens)
  return app
}

const createPayload = (model: string) => ({
  model,
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
})

const originalModels = state.models

beforeEach(() => {
  state.models = {
    object: "list",
    data: [makeModel("claude-opus-4.6"), makeModel("claude-opus-4.6-1m")],
  }
})

afterEach(() => {
  state.models = originalModels
})

describe("count-tokens context-1m routing", () => {
  test("resolves -1m model when context-1m beta header is present", async () => {
    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify(createPayload("claude-opus-4-6")),
    })

    // Should succeed (not return default count of 1) and use the 1m model
    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(1)
  })

  test("resolves base model when context-1m beta is absent", async () => {
    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(createPayload("claude-opus-4-6")),
    })

    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(1)
  })

  test("returns default token count when model not found", async () => {
    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify(createPayload("unknown-model")),
    })

    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBe(1)
  })
})
