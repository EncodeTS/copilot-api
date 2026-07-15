import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import { createMessages } from "../src/services/copilot/create-messages"

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        content: [],
        id: "msg-test",
        model: "claude-test",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createPayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "claude-test",
  ...overrides,
})

beforeEach(() => {
  state.copilotToken = "test-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.macMachineId = originalState.macMachineId
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("createMessages", () => {
  test("aborts an in-flight HTTP request when the caller disconnects", async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error ?
                  init.signal.reason
                : new Error("request aborted"),
              ),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const request = createMessages(createPayload(), undefined, {
      requestId: "request-1",
      signal: controller.signal,
    })

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
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                init.signal?.reason instanceof Error ?
                  init.signal.reason
                : new Error("request aborted"),
              ),
            { once: true },
          )
        }),
    )

    const request = createMessages(createPayload(), undefined, {
      requestId: "request-1",
      timeouts: { httpHeadersMs: 5 },
    })

    expect(
      await request.then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.message : "unknown error",
      ),
    ).toBe("Upstream HTTP headers timed out after 5ms")
  })

  test("adds interleaved thinking beta while preserving allowed client betas", async () => {
    await createMessages(
      createPayload({
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
      "context-management-2025-06-27, unknown-beta",
      {
        requestId: "request-1",
      },
    )

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers["anthropic-beta"]).toBe(
      "context-management-2025-06-27,interleaved-thinking-2025-05-14",
    )
  })

  test("does not duplicate interleaved thinking beta from client headers", async () => {
    await createMessages(
      createPayload({
        thinking: {
          type: "enabled",
          budget_tokens: 4096,
        },
      }),
      "interleaved-thinking-2025-05-14,context-management-2025-06-27",
      {
        requestId: "request-1",
      },
    )

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14,context-management-2025-06-27",
    )
  })
})
