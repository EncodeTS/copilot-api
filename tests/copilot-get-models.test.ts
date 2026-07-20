import { afterEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { getModels } from "~/services/copilot/get-models"

const originalFetch = globalThis.fetch
const originalCopilotApiUrl = state.copilotApiUrl
const originalCopilotToken = state.copilotToken

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotApiUrl = originalCopilotApiUrl
  state.copilotToken = originalCopilotToken
})

test("normalizes live Copilot reasoning effort strings at the HTTP boundary", async () => {
  state.copilotApiUrl = "https://copilot.example"
  state.copilotToken = "test-token"
  globalThis.fetch = mock(() =>
    Promise.resolve(
      Response.json({
        data: [
          {
            capabilities: {
              family: "gpt-test",
              limits: {},
              object: "model_capabilities",
              supports: {
                reasoning_effort: ["low", "future-hyper", "ultra", "low"],
              },
              type: "chat",
            },
            id: "gpt-test",
            model_picker_enabled: true,
            name: "GPT Test",
            object: "model",
            vendor: "openai",
            version: "test",
          },
        ],
        object: "list",
      }),
    ),
  ) as unknown as typeof fetch

  const models = await getModels()

  expect(models.data[0]?.capabilities.supports.reasoning_effort).toEqual([
    "low",
    "ultra",
  ])
})
