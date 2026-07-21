import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type {
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "../src/routes/messages/anthropic-types"

import { state } from "../src/lib/state"
import {
  countMessagesTokens,
  createMessages,
} from "../src/services/copilot/create-messages"
import {
  NativeMessagesOutboundAdmissionError,
  nativeMessagesOutboundDependencies,
  type NativeMessagesOutboundDiagnostic,
} from "../src/services/copilot/native-messages-outbound"

const originalFetch = globalThis.fetch
const originalState = {
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalOutboundDependencies = { ...nativeMessagesOutboundDependencies }

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
  Object.assign(
    nativeMessagesOutboundDependencies,
    originalOutboundDependencies,
  )
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("createMessages", () => {
  test("sends the exact observe-only native body checked for generation", async () => {
    const diagnostics: Array<NativeMessagesOutboundDiagnostic> = []
    nativeMessagesOutboundDependencies.getAdmissionProfile = () => ({
      hardEnforcement: false,
      maxBodyBytes: 1,
      maxImageSourceDataBytes: 1,
    })
    nativeMessagesOutboundDependencies.reportDiagnostic = (fields) => {
      diagnostics.push(fields)
    }
    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "你好" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "AQIDBA==",
              },
            },
          ],
        },
      ],
    })

    await createMessages(payload, undefined, { requestId: "request-1" })

    const [, init] = fetchMock.mock.calls[0]
    const expectedBody =
      '{"max_tokens":128,"messages":[{"role":"user","content":[{"type":"text","text":"你好"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AQIDBA=="}}]}],"model":"claude-test"}'
    expect(init?.body).toBe(expectedBody)
    expect(diagnostics).toEqual([
      {
        admitted: 1,
        bodyBytes: 200,
        bodyBytesOverLimit: 199,
        endpoint: 0,
        hardEnforcement: 0,
        imageSourceDataBytes: 8,
        imageSourceDataCount: 1,
        largestImageSourceDataBytes: 8,
        largestImageSourceDataBytesOverLimit: 7,
      },
    ])
  })

  test("sends the exact observe-only native body checked for token count", async () => {
    const diagnostics: Array<NativeMessagesOutboundDiagnostic> = []
    nativeMessagesOutboundDependencies.getAdmissionProfile = () => ({
      hardEnforcement: false,
    })
    nativeMessagesOutboundDependencies.reportDiagnostic = (fields) => {
      diagnostics.push(fields)
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ input_tokens: 9 }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    const payload = createPayload({
      messages: [{ role: "user", content: "count 你好" }],
    })

    expect(
      await countMessagesTokens(payload, undefined, {
        requestId: "request-1",
      }),
    ).toEqual({ input_tokens: 9 })

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.body).toBe(
      '{"max_tokens":128,"messages":[{"role":"user","content":"count 你好"}],"model":"claude-test"}',
    )
    expect(diagnostics).toEqual([
      {
        admitted: 1,
        bodyBytes: 94,
        bodyBytesOverLimit: 0,
        endpoint: 1,
        hardEnforcement: 0,
        imageSourceDataBytes: 0,
        imageSourceDataCount: 0,
        largestImageSourceDataBytes: 0,
        largestImageSourceDataBytesOverLimit: 0,
      },
    ])
  })

  test("applies the same configured hard profile before native token count", async () => {
    nativeMessagesOutboundDependencies.getAdmissionProfile = () => ({
      hardEnforcement: true,
      maxBodyBytes: 1,
    })
    nativeMessagesOutboundDependencies.reportDiagnostic = () => undefined

    const error = await countMessagesTokens(createPayload(), undefined, {
      requestId: "request-1",
    }).then(
      () => null,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(NativeMessagesOutboundAdmissionError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects configured hard native limits before generation is sent", async () => {
    nativeMessagesOutboundDependencies.getAdmissionProfile = () => ({
      hardEnforcement: true,
      maxBodyBytes: 32,
      maxImageSourceDataBytes: 4,
    })
    nativeMessagesOutboundDependencies.reportDiagnostic = () => undefined

    const error = await createMessages(
      createPayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AQIDBA==",
                },
              },
            ] as Array<AnthropicUserContentBlock>,
          },
        ],
      }),
      undefined,
      { requestId: "request-1" },
    ).then(
      () => null,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(NativeMessagesOutboundAdmissionError)
    expect(fetchMock).not.toHaveBeenCalled()
    const admissionError = error as NativeMessagesOutboundAdmissionError
    expect(admissionError.response.status).toBe(413)
    expect(await admissionError.response.json()).toEqual({
      type: "error",
      error: {
        type: "request_too_large",
        message: "Native Messages outbound request exceeds configured limits",
        details: {
          body_bytes: 168,
          body_bytes_over_limit: 136,
          image_source_data_bytes: 8,
          image_source_data_count: 1,
          largest_image_source_data_bytes: 8,
          largest_image_source_data_bytes_over_limit: 4,
        },
      },
    })
  })

  test("applies the single-image profile across nested protocol carriers only", async () => {
    const diagnostics: Array<NativeMessagesOutboundDiagnostic> = []
    nativeMessagesOutboundDependencies.getAdmissionProfile = () => ({
      hardEnforcement: true,
      maxBodyBytes: 10_000,
      maxImageSourceDataBytes: 8,
    })
    nativeMessagesOutboundDependencies.reportDiagnostic = (fields) => {
      diagnostics.push(fields)
    }

    await createMessages(
      createPayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AQID",
                },
              },
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  {
                    type: "document",
                    source: {
                      type: "content",
                      content: [
                        {
                          type: "image",
                          source: {
                            type: "base64",
                            media_type: "image/png",
                            data: "AQIDBA==",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                type: "tool_use",
                id: "tool-2",
                name: "opaque",
                input: {
                  type: "image",
                  source: { type: "base64", data: "A".repeat(100) },
                },
              },
            ] as Array<AnthropicUserContentBlock>,
          },
        ],
      }),
      undefined,
      { requestId: "request-1" },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(diagnostics).toEqual([
      {
        admitted: 1,
        bodyBytes: 581,
        bodyBytesOverLimit: 0,
        endpoint: 0,
        hardEnforcement: 1,
        imageSourceDataBytes: 12,
        imageSourceDataCount: 2,
        largestImageSourceDataBytes: 8,
        largestImageSourceDataBytesOverLimit: 0,
      },
    ])
  })

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
