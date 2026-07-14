import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/routes/messages/anthropic-types"
import type {
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputItem,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseReasoningSummaryPartAddedEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponseRefusalDeltaEvent,
  ResponseRefusalDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
} from "~/services/copilot/create-responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { REASONING_SUMMARY_SEPARATOR } from "~/routes/messages/responses-translation"

const createFunctionCallAddedEvent = (): ResponseOutputItemAddedEvent => ({
  type: "response.output_item.added",
  sequence_number: 1,
  output_index: 1,
  item: {
    id: "item-1",
    type: "function_call",
    call_id: "call-1",
    name: "TodoWrite",
    arguments: "",
    status: "in_progress",
  },
})

const createCompletedEvent = (
  output: Array<ResponseOutputItem>,
): ResponseCompletedEvent => ({
  type: "response.completed",
  sequence_number: 100,
  response: {
    id: "resp-terminal",
    object: "response",
    created_at: 0,
    model: "gpt-5.6-sol",
    output,
    output_text: "",
    status: "completed",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: null,
    tools: [],
    top_p: null,
  },
})

test("response.created clamps ordinary input usage and preserves cache buckets", () => {
  const state = createResponsesStreamState()
  const events = translateResponsesStreamEvent(
    {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp-usage",
        object: "response",
        created_at: 0,
        model: "gpt-5.6-sol",
        output: [],
        output_text: "",
        status: "in_progress",
        usage: {
          input_tokens: 10,
          input_tokens_details: {
            cached_tokens: 8,
            cache_write_tokens: 7,
          },
          output_tokens: 3,
          total_tokens: 13,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
      },
    } satisfies ResponseCreatedEvent,
    state,
  )

  expect(events[0]).toMatchObject({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 8,
      },
    },
  })
})

describe("translateResponsesStreamEvent tool calls", () => {
  test("streams function call arguments across deltas", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"todos":',
        } as ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 3,
          delta: "[]}",
        } as ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 4,
          arguments: '{"todos":[]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"todos":',
    })
    expect(deltas[1].delta).toEqual({
      type: "input_json_delta",
      partial_json: "[]}",
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits full arguments when only done payload is present", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments:
            '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
    ].flat()

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json:
        '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("emits the missing suffix from canonical function arguments", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"a":',
        } satisfies ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 3,
          arguments: '{"a":1}',
        } satisfies ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
    ].flat()

    expect(
      events
        .flatMap((event) =>
          (
            event.type === "content_block_delta"
            && event.delta.type === "input_json_delta"
          ) ?
            [event.delta.partial_json]
          : [],
        )
        .join(""),
    ).toBe('{"a":1}')
  })

  test("fails closed when canonical function arguments are invalid JSON", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(createFunctionCallAddedEvent(), state)
    translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        output_index: 1,
        sequence_number: 2,
        delta: '{"a":',
      } satisfies ResponseFunctionCallArgumentsDeltaEvent,
      state,
    )

    const events = translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.done",
        item_id: "item-1",
        name: "TodoWrite",
        output_index: 1,
        sequence_number: 3,
        arguments: '{"a":',
      } satisfies ResponseFunctionCallArgumentsDoneEvent,
      state,
    )

    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message:
          "Responses function arguments done value is not a valid JSON object.",
      },
    })
    expect(events.some((event) => event.type === "content_block_stop")).toBe(
      false,
    )
    expect(state.messageCompleted).toBe(true)
  })

  test("fails closed when canonical function arguments diverge", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(createFunctionCallAddedEvent(), state)
    translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        output_index: 1,
        sequence_number: 2,
        delta: '{"a":',
      } satisfies ResponseFunctionCallArgumentsDeltaEvent,
      state,
    )

    const events = translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.done",
        item_id: "item-1",
        name: "TodoWrite",
        output_index: 1,
        sequence_number: 3,
        arguments: '{"b":1}',
      } satisfies ResponseFunctionCallArgumentsDoneEvent,
      state,
    )

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        message:
          "Responses function arguments done value diverged from streamed deltas.",
      },
    })
    expect(events.some((event) => event.type === "content_block_stop")).toBe(
      false,
    )
  })

  test("uses streamed tool call state when completed output is empty", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments: '{"todos":[]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp-1",
            object: "response",
            created_at: 0,
            model: "gpt-5.4",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          },
        } as ResponseCompletedEvent,
        state,
      ),
    ].flat()

    const messageDelta = events.find((event) => event.type === "message_delta")
    expect(messageDelta).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    })
    expect(state.hasToolCall).toBe(true)
  })

  test("uses namespace as streamed function call tool name", () => {
    const state = createResponsesStreamState()

    const events = translateResponsesStreamEvent(
      {
        ...createFunctionCallAddedEvent(),
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: "",
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "mcp__fetch__fetch",
        input: {},
      })
    }
  })

  test("streams tool_search_call as the bridge tool use", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "in_progress",
          },
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "completed",
          },
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "mcp__tool_search__search",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"names":"mcp__fetch__fetch,TaskList"}',
    })
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("streams tool_search_call with the configured bridge alias", () => {
    const state = createResponsesStreamState({
      toolSearchName: "tool_search_search",
    })

    const events = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 1,
        item: {
          id: "search-1",
          type: "tool_search_call",
          call_id: "call-search",
          arguments: { names: ["mcp__fetch__fetch"] },
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "tool_search_search",
        input: {},
      })
    }
  })

  test("suppresses reasoning events when thinking is disabled", () => {
    const state = createResponsesStreamState({ emitThinking: false })
    const events: Array<ResponseOutputItemDoneEvent> = [
      {
        type: "response.output_item.done",
        sequence_number: 1,
        output_index: 0,
        item: {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "hidden reasoning" }],
          encrypted_content: "opaque",
          status: "completed",
        },
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 1,
        item: {
          id: "compaction-1",
          type: "compaction",
          encrypted_content: "opaque-compaction",
        },
      },
    ]

    expect(
      events.flatMap((event) => translateResponsesStreamEvent(event, state)),
    ).toEqual([])
    expect(state.openBlocks.size).toBe(0)
  })
})

