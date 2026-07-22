import { describe, expect, test } from "bun:test"
import consola from "consola"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import {
  buildSyntheticStreamEvents,
  createWebSearchFlow,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  resolveWebSearchRoute,
} from "~/routes/messages/web-search/fulfill"
import { webSearchCarrierSanitizer } from "~/routes/messages/web-search/carrier-sanitizer"
import {
  decodeWebSearchHistoryCarrier,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
} from "~/routes/messages/web-search/history-carrier"
import type { ResponsesResult } from "~/services/copilot/create-responses"

const mixedPayload = (): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4.5",
  max_tokens: 1_024,
  messages: [
    {
      role: "user",
      content: "Search the release notes and inspect the local runtime.",
    },
  ],
  tools: [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    },
    {
      name: "inspect_runtime",
      description: "Return the local runtime version.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
})

const waitingResult = (): ResponsesResult =>
  ({
    id: "resp-mixed-waiting",
    object: "response",
    created_at: 0,
    model: "gpt-5-mini",
    output: [
      {
        id: "search-deferred",
        type: "web_search_call",
        status: "in_progress",
        action: { type: "search", query: "runtime release notes", sources: [] },
      },
      {
        id: "function-runtime",
        type: "function_call",
        call_id: "toolu-runtime",
        name: "inspect_runtime",
        arguments: "{}",
        status: "completed",
      },
    ],
    output_text: "",
    status: "completed",
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 5,
      total_tokens: 25,
    },
    copilot_usage: { total_nano_aiu: 17 },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: null,
    tools: [],
    top_p: null,
  }) as ResponsesResult

const completedResult = (): ResponsesResult => ({
  ...waitingResult(),
  id: "resp-mixed-completed",
  output: [
    {
      id: "search-deferred",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "runtime release notes",
        sources: [
          {
            type: "url",
            url: "https://example.test/runtime",
            title: "Runtime release notes",
          },
        ],
      },
    },
    {
      id: "message-mixed-completed",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Node.js 24 is current.",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.test/runtime",
              title: "Runtime release notes",
              start_index: 0,
              end_index: 10,
            },
          ],
        },
      ],
    },
  ],
})

const makeJsonContext = () => {
  const captured: { headers: Record<string, string>; json?: unknown } = {
    headers: {},
  }
  return {
    c: {
      header(name: string, value: string) {
        captured.headers[name.toLowerCase()] = value
      },
      json(value: unknown) {
        captured.json = value
        return new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        })
      },
    } as never,
    captured,
  }
}

const reconstructWaitingResponse = () =>
  reconstructWebSearchResponse(mixedPayload(), waitingResult(), {
    requestId: "request-mixed-waiting",
    carrierSource: {
      destination: "responses",
      adapter: "copilot-responses",
      provider: "copilot",
      model: "gpt-5-mini",
    },
  })

