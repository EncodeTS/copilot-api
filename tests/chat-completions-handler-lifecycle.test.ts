import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import {
  chatCompletionsHandlerDependencies,
  handleCompletion,
} from "../src/routes/chat-completions/handler"

const originalCreateChatCompletions =
  chatCompletionsHandlerDependencies.createChatCompletions

afterEach(() => {
  chatCompletionsHandlerDependencies.createChatCompletions =
    originalCreateChatCompletions
})

test("chat completions handler forwards the Hono request abort signal", async () => {
  let upstreamSignal: AbortSignal | undefined
  chatCompletionsHandlerDependencies.createChatCompletions = mock(
    (
      payload: ChatCompletionsPayload,
      options: Parameters<typeof originalCreateChatCompletions>[1],
    ) => {
      upstreamSignal = options.signal
      return Promise.resolve({
        choices: [],
        created: 0,
        id: "chat-test",
        model: payload.model,
        object: "chat.completion" as const,
      })
    },
  ) as typeof chatCompletionsHandlerDependencies.createChatCompletions
  const app = new Hono()
  app.post("/", handleCompletion)
  const controller = new AbortController()
  const request = new Request("http://localhost/", {
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: controller.signal,
  })

  const response = await app.request(request)

  expect(response.status).toBe(200)
  expect(upstreamSignal).toBe(controller.signal)
})

test("chat completions rejects unknown runtime reasoning effort", async () => {
  const createChatCompletions = mock(originalCreateChatCompletions)
  chatCompletionsHandlerDependencies.createChatCompletions =
    createChatCompletions
  const app = new Hono()
  app.post("/", handleCompletion)

  const response = await app.request("/", {
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
      reasoning_effort: "future-hyper",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(400)
  expect(createChatCompletions).not.toHaveBeenCalled()
})