describe("translateResponsesStreamEvent reasoning summaries", () => {
  test("does not emit a signature delta without an encrypted reasoning carrier", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 1,
          part: { type: "summary_text", text: "" },
        } satisfies ResponseReasoningSummaryPartAddedEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 2,
          delta: "Visible summary",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          output_index: 0,
          sequence_number: 3,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Visible summary" }],
            status: "completed",
          },
        } satisfies ResponseOutputItemDoneEvent,
        state,
      ),
    ].flat()

    expect(
      events.filter(
        (event) =>
          event.type === "content_block_delta"
          && event.delta.type === "signature_delta",
      ),
    ).toEqual([])
  })

  test("does not open a summary block when thinking is disabled", () => {
    const state = createResponsesStreamState({ emitThinking: false })

    const events = translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_part.added",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 1,
        sequence_number: 1,
        part: { type: "summary_text", text: "" },
      } satisfies ResponseReasoningSummaryPartAddedEvent,
      state,
    )

    expect(events).toEqual([])
    expect(state.openBlocks.size).toBe(0)
  })

  test("does not insert a separator before the first non-empty summary", () => {
    const state = createResponsesStreamState()
    const partAdded = (summaryIndex: number, sequenceNumber: number) =>
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: summaryIndex,
          sequence_number: sequenceNumber,
          part: { type: "summary_text", text: "" },
        } satisfies ResponseReasoningSummaryPartAddedEvent,
        state,
      )

    partAdded(0, 1)
    translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.done",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        text: "",
      } satisfies ResponseReasoningSummaryTextDoneEvent,
      state,
    )
    const events = partAdded(1, 3)

    expect(events).not.toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: REASONING_SUMMARY_SEPARATOR,
      },
    })
  })

  test("separates delta and done-only summaries exactly once", () => {
    const state = createResponsesStreamState()
    const partAdded = (summaryIndex: number, sequenceNumber: number) =>
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: summaryIndex,
          sequence_number: sequenceNumber,
          part: { type: "summary_text", text: "" },
        } satisfies ResponseReasoningSummaryPartAddedEvent,
        state,
      )

    const events = [
      partAdded(0, 1),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 2,
          text: "**Preparing the request**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
      partAdded(1, 3),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 4,
          delta: "**Running ",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 5,
          delta: "the tool**",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      partAdded(2, 6),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 2,
          sequence_number: 7,
          text: "**Finishing**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
    ].flat()

    const thinking = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "thinking_delta"
        ) ?
          [event.delta.thinking]
        : [],
      )
      .join("")

    expect(thinking).toBe(
      "**Preparing the request**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Running the tool**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Finishing**",
    )
  })
})

