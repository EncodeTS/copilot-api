import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("aborts an in-flight HTTP request when the caller disconnects", async () => {
  fetchMock.mockImplementationOnce(
    ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("request aborted"),
            ),
          { once: true },
        )
      })) as never,
  )
  const controller = new AbortController()
  const request = createChatCompletions(
    {
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    },
    {
      requestId: "request-1",
      signal: controller.signal,
    },
  )

  controller.abort(new Error("client disconnected"))

  const outcome = await Promise.race([
    request.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("request remained pending"), 20),
    ),
  ])
  expect(outcome).toBe("client disconnected")
})

test("applies the configured HTTP headers deadline", async () => {
  fetchMock.mockImplementationOnce(
    ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("request aborted"),
            ),
          { once: true },
        )
      })) as never,
  )

  const request = createChatCompletions(
    {
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    },
    {
      requestId: "request-1",
      timeouts: { httpHeadersMs: 5 },
    },
  )

  expect(
    await request.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : "unknown error",
    ),
  ).toBe("Upstream HTTP headers timed out after 5ms")
})

test("sets x-initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})

test("sets x-initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("user")
})
