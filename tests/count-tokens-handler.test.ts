import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "../src/services/copilot/get-models"

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

const m = (id: string): Model => ({ id }) as Model

const setModels = (ids: Array<string>) => {
  state.models = { data: ids.map((id) => m(id)), object: "list" }
}

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

afterEach(() => {
  state.models = originalModels
})

describe("count-tokens context-1m routing", () => {
  beforeEach(() => {
    setModels(["claude-opus-4.6", "claude-opus-4.6-1m"])
  })

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

    // Model was resolved (not the default-count fallback of 1)
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

  test("resolves -1m-internal variant when only the decorated 1m model is exposed", async () => {
    // Mirrors the real Copilot model list for opus 4.7 where the only
    // 1M-context variant is suffixed with `-internal`. Without proper
    // prefix matching, this would silently fall back to the 200K base.
    setModels(["claude-opus-4.7", "claude-opus-4.7-1m-internal"])

    const app = createApp()
    const response = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify(createPayload("claude-opus-4-7")),
    })

    const body = (await response.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(1)
  })
})