describe("translateResponsesStreamEvent canonical done values", () => {
  test("emits the missing suffix from the canonical output text done value", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_text.delta",
          item_id: "message-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 1,
          delta: "hel",
        } satisfies ResponseTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_text.done",
          item_id: "message-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 2,
          text: "hello",
        } satisfies ResponseTextDoneEvent,
        state,
      ),
    ].flat()

    expect(
      events
        .flatMap((event) =>
          (
            event.type === "content_block_delta"
            && event.delta.type === "text_delta"
          ) ?
            [event.delta.text]
          : [],
        )
        .join(""),
    ).toBe("hello")
  })

  test("fails closed when output text done diverges from streamed deltas", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(
      {
        type: "response.output_text.delta",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        delta: "hel",
      } satisfies ResponseTextDeltaEvent,
      state,
    )

    const events = translateResponsesStreamEvent(
      {
        type: "response.output_text.done",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        sequence_number: 2,
        text: "hero",
      } satisfies ResponseTextDoneEvent,
      state,
    )

    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message:
          "Responses output text done value diverged from streamed deltas.",
      },
    })
    expect(events.some((event) => event.type === "content_block_stop")).toBe(
      false,
    )
    expect(state.messageCompleted).toBe(true)
  })

  test("emits the missing suffix from the canonical reasoning done value", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 1,
          delta: "Think",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 2,
          text: "Thinking",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
    ].flat()

    expect(
      events
        .flatMap((event) =>
          (
            event.type === "content_block_delta"
            && event.delta.type === "thinking_delta"
          ) ?
            [event.delta.thinking]
          : [],
        )
        .join(""),
    ).toBe("Thinking")
  })

  test("fails closed when reasoning done diverges from streamed deltas", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        delta: "Think",
      } satisfies ResponseReasoningSummaryTextDeltaEvent,
      state,
    )

    const events = translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.done",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        text: "Reasoned",
      } satisfies ResponseReasoningSummaryTextDoneEvent,
      state,
    )

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        message:
          "Responses reasoning summary done value diverged from streamed deltas.",
      },
    })
  })

  test("translates streaming refusals into visible Anthropic text", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.refusal.delta",
          item_id: "message-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 1,
          delta: "I can",
        } satisfies ResponseRefusalDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.refusal.done",
          item_id: "message-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 2,
          refusal: "I cannot help.",
        } satisfies ResponseRefusalDoneEvent,
        state,
      ),
    ].flat()

    expect(
      events
        .flatMap((event) =>
          (
            event.type === "content_block_delta"
            && event.delta.type === "text_delta"
          ) ?
            [event.delta.text]
          : [],
        )
        .join(""),
    ).toBe("I cannot help.")
  })

  test("translates refusal content-part done into visible Anthropic text", () => {
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(
      {
        type: "response.content_part.done",
        content_index: 0,
        item_id: "message-1",
        output_index: 0,
        part: {
          type: "refusal",
          refusal: "I cannot comply.",
        },
        sequence_number: 1,
      },
      state,
    )

    expect(
      events.flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          [event.delta.text]
        : [],
      ),
    ).toEqual(["I cannot comply."])
  })

  test("backfills refusal text that exists only in the terminal response", () => {
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(
      createCompletedEvent([
        {
          id: "message-1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot comply." }],
        },
      ]),
      state,
    )

    expect(
      events.flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          [event.delta.text]
        : [],
      ),
    ).toEqual(["I cannot comply."])
  })

  test("backfills text that exists only in the terminal response", () => {
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(
      createCompletedEvent([
        {
          id: "message-1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "terminal text", annotations: [] },
          ],
        },
      ]),
      state,
    )

    expect(
      events.flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          [event.delta.text]
        : [],
      ),
    ).toEqual(["terminal text"])
  })

  test("backfills a function call that exists only in the terminal response", () => {
    const state = createResponsesStreamState()
    const events = translateResponsesStreamEvent(
      createCompletedEvent([
        {
          type: "function_call",
          call_id: "call-terminal",
          name: "lookup",
          arguments: '{"query":"terminal"}',
          status: "completed",
        },
      ]),
      state,
    )

    expect(events).toContainEqual({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call-terminal",
        name: "lookup",
        input: {},
      },
    })
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"query":"terminal"}',
      },
    })
  })

  test("does not reopen completed tool blocks during terminal backfill", () => {
    const state = createResponsesStreamState()
    const terminalCalls = [
      {
        type: "function_call" as const,
        call_id: "call-0",
        name: "lookup",
        arguments: '{"query":"zero"}',
        status: "completed" as const,
      },
      {
        type: "function_call" as const,
        call_id: "call-1",
        name: "lookup",
        arguments: '{"query":"one"}',
        status: "completed" as const,
      },
    ]
    const streamedEvents = terminalCalls.flatMap((item, outputIndex) => [
      ...translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          item,
          output_index: outputIndex,
          sequence_number: outputIndex * 2,
        },
        state,
      ),
      ...translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          arguments: item.arguments,
          item_id: item.call_id,
          name: item.name,
          output_index: outputIndex,
          sequence_number: outputIndex * 2 + 1,
        },
        state,
      ),
    ])
    const terminalEvents = translateResponsesStreamEvent(
      createCompletedEvent(terminalCalls),
      state,
    )
    const starts = [...streamedEvents, ...terminalEvents].filter(
      (event) => event.type === "content_block_start",
    )

    expect(starts).toHaveLength(2)
    expect(starts.map((event) => event.index)).toEqual([0, 1])
  })

  test("does not reopen completed text during mixed terminal backfill", () => {
    const state = createResponsesStreamState()
    const functionCall = {
      type: "function_call" as const,
      call_id: "call-1",
      name: "lookup",
      arguments: '{"query":"one"}',
      status: "completed" as const,
    }
    const streamedEvents = [
      ...translateResponsesStreamEvent(
        {
          type: "response.output_text.delta",
          content_index: 0,
          delta: "answer",
          item_id: "message-0",
          output_index: 0,
          sequence_number: 1,
        },
        state,
      ),
      ...translateResponsesStreamEvent(
        {
          type: "response.output_text.done",
          content_index: 0,
          item_id: "message-0",
          output_index: 0,
          sequence_number: 2,
          text: "answer",
        },
        state,
      ),
      ...translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          item: functionCall,
          output_index: 1,
          sequence_number: 3,
        },
        state,
      ),
      ...translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          arguments: functionCall.arguments,
          item_id: functionCall.call_id,
          name: functionCall.name,
          output_index: 1,
          sequence_number: 4,
        },
        state,
      ),
    ]
    const terminalEvents = translateResponsesStreamEvent(
      createCompletedEvent([
        {
          id: "message-0",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
        functionCall,
      ]),
      state,
    )
    const starts = [...streamedEvents, ...terminalEvents].filter(
      (event) => event.type === "content_block_start",
    )

    expect(starts).toHaveLength(2)
    expect(starts.map((event) => event.index)).toEqual([0, 1])
  })
})
