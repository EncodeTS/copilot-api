import { describe, expect, test } from "bun:test"
import consola from "consola"

import { UpstreamLifecycleTimeoutError } from "~/lib/upstream-lifecycle"

import type {
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import {
  BufferedResponsesCollectionLimitError,
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

  test("rejects more collected output items than the configured limit", async () => {
    const firstItem = makeResult().output[0]
    const secondItem = { ...firstItem, id: "msg-second" }

    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 1_024,
        maxOutputItems: 1,
        maxTotalOutputItemBytes: 2_048,
      },
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            item: firstItem,
            output_index: 0,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            item: secondItem,
            output_index: 1,
            sequence_number: 2,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            response: makeResult({ output: [firstItem, secondItem] }),
            sequence_number: 3,
            type: "response.completed",
          }),
        },
      ]),
      logger: consola,
    })

    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      limit: 1,
      name: "BufferedResponsesCollectionLimitError",
      observed: 2,
      violation: "output-item-count",
    })
    expect(Object.hasOwn(thrown as object, "record")).toBe(false)
  })

  test("rejects terminal-only output items above the item-count limit", async () => {
    const firstItem = makeResult().output[0]
    const secondItem = {
      ...firstItem,
      content: [
        {
          annotations: [],
          text: "private terminal capped content",
          type: "output_text" as const,
        },
      ],
      id: "terminal-second",
    }

    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 1_024,
        maxOutputItems: 1,
        maxTotalOutputItemBytes: 2_048,
      },
      logger: consola,
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            copilot_usage: { total_nano_aiu: 55 },
            response: makeResult({ output: [firstItem, secondItem] }),
            sequence_number: 1,
            type: "response.completed",
          }),
        },
      ]),
    })

    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BufferedResponsesCollectionLimitError)
    expect(thrown).toMatchObject({
      limit: 1,
      name: "BufferedResponsesCollectionLimitError",
      observed: 2,
      record: {
        metadata: {
          errorCode: "invalid_response",
          outcome: "failed",
          terminal: "response.completed",
        },
        usage: {
          cache_read_input_tokens: 0,
          input_tokens: 2,
          output_tokens: 1,
          total_nano_aiu: 55,
          total_tokens: 3,
        },
      },
      violation: "output-item-count",
    })
    const record = (thrown as BufferedResponsesCollectionLimitError).record
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record?.metadata)).toBe(true)
    expect(Object.isFrozen(record?.usage)).toBe(true)
    expect(JSON.stringify(thrown)).not.toContain("private terminal capped")
  })

  test("rejects a terminal-only output index above the index limit", () => {
    const firstItem = makeResult().output[0]
    const secondItem = { ...firstItem, id: "terminal-second" }

    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 0,
        maxOutputItemBytes: 1_024,
        maxOutputItems: 16,
        maxTotalOutputItemBytes: 2_048,
      },
      logger: consola,
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            response: makeResult({ output: [firstItem, secondItem] }),
            sequence_number: 1,
            type: "response.completed",
          }),
        },
      ]),
    })

    expect(result).rejects.toMatchObject({
      limit: 0,
      name: "BufferedResponsesCollectionLimitError",
      observed: 1,
      violation: "output-index",
    })
  })

  test("rejects a collected output index above the configured limit", async () => {
    const privateItem = {
      ...makeResult().output[0],
      content: [
        {
          annotations: [],
          text: "private sparse output marker",
          type: "output_text" as const,
        },
      ],
    }

    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 1_024,
        maxOutputItems: 16,
        maxTotalOutputItemBytes: 2_048,
      },
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            item: privateItem,
            output_index: 9,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
      ]),
      logger: consola,
    })

    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      limit: 8,
      name: "BufferedResponsesCollectionLimitError",
      observed: 9,
      violation: "output-index",
    })
    expect(JSON.stringify(thrown)).not.toContain("private sparse output marker")
  })

  test("measures the UTF-8 JSON bytes of each collected output item", async () => {
    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 13,
        maxOutputItems: 16,
        maxTotalOutputItemBytes: 2_048,
      },
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            item: { text: "你" },
            output_index: 0,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
      ]),
      logger: consola,
    })

    let thrown: unknown
    try {
      await result
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      limit: 13,
      name: "BufferedResponsesCollectionLimitError",
      observed: 14,
      violation: "output-item-bytes",
    })
    expect(JSON.stringify(thrown)).not.toContain("你")
  })

  test("measures terminal-only output items in UTF-8 JSON bytes", async () => {
    const privateItem = {
      text: "你",
    } as unknown as ResponsesResult["output"][number]
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        collectionLimits: {
          maxOutputIndex: 8,
          maxOutputItemBytes: 13,
          maxOutputItems: 16,
          maxTotalOutputItemBytes: 2_048,
        },
        logger: consola,
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              response: makeResult({ output: [privateItem] }),
              sequence_number: 1,
              type: "response.completed",
            }),
          },
        ]),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      limit: 13,
      name: "BufferedResponsesCollectionLimitError",
      observed: 14,
      violation: "output-item-bytes",
    })
    expect(JSON.stringify(thrown)).not.toContain("你")
  })

  test("rejects collected output items whose cumulative bytes exceed the limit", () => {
    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 12,
        maxOutputItems: 16,
        maxTotalOutputItemBytes: 23,
      },
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            item: { text: "a" },
            output_index: 0,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            item: { text: "b" },
            output_index: 1,
            sequence_number: 2,
            type: "response.output_item.done",
          }),
        },
      ]),
      logger: consola,
    })

    expect(result).rejects.toMatchObject({
      limit: 23,
      name: "BufferedResponsesCollectionLimitError",
      observed: 24,
      violation: "total-output-item-bytes",
    })
  })

  test("rejects terminal-only output items above the cumulative byte limit", () => {
    const firstItem = {
      text: "a",
    } as unknown as ResponsesResult["output"][number]
    const secondItem = {
      text: "b",
    } as unknown as ResponsesResult["output"][number]
    const result = collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 12,
        maxOutputItems: 16,
        maxTotalOutputItemBytes: 23,
      },
      logger: consola,
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            response: makeResult({ output: [firstItem, secondItem] }),
            sequence_number: 1,
            type: "response.completed",
          }),
        },
      ]),
    })

    expect(result).rejects.toMatchObject({
      limit: 23,
      name: "BufferedResponsesCollectionLimitError",
      observed: 24,
      violation: "total-output-item-bytes",
    })
  })

  test("replaces an output index without double-counting its retained bytes", async () => {
    const initialItem = {
      text: "aaaaaa",
    } as unknown as ResponsesResult["output"][number]
    const oversizedTerminalItem = {
      text: "aaaaaaa",
    } as unknown as ResponsesResult["output"][number]
    const replacementItem = {
      text: "a",
    } as unknown as ResponsesResult["output"][number]
    const secondItem = {
      text: "b",
    } as unknown as ResponsesResult["output"][number]

    const collected = await collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 8,
        maxOutputItemBytes: 17,
        maxOutputItems: 2,
        maxTotalOutputItemBytes: 24,
      },
      upstreamResponse: makeStream([
        {
          data: JSON.stringify({
            item: initialItem,
            output_index: 0,
            sequence_number: 1,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            item: replacementItem,
            output_index: 0,
            sequence_number: 2,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            item: secondItem,
            output_index: 1,
            sequence_number: 3,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            response: makeResult({
              output: [oversizedTerminalItem, secondItem],
            }),
            sequence_number: 4,
            type: "response.completed",
          }),
        },
      ]),
      logger: consola,
    })

    expect(collected.output).toEqual([replacementItem, secondItem])
  })

  test("does not truncate a long stream by its unrelated event count", async () => {
    const item = makeResult().output[0]
    const deltaEvents = Array.from({ length: 2_048 }, (_, sequenceNumber) => ({
      data: JSON.stringify({
        content_index: 0,
        delta: "x",
        item_id: item.id,
        output_index: 0,
        sequence_number: sequenceNumber,
        type: "response.output_text.delta",
      }),
    }))

    const collected = await collectResponsesStreamResult({
      collectionLimits: {
        maxOutputIndex: 0,
        maxOutputItemBytes: 1_024,
        maxOutputItems: 1,
        maxTotalOutputItemBytes: 1_024,
      },
      upstreamResponse: makeStream([
        ...deltaEvents,
        {
          data: JSON.stringify({
            item,
            output_index: 0,
            sequence_number: 2_048,
            type: "response.output_item.done",
          }),
        },
        {
          data: JSON.stringify({
            response: makeResult(),
            sequence_number: 2_049,
            type: "response.completed",
          }),
        },
      ]),
      logger: consola,
    })

    expect(collected.output).toEqual([item])
  })

  test("carries terminal usage safely when terminal delivery fails", async () => {
    const privateResult = makeResult({
      id: "private-terminal-response-id",
      output_text: "private terminal output",
    })
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        logger: consola,
        onEvent: (event) => {
          if (event.type === "response.completed") {
            throw new Error("private terminal delivery failure")
          }
        },
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              copilot_usage: { total_nano_aiu: 900 },
              response: privateResult,
              sequence_number: 1,
              type: "response.completed",
            }),
          },
        ]),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      message: "Responses stream interrupted after a terminal event",
      name: "BufferedResponsesTerminalInterruptionError",
      record: {
        metadata: {
          errorCode: "connection_error",
          outcome: "transport_error",
          terminal: "response.completed",
        },
        usage: {
          cache_read_input_tokens: 0,
          input_tokens: 2,
          output_tokens: 1,
          total_nano_aiu: 900,
          total_tokens: 3,
        },
      },
      surfacedError: {
        message: "Responses stream delivery failed after terminal event",
      },
    })
    const interruption = thrown as {
      record: { metadata: unknown; usage: unknown }
    }
    expect(Object.isFrozen(interruption.record)).toBe(true)
    expect(Object.isFrozen(interruption.record.metadata)).toBe(true)
    expect(Object.isFrozen(interruption.record.usage)).toBe(true)
    expect(String(thrown)).not.toContain("private terminal")
    expect(JSON.stringify(thrown)).not.toContain("private-terminal")
    expect(JSON.stringify(thrown)).not.toContain("private terminal")
  })

  test("carries terminal usage safely when delivery is aborted", async () => {
    const controller = new AbortController()
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        logger: consola,
        onEvent: (event) => {
          if (event.type === "response.completed") {
            controller.abort(new Error("private terminal abort reason"))
          }
        },
        signal: controller.signal,
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              copilot_usage: { total_nano_aiu: 901 },
              response: makeResult(),
              sequence_number: 1,
              type: "response.completed",
            }),
          },
        ]),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: "BufferedResponsesTerminalInterruptionError",
      record: {
        metadata: {
          errorCode: "caller_aborted",
          outcome: "aborted",
          terminal: "response.completed",
        },
        usage: { total_nano_aiu: 901, total_tokens: 3 },
      },
      surfacedError: {
        message: "Responses stream aborted after terminal event",
      },
    })
    expect(String(thrown)).not.toContain("private terminal abort")
    expect(JSON.stringify(thrown)).not.toContain("private terminal abort")
  })

  test("carries terminal usage safely when delivery times out", async () => {
    const controller = new AbortController()
    let thrown: unknown
    try {
      await collectResponsesStreamResult({
        logger: consola,
        onEvent: (event) => {
          if (event.type === "response.completed") {
            controller.abort(
              new UpstreamLifecycleTimeoutError(
                "private terminal timeout phase",
                999,
              ),
            )
          }
        },
        signal: controller.signal,
        upstreamResponse: makeStream([
          {
            data: JSON.stringify({
              copilot_usage: { total_nano_aiu: 902 },
              response: makeResult(),
              sequence_number: 1,
              type: "response.completed",
            }),
          },
        ]),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: "BufferedResponsesTerminalInterruptionError",
      record: {
        metadata: {
          errorCode: "upstream_timeout",
          outcome: "transport_error",
          terminal: "response.completed",
        },
        usage: { total_nano_aiu: 902, total_tokens: 3 },
      },
      surfacedError: {
        message: "Responses stream timed out after terminal event",
      },
    })
    expect(String(thrown)).not.toContain("private terminal timeout")
    expect(JSON.stringify(thrown)).not.toContain("private terminal timeout")
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

  test("does not treat a prototype key as an independent-error alias", async () => {
    let thrown: unknown
    try {
      await collect([
        {
          data: JSON.stringify({
            code: "constructor",
            error: {
              code: "constructor",
              message: "private prototype-key detail",
            },
            message: "private prototype-key detail",
            sequence_number: 1,
            type: "error",
          }),
        },
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BufferedResponsesTerminalError)
    expect((thrown as BufferedResponsesTerminalError).failure.errorCode).toBe(
      "upstream_error",
    )
    expect(JSON.stringify(thrown)).not.toContain("private prototype-key")
  })

  test("does not treat a prototype key as a failed-response alias", async () => {
    const failedResult = makeResult({
      error: {
        code: "toString",
        message: "private failed prototype-key detail",
      },
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

    expect(thrown).toBeInstanceOf(BufferedResponsesTerminalError)
    expect((thrown as BufferedResponsesTerminalError).failure.errorCode).toBe(
      "response_failed",
    )
    expect(JSON.stringify(thrown)).not.toContain("private failed prototype-key")
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
