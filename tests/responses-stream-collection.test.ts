import { describe, expect, test } from "bun:test"
import consola from "consola"

import type {
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import {
  BufferedResponsesTerminalError,
  collectResponsesStreamResult,
} from "~/routes/messages/responses-stream-collection"

type StreamChunk = {
  data?: string
  event?: string
}

const makeResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp-collection",
  object: "response",
  created_at: 0,
  model: "gpt-test",
  output: [
    {
      id: "msg-original",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "original",
          annotations: [],
        },
      ],
    },
  ],
  output_text: "original",
  status: "completed",
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: 1,
  tool_choice: null,
  tools: [],
  top_p: null,
  ...overrides,
})

const makeStream = (chunks: Array<StreamChunk>): ResponsesStream =>
  (async function* () {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
  })() as ResponsesStream

const collect = (chunks: Array<StreamChunk>) =>
  collectResponsesStreamResult({
    upstreamResponse: makeStream(chunks),
    logger: consola,
  })

describe("responses stream collection", () => {
  test("collects output items by index and returns the terminal response", async () => {
    const result = makeResult({ output: [], output_text: "" })
    const firstItem = makeResult().output[0]
    const secondItem = {
      id: "msg-second",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [
        {
          type: "output_text",
          text: "second",
          annotations: [],
        },
      ],
    }

    const collected = await collect([
      { event: "ping", data: "ignored" },
      {},
      { data: "not-json" },
      {
        data: JSON.stringify({
          item: secondItem,
          output_index: 1,
          sequence_number: 1,
          type: "response.output_item.done",
        }),
      },
      {
        data: JSON.stringify({
          item: firstItem,
          output_index: 0,
          sequence_number: 2,
          type: "response.output_item.done",
        }),
      },
      {
        data: JSON.stringify({
          copilot_usage: { total_nano_aiu: 9 },
          response: result,
          sequence_number: 3,
          type: "response.completed",
        }),
      },
      { data: "[DONE]" },
    ])

    expect(collected.output).toEqual([firstItem, secondItem])
    expect(collected.copilot_usage).toEqual({ total_nano_aiu: 9 })
  })

  test("keeps terminal output when no output-item events were collected", async () => {
    const result = makeResult({ status: "incomplete" })
    const collected = await collect([
      {
        data: JSON.stringify({
          response: result,
          sequence_number: 1,
          type: "response.incomplete",
        }),
      },
    ])

    expect(collected).toEqual(result)
  })

  test("overlays partial done items without dropping the terminal transcript", async () => {
    const terminalOutput = [
      {
        id: "search-first",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "first" },
      },
      {
        id: "search-second",
        type: "web_search_call",
        status: "completed",
        action: { type: "open", url: "https://example.test" },
      },
      {
        id: "message-complete",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "complete answer",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 8,
                url: "https://example.test",
                title: "Example",
              },
            ],
          },
        ],
      },
    ] as ResponsesResult["output"]
    const terminal = makeResult({ output: terminalOutput })
    const doneFirst = {
      ...terminalOutput[0],
      provider_done_extension: true,
    } as ResponsesResult["output"][number]

    const collected = await collect([
      {
        data: JSON.stringify({
          item: doneFirst,
          output_index: 0,
          sequence_number: 1,
          type: "response.output_item.done",
        }),
      },
      {
        data: JSON.stringify({
          response: terminal,
          sequence_number: 2,
          type: "response.completed",
        }),
      },
    ])

    expect(collected.output).toEqual([
      doneFirst,
      terminalOutput[1],
      terminalOutput[2],
    ])
  })

  test("rejects output-index gaps instead of compacting the transcript", async () => {
    const result = makeResult({ output: [] })
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            item: makeResult().output[0],
            output_index: 2,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            response: result,
            sequence_number: 2,
            type: "response.completed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses terminal output is missing output_index 0",
    )
  })

  test("keeps waiting for a typed terminal after an early DONE marker", async () => {
    const result = makeResult()
    const collected = await collect([
      { data: "[DONE]" },
      {
        data: JSON.stringify({
          response: result,
          sequence_number: 1,
          type: "response.completed",
        }),
      },
    ])

    expect(collected).toEqual(result)
  })

  test("surfaces an independent error with a content-safe message", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            code: "upstream_error",
            error: { code: "upstream_error", message: "stream failed" },
            message: "fallback message",
            param: null,
            sequence_number: 1,
            type: "error",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses upstream reported an error",
    )
  })

  test("surfaces a failed response with a content-safe message", async () => {
    const failedResult = makeResult({
      error: { code: "upstream_error", message: "response failed" },
      output: [],
      output_text: "",
      status: "failed",
    })
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            response: failedResult,
            sequence_number: 1,
            type: "response.failed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses upstream reported an error",
    )
  })

  test("exposes failed terminal usage without retaining private response data", async () => {
    const failedResult = makeResult({
      error: {
        code: "server_error",
        message: "private upstream detail bearer-secret",
      },
      id: "resp-private-opaque-id",
      output: [
        {
          id: "msg-private-output",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "private generated output",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "private generated output",
      status: "failed",
      usage: {
        input_tokens: 21,
        input_tokens_details: {
          cached_tokens: 5,
          cache_write_tokens: 3,
        },
        output_tokens: 8,
        total_tokens: 29,
      },
    })

    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            copilot_usage: { total_nano_aiu: 4_500_000_000 },
            response: failedResult,
            sequence_number: 1,
            type: "response.failed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BufferedResponsesTerminalError)
    expect((thrown as BufferedResponsesTerminalError).failure).toEqual({
      errorCode: "upstream_error",
      message: "Responses upstream reported an error",
      terminal: "response.failed",
      usage: {
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
        input_tokens: 13,
        output_tokens: 8,
        total_nano_aiu: 4_500_000_000,
        total_tokens: 29,
      },
    })
    const serialized = JSON.stringify(thrown)
    expect(serialized).not.toContain("private upstream")
    expect(serialized).not.toContain("resp-private")
    expect(serialized).not.toContain("private generated")
  })

  test("normalizes usage attached to an independent error terminal", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            code: "rate_limit_exceeded",
            copilot_usage: { total_nano_aiu: 700 },
            error: {
              code: "rate_limit_exceeded",
              message: "private provider quota detail",
            },
            message: "private provider quota detail",
            sequence_number: 1,
            type: "error",
            usage: {
              input_tokens: 12,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 1,
              total_tokens: 13,
            },
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BufferedResponsesTerminalError)
    expect((thrown as BufferedResponsesTerminalError).failure).toEqual({
      errorCode: "rate_limited",
      message: "Responses upstream reported an error",
      terminal: "error",
      usage: {
        cache_read_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 1,
        total_nano_aiu: 700,
        total_tokens: 13,
      },
    })
    expect(JSON.stringify(thrown)).not.toContain("private provider")
  })

  test("uses a fixed safe message for a failed response without details", async () => {
    const failedResult = makeResult({
      output: [],
      output_text: "",
      status: "failed",
    })
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        errorMessagePrefix: "Codex responses stream",
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              response: failedResult,
              sequence_number: 1,
              type: "response.failed",
            }),
          },
        ]),
        logger: consola,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses upstream reported an error",
    )
  })

  test("throws when the stream ends without a terminal event", async () => {
    let thrown: unknown
    try {
      await collect([{ data: "[DONE]" }])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses stream ended without a terminal event",
    )
  })

  test("throws when a terminal event omits its response", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            sequence_number: 1,
            type: "response.failed",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      "Responses stream ended without a terminal event",
    )
  })
})