const twoClientContinuation = () => {
  const payload = mixedPayload()
  payload.tools?.push({
    name: "read_config",
    description: "Read the selected local configuration key.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  })
  const result = waitingResult()
  result.output.push({
    id: "function-config",
    type: "function_call",
    call_id: "toolu-config",
    name: "read_config",
    arguments: '{"key":"runtime"}',
    status: "completed",
  })
  const response = reconstructWebSearchResponse(payload, result, {
    requestId: "request-two-client-tools",
    carrierSource: {
      destination: "responses",
      adapter: "copilot-responses",
      provider: "copilot",
      model: "gpt-5-mini",
    },
  }).response
  return { payload, response }
}

describe("Responses Web Search mixed server/client tools", () => {
  test("routes the official mixed-tool shape and preserves both tool definitions", () => {
    const payload = mixedPayload()

    expect(
      resolveWebSearchRoute(payload, {
        responsesWebSearchEnabled: true,
        webSearchModel: "gpt-5-mini",
      }),
    ).toEqual({ kind: "responses", model: "gpt-5-mini" })

    const translated = prepareWebSearchResponsesPayload(payload, {
      model: "gpt-5-mini",
    })

    expect(translated.tools).toEqual([
      {
        type: "function",
        name: "inspect_runtime",
        description: "Return the local runtime version.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        strict: false,
      },
      { type: "web_search" },
    ])
  })

  test("surfaces the official unresolved server call beside the client tool call", () => {
    const reconstructed = reconstructWaitingResponse()

    expect(reconstructed.response.stop_reason).toBe("tool_use")
    expect(reconstructed.response.content).toHaveLength(2)
    expect(reconstructed.response.content[0]).toMatchObject({
      type: "server_tool_use",
      id: "search-deferred",
      name: "web_search",
      input: { query: "runtime release notes" },
    })
    expect(reconstructed.response.content[1]).toEqual({
      type: "tool_use",
      id: "toolu-runtime",
      name: "inspect_runtime",
      input: {},
    })

    const firstBlock = reconstructed.response.content[0] as {
      input: Record<string, unknown>
    }
    const decoded = decodeWebSearchHistoryCarrier(
      firstBlock.input[WEB_SEARCH_HISTORY_CARRIER_FIELD],
      {
        destination: "responses",
        canonicalTarget: {
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      },
    )
    expect(decoded).toMatchObject({
      kind: "accepted",
      envelope: {
        continuation: {
          kind: "waiting_client_tools",
          pending_server_tool_use_ids: ["search-deferred"],
          pending_client_tool_use_ids: ["toolu-runtime"],
        },
      },
    })

    const streamEvents = buildSyntheticStreamEvents(reconstructed.response)
    expect(
      streamEvents
        .filter((event) => event.type === "content_block_start")
        .map((event) =>
          event.type === "content_block_start" ?
            event.content_block.type
          : null,
        ),
    ).toEqual(["server_tool_use", "tool_use"])
    expect(
      streamEvents.filter((event) => event.type === "message_delta"),
    ).toHaveLength(1)
    expect(
      streamEvents.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
  })

  test("fails closed when pending state has only non-resumable top-level text", () => {
    const result = waitingResult()
    result.output_text = "private top-level fallback"

    expect(() =>
      reconstructWebSearchResponse(mixedPayload(), result, {
        requestId: "request-pending-top-level-text",
        carrierSource: {
          destination: "responses",
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      }),
    ).toThrow("non-resumable top-level text")
  })

  test("never turns an incomplete pending item into a waiting handoff", () => {
    const result = waitingResult()
    result.status = "incomplete"
    result.incomplete_details = { reason: "max_output_tokens" }

    expect(() =>
      reconstructWebSearchResponse(mixedPayload(), result, {
        requestId: "request-incomplete-pending",
        carrierSource: {
          destination: "responses",
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      }),
    ).toThrow("incomplete Responses terminal")
  })

  test("keeps a server-only pending call as pause_turn until replayed as-is", () => {
    const result = waitingResult()
    result.output = [result.output[0]]
    const paused = reconstructWebSearchResponse(mixedPayload(), result, {
      requestId: "request-pause-turn",
      carrierSource: {
        destination: "responses",
        adapter: "copilot-responses",
        provider: "copilot",
        model: "gpt-5-mini",
      },
    })
    expect(paused.response.stop_reason).toBe("pause_turn")
    expect(paused.response.content.map((block) => block.type)).toEqual([
      "server_tool_use",
    ])

    const continued = mixedPayload()
    continued.messages = [
      continued.messages[0],
      { role: "assistant", content: paused.response.content },
    ]
    const invalidFollowUp = structuredClone(continued)
    invalidFollowUp.messages.push({ role: "user", content: "new input" })
    expect(() =>
      webSearchCarrierSanitizer.sanitize(invalidFollowUp, {
        destination: "responses",
        canonicalTarget: {
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      }),
    ).toThrow("pending server tools")

    const restored = webSearchCarrierSanitizer.sanitize(continued, {
      destination: "responses",
      canonicalTarget: {
        adapter: "copilot-responses",
        provider: "copilot",
        model: "gpt-5-mini",
      },
    })
    expect(restored.restoredTurns[0]?.continuation.kind).toBe("pause_turn")
  })

  test("restores the deferred server call once after the matching client result", () => {
    const waiting = reconstructWaitingResponse()
    const continued = mixedPayload()
    continued.messages = [
      continued.messages[0],
      { role: "assistant", content: waiting.response.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-runtime",
            content: "Node.js 24",
          },
        ],
      },
    ]

    const sanitization = webSearchCarrierSanitizer.sanitize(continued, {
      destination: "responses",
      canonicalTarget: {
        adapter: "copilot-responses",
        provider: "copilot",
        model: "gpt-5-mini",
      },
    })
    expect(sanitization.turnPhase).toBe("resumed")
    expect(sanitization.resumedPendingServerToolUseIds).toEqual([
      "search-deferred",
    ])
    const translated = prepareWebSearchResponsesPayload(continued, {
      model: "gpt-5-mini",
      restoredWebSearchTurns: sanitization.restoredTurns,
    })
    if (!Array.isArray(translated.input))
      throw new Error("expected input array")

    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; id?: string }).type === "web_search_call"
          && (item as { id?: string }).id === "search-deferred",
      ),
    ).toHaveLength(1)
    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; call_id?: string }).type === "function_call"
          && (item as { call_id?: string }).call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; call_id?: string }).type
            === "function_call_output"
          && (item as { call_id?: string }).call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
  })

  test("completes the official two-turn sequence without replaying the client call", async () => {
    const sentPayloads: Array<unknown> = []
    const usageRecords: Array<unknown> = []
    let dispatchCount = 0
    const flow = createWebSearchFlow({
      createResponses: ((payload: unknown) => {
        sentPayloads.push(payload)
        dispatchCount += 1
        return Promise.resolve(
          dispatchCount === 1 ? waitingResult() : completedResult(),
        )
      }) as never,
      createUsageRecorder: (() =>
        (...args: Array<unknown>) => {
          usageRecords.push(args)
          return "accepted"
        }) as never,
      findEndpointModel: (() => ({
        capabilities: { limits: {}, supports: {} },
        id: "gpt-5-mini",
        supported_endpoints: ["/responses"],
      })) as never,
      getResponsesTransportForModel: (() => "http") as never,
    })

    const firstPayload = mixedPayload()
    const firstContext = makeJsonContext()
    await flow.handleViaResponses(firstContext.c, firstPayload, {
      logger: consola,
      requestId: "request-mixed-first",
      sessionId: "session-mixed",
      webSearchModel: "gpt-5-mini",
    })
    expect(
      firstContext.captured.headers["x-copilot-api-web-search-stream-mode"],
    ).toBe("buffered-synthetic-replay")
    const firstResponse = firstContext.captured.json as {
      content: AnthropicMessagesPayload["messages"][number]["content"]
    }

    const secondPayload = mixedPayload()
    secondPayload.messages = [
      secondPayload.messages[0],
      { role: "assistant", content: firstResponse.content as never },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-runtime",
            content: "Node.js 24",
          },
        ],
      },
    ]
    const secondContext = makeJsonContext()
    await flow.handleViaResponses(secondContext.c, secondPayload, {
      logger: consola,
      requestId: "request-mixed-second",
      sessionId: "session-mixed",
      webSearchModel: "gpt-5-mini",
    })

    expect(dispatchCount).toBe(2)
    const secondSent = sentPayloads[1] as {
      input?: Array<Record<string, unknown>>
    }
    expect(
      secondSent.input?.filter(
        (item) =>
          item.type === "function_call" && item.call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
    expect(
      secondSent.input?.filter(
        (item) =>
          item.type === "function_call_output"
          && item.call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
    const secondResponse = secondContext.captured.json as {
      content: Array<{ type: string }>
      stop_reason: string
    }
    expect(secondResponse.content.map((block) => block.type)).toEqual([
      "web_search_tool_result",
      "text",
    ])
    expect(
      buildSyntheticStreamEvents(
        secondContext.captured.json as Parameters<
          typeof buildSyntheticStreamEvents
        >[0],
      )
        .filter((event) => event.type === "content_block_start")
        .map((event) =>
          event.type === "content_block_start" ?
            event.content_block.type
          : null,
        ),
    ).toEqual(["web_search_tool_result", "text"])
    expect(secondResponse.stop_reason).toBe("end_turn")
    expect(
      (
        secondContext.captured.json as {
          usage: { server_tool_use?: { web_search_requests?: number } }
        }
      ).usage.server_tool_use?.web_search_requests,
    ).toBe(0)
    expect(usageRecords).toHaveLength(2)
    expect(usageRecords.map((record) => (record as Array<unknown>)[0])).toEqual(
      [
        {
          cache_read_input_tokens: 4,
          input_tokens: 16,
          output_tokens: 5,
          total_nano_aiu: 17,
          total_tokens: 25,
        },
        {
          cache_read_input_tokens: 4,
          input_tokens: 16,
          output_tokens: 5,
          total_nano_aiu: 17,
          total_tokens: 25,
        },
      ],
    )
  })

  test("keeps a resolved mixed turn usable in later conversation history", () => {
    const waiting = reconstructWaitingResponse().response
    const completed = reconstructWebSearchResponse(
      mixedPayload(),
      completedResult(),
      {
        requestId: "request-mixed-history-completed",
        carrierSource: {
          destination: "responses",
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
        resumedPendingServerToolUseIds: ["search-deferred"],
        turnPhase: "resumed",
      },
    ).response
    const later = mixedPayload()
    later.messages = [
      later.messages[0],
      { role: "assistant", content: waiting.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-runtime",
            content: "Node.js 24",
          },
        ],
      },
      { role: "assistant", content: completed.content },
      { role: "user", content: "Summarize that result." },
    ]
    later.tools = later.tools?.filter((tool) => tool.name !== "inspect_runtime")

    const sanitization = webSearchCarrierSanitizer.sanitize(later, {
      destination: "responses",
      canonicalTarget: {
        adapter: "copilot-responses",
        provider: "copilot",
        model: "gpt-5-mini",
      },
    })
    const translated = prepareWebSearchResponsesPayload(later, {
      model: "gpt-5-mini",
      restoredWebSearchTurns: sanitization.restoredTurns,
    })
    if (!Array.isArray(translated.input))
      throw new Error("expected input array")

    expect(sanitization.restoredTurns).toHaveLength(1)
    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; id?: string }).type === "web_search_call"
          && (item as { id?: string }).id === "search-deferred",
      ),
    ).toHaveLength(1)
    expect(
      translated.input.find(
        (item) =>
          (item as { type?: string; id?: string }).type === "web_search_call"
          && (item as { id?: string }).id === "search-deferred",
      ),
    ).toMatchObject({
      status: "completed",
      action: {
        sources: [
          {
            type: "url",
            url: "https://example.test/runtime",
            title: "Runtime release notes",
          },
        ],
      },
    })
    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; call_id?: string }).type === "function_call"
          && (item as { call_id?: string }).call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
    expect(
      translated.input.filter(
        (item) =>
          (item as { type?: string; call_id?: string }).type
            === "function_call_output"
          && (item as { call_id?: string }).call_id === "toolu-runtime",
      ),
    ).toHaveLength(1)
  })

  test("requires the same server and client tool definitions on continuation", () => {
    const { payload, response } = twoClientContinuation()
    payload.tools = payload.tools?.filter((tool) => tool.name !== "read_config")
    payload.messages = [
      payload.messages[0],
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-runtime",
            content: "Node.js 24",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu-config",
            content: "runtime=true",
          },
        ],
      },
    ]

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, {
        destination: "responses",
        canonicalTarget: {
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      }),
    ).toThrow("tool contract")
  })

  for (const [label, mutate] of [
    [
      "server version",
      (payload: AnthropicMessagesPayload) => {
        const tool = payload.tools?.[0]
        if (tool && "type" in tool) tool.type = "web_search_20260318"
      },
    ],
    [
      "server max uses",
      (payload: AnthropicMessagesPayload) => {
        const tool = payload.tools?.[0]
        if (tool && "max_uses" in tool) tool.max_uses = 4
      },
    ],
    [
      "server domains",
      (payload: AnthropicMessagesPayload) => {
        const tool = payload.tools?.[0]
        if (tool?.name === "web_search" && "type" in tool) {
          const mutable = tool as { allowed_domains?: Array<string> }
          mutable.allowed_domains = ["changed.example"]
        }
      },
    ],
    [
      "client description",
      (payload: AnthropicMessagesPayload) => {
        const tool = payload.tools?.[1]
        if (tool && "description" in tool) tool.description = "Changed contract"
      },
    ],
    [
      "client schema",
      (payload: AnthropicMessagesPayload) => {
        const tool = payload.tools?.[1]
        if (tool && "input_schema" in tool) {
          tool.input_schema = {
            type: "object",
            properties: { changed: { type: "boolean" } },
          }
        }
      },
    ],
    [
      "tool members",
      (payload: AnthropicMessagesPayload) => {
        payload.tools?.push({
          name: "unexpected_tool",
          input_schema: { type: "object", properties: {} },
        })
      },
    ],
  ] as const) {
    test(`rejects changed ${label} in the exact continuation tool contract`, () => {
      const waiting = reconstructWaitingResponse().response
      const continued = mixedPayload()
      continued.messages = [
        continued.messages[0],
        { role: "assistant", content: waiting.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-runtime",
              content: "Node.js 24",
            },
          ],
        },
      ]
      mutate(continued)

      expect(() =>
        webSearchCarrierSanitizer.sanitize(continued, {
          destination: "responses",
          canonicalTarget: {
            adapter: "copilot-responses",
            provider: "copilot",
            model: "gpt-5-mini",
          },
        }),
      ).toThrow("tool contract")
    })
  }

  test("aborting buffered replay closes the upstream stream source", async () => {
    let closeCount = 0
    let markSecondReadStarted: () => void = () => {}
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve
    })
    const created = {
      ...waitingResult(),
      output: [],
      output_text: "",
      status: "in_progress",
      usage: null,
    }
    const source = {
      [Symbol.asyncIterator]() {
        let readCount = 0
        return {
          next(): Promise<IteratorResult<{ data: string; event: string }>> {
            readCount += 1
            if (readCount === 1) {
              return Promise.resolve({
                done: false,
                value: {
                  event: "response.created",
                  data: JSON.stringify({
                    response: created,
                    sequence_number: 1,
                    type: "response.created",
                  }),
                },
              })
            }
            markSecondReadStarted()
            return new Promise(() => {})
          },
          return(): Promise<IteratorResult<{ data: string; event: string }>> {
            closeCount += 1
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
    const flow = createWebSearchFlow({
      createResponses: (() => Promise.resolve(source)) as never,
      createUsageRecorder: (() => () => "accepted") as never,
      findEndpointModel: (() => ({
        capabilities: { limits: {}, supports: {} },
        id: "gpt-5-mini",
        supported_endpoints: ["/responses"],
      })) as never,
      getResponsesTransportForModel: (() => "http") as never,
    })
    const controller = new AbortController()
    const pending = flow.handleViaResponses(
      makeJsonContext().c,
      mixedPayload(),
      {
        logger: consola,
        requestId: "request-aborted-buffer",
        sessionId: "session-aborted-buffer",
        signal: controller.signal,
        webSearchModel: "gpt-5-mini",
      },
    )

    await secondReadStarted
    controller.abort(new Error("caller aborted"))

    let thrown: unknown
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe("caller aborted")
    expect(closeCount).toBe(1)
  })

  for (const [label, content] of [
    ["missing", []],
    [
      "partial",
      [
        {
          type: "tool_result",
          tool_use_id: "toolu-runtime",
          content: "Node.js 24",
        },
      ],
    ],
    [
      "duplicate",
      [
        {
          type: "tool_result",
          tool_use_id: "toolu-runtime",
          content: "Node.js 24",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu-runtime",
          content: "duplicate",
        },
      ],
    ],
    [
      "out-of-order",
      [
        {
          type: "tool_result",
          tool_use_id: "toolu-config",
          content: "runtime=true",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu-runtime",
          content: "Node.js 24",
        },
      ],
    ],
    [
      "mixed-content",
      [
        {
          type: "tool_result",
          tool_use_id: "toolu-runtime",
          content: "Node.js 24",
        },
        { type: "text", text: "continue anyway" },
        {
          type: "tool_result",
          tool_use_id: "toolu-config",
          content: "runtime=true",
        },
      ],
    ],
  ] as const) {
    test(`rejects ${label} client results before deferred execution`, () => {
      const { payload, response } = twoClientContinuation()
      payload.messages = [
        payload.messages[0],
        { role: "assistant", content: response.content },
        { role: "user", content: structuredClone(content) as never },
      ]

      expect(() =>
        webSearchCarrierSanitizer.sanitize(payload, {
          destination: "responses",
          canonicalTarget: {
            adapter: "copilot-responses",
            provider: "copilot",
            model: "gpt-5-mini",
          },
        }),
      ).toThrow("Web Search history carrier rejected")
    })
  }
})
