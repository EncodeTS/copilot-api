import { afterEach, describe, expect, it } from "bun:test"
import consola from "consola"

import { HTTPError } from "~/lib/error"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicWebSearchTool,
} from "~/routes/messages/anthropic-types"
import type {
  ResponsesPayload,
  ResponsesResult,
} from "~/services/copilot/create-responses"
import type { ResponsesWireArtifact } from "~/services/copilot/responses-wire-artifact"

import {
  buildSyntheticStreamEvents,
  createWebSearchFlow,
  handleWebSearchViaResponses as handleWebSearchViaResponsesWithComposition,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  resolveWebSearchRoute,
  type WebSearchFlowComposition,
} from "~/routes/messages/web-search/fulfill"
import { getResponsesTransportForModel } from "~/routes/responses/utils"
import {
  decodeWebSearchHistoryCarrier,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
} from "~/routes/messages/web-search/history-carrier"

const webSearchTool = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
} satisfies AnthropicWebSearchTool

const makePayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What is new in Node.js?" }],
  tools: [webSearchTool],
  ...overrides,
})

const makeContext = () => {
  const captured: { headers: Record<string, string>; json?: unknown } = {
    headers: {},
  }
  const c = {
    header: (name: string, value: string) => {
      captured.headers[name.toLowerCase()] = value
    },
    json: (value: unknown) => {
      captured.json = value
      return { __json: value }
    },
  }
  return { c: c as never, captured }
}

const makeResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-5-mini",
  output: [
    {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "node lts version" },
    },
    {
      id: "message-default",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Node.js 24 is the latest LTS.",
          annotations: [
            {
              type: "url_citation",
              url: "https://nodejs.org",
              title: "Node.js",
            },
          ],
        },
      ],
    },
  ],
  output_text: "",
  status: "completed",
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
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

async function* makeResponsesStream(result: ResponsesResult) {
  await Promise.resolve()
  yield {
    event: "response.created",
    data: JSON.stringify({
      response: {
        ...result,
        output: [],
        output_text: "",
        usage: null,
      },
      sequence_number: 1,
      type: "response.created",
    }),
  }
  yield {
    event: "response.output_item.done",
    data: JSON.stringify({
      item: result.output[0],
      output_index: 0,
      sequence_number: 2,
      type: "response.output_item.done",
    }),
  }
  yield {
    event: "response.in_progress",
    data: JSON.stringify({
      response: {
        ...result,
        output: [],
        output_text: "",
        usage: null,
      },
      sequence_number: 3,
      type: "response.in_progress",
    }),
  }
  yield {
    event: "response.web_search_call.in_progress",
    data: JSON.stringify({
      item_id: "search-1",
      output_index: 0,
      sequence_number: 4,
      type: "response.web_search_call.in_progress",
    }),
  }
  yield {
    event: "response.web_search_call.searching",
    data: JSON.stringify({
      item_id: "search-1",
      output_index: 0,
      sequence_number: 5,
      type: "response.web_search_call.searching",
    }),
  }
  yield {
    event: "response.web_search_call.completed",
    data: JSON.stringify({
      item_id: "search-1",
      output_index: 0,
      sequence_number: 6,
      type: "response.web_search_call.completed",
    }),
  }
  yield {
    event: "response.reasoning_summary_part.added",
    data: JSON.stringify({
      item_id: "reasoning-1",
      output_index: 0,
      part: { text: "", type: "summary_text" },
      sequence_number: 7,
      summary_index: 0,
      type: "response.reasoning_summary_part.added",
    }),
  }
  yield {
    event: "response.reasoning_summary_text.delta",
    data: JSON.stringify({
      delta: "Searching",
      item_id: "reasoning-1",
      output_index: 0,
      sequence_number: 8,
      summary_index: 0,
      type: "response.reasoning_summary_text.delta",
    }),
  }
  yield {
    event: "response.reasoning_summary_text.done",
    data: JSON.stringify({
      item_id: "reasoning-1",
      output_index: 0,
      sequence_number: 9,
      summary_index: 0,
      text: "Searching",
      type: "response.reasoning_summary_text.done",
    }),
  }
  yield {
    event: "response.reasoning_summary_part.done",
    data: JSON.stringify({
      item_id: "reasoning-1",
      output_index: 0,
      part: { text: "Searching", type: "summary_text" },
      sequence_number: 10,
      summary_index: 0,
      type: "response.reasoning_summary_part.done",
    }),
  }
  yield {
    event: "response.output_item.added",
    data: JSON.stringify({
      item: {
        id: "msg-1",
        role: "assistant",
        status: "in_progress",
        type: "message",
      },
      output_index: 1,
      sequence_number: 11,
      type: "response.output_item.added",
    }),
  }
  yield {
    event: "response.content_part.added",
    data: JSON.stringify({
      content_index: 0,
      item_id: "msg-1",
      output_index: 1,
      part: { annotations: [], text: "", type: "output_text" },
      sequence_number: 12,
      type: "response.content_part.added",
    }),
  }
  yield {
    event: "response.output_text.delta",
    data: JSON.stringify({
      content_index: 0,
      delta: "Node.js 24 is the latest LTS.",
      item_id: "msg-1",
      output_index: 1,
      sequence_number: 13,
      type: "response.output_text.delta",
    }),
  }
  yield {
    event: "response.output_text.annotation.added",
    data: JSON.stringify({
      annotation: {
        title: "Node.js",
        type: "url_citation",
        url: "https://nodejs.org",
      },
      annotation_index: 0,
      content_index: 0,
      item_id: "msg-1",
      output_index: 1,
      sequence_number: 14,
      type: "response.output_text.annotation.added",
    }),
  }
  yield {
    event: "response.output_text.done",
    data: JSON.stringify({
      content_index: 0,
      item_id: "msg-1",
      output_index: 1,
      sequence_number: 15,
      text: "Node.js 24 is the latest LTS.",
      type: "response.output_text.done",
    }),
  }
  yield {
    event: "response.output_item.done",
    data: JSON.stringify({
      item: result.output[1],
      output_index: 1,
      sequence_number: 16,
      type: "response.output_item.done",
    }),
  }
  yield {
    event: "response.completed",
    data: JSON.stringify({
      response: {
        ...result,
        output: [],
        output_text: "",
      },
      sequence_number: 17,
      type: "response.completed",
    }),
  }
}

let webSearchFlowDependencies: WebSearchFlowComposition = {}

const handleWebSearchViaResponses = (
  c: Parameters<
    ReturnType<typeof createWebSearchFlow>["handleViaResponses"]
  >[0],
  payload: Parameters<
    ReturnType<typeof createWebSearchFlow>["handleViaResponses"]
  >[1],
  options: Parameters<
    ReturnType<typeof createWebSearchFlow>["handleViaResponses"]
  >[2],
) => {
  const composition: WebSearchFlowComposition = {
    ...webSearchFlowDependencies,
    getResponsesTransportForModel:
      webSearchFlowDependencies.getResponsesTransportForModel
      ?? ((selectedModel, transportOptions) =>
        getResponsesTransportForModel(selectedModel, {
          ...transportOptions,
          useWebSocket: true,
        })),
  }
  return handleWebSearchViaResponsesWithComposition(
    c,
    payload,
    options,
    composition,
  )
}

afterEach(() => {
  webSearchFlowDependencies = {}
})

const baseOptions = {
  logger: consola,
  webSearchModel: "gpt-5-mini",
  reasoningRecoverySessionId: "stable-sess-1",
  requestId: "req-1",
  sessionId: "sess-1",
}

describe("web search tool detection", () => {
  it("detects the web_search server tool", () => {
    expect(hasWebSearchServerTool(makePayload())).toBe(true)
  })

  it("treats a web_search-only request as switchable", () => {
    expect(isWebSearchOnlyRequest(makePayload())).toBe(true)
  })

  it("does not switch when web_search is mixed with other tools", () => {
    const payload = makePayload({
      tools: [
        webSearchTool,
        { name: "get_weather", input_schema: { type: "object" } },
      ],
    })
    expect(hasWebSearchServerTool(payload)).toBe(true)
    expect(isWebSearchOnlyRequest(payload)).toBe(false)
  })

  it("ignores normal function tools", () => {
    const payload = makePayload({
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    })
    expect(hasWebSearchServerTool(payload)).toBe(false)
    expect(isWebSearchOnlyRequest(payload)).toBe(false)
  })
})

describe("resolveWebSearchRoute", () => {
  const opts = {
    webSearchModel: "gpt-5-mini",
    responsesWebSearchEnabled: true,
  }

  it("routes a Copilot model to the responses path", () => {
    expect(resolveWebSearchRoute(makePayload(), opts)).toEqual({
      kind: "responses",
      model: "gpt-5-mini",
    })
  })

  it("routes a provider/model alias to provider passthrough", () => {
    const route = resolveWebSearchRoute(makePayload(), {
      ...opts,
      webSearchModel: "anthropic/claude-sonnet-4-5",
    })
    expect(route).toEqual({
      kind: "provider",
      alias: { provider: "anthropic", model: "claude-sonnet-4-5" },
    })
  })

  it("rejects mixed web_search and client tools before fallback dispatch", () => {
    const payload = makePayload({
      tools: [
        webSearchTool,
        { name: "get_weather", input_schema: { type: "object" } },
      ],
    })
    expect(resolveWebSearchRoute(payload, opts).kind).toBe("unsupported")
  })

  it("rejects when no web search model is configured", () => {
    expect(
      resolveWebSearchRoute(makePayload(), {
        webSearchModel: undefined,
        responsesWebSearchEnabled: true,
      }).kind,
    ).toBe("unsupported")
  })

  it("rejects a Copilot model when responses web search is disabled", () => {
    expect(
      resolveWebSearchRoute(makePayload(), {
        webSearchModel: "gpt-5-mini",
        responsesWebSearchEnabled: false,
      }).kind,
    ).toBe("unsupported")
  })
})

describe("prepareWebSearchResponsesPayload", () => {
  it("maps Anthropic max_uses to the native Responses tool-call limit", () => {
    const payload = makePayload({
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 2,
          allowed_callers: ["direct"],
          response_inclusion: "full",
        },
      ],
    })

    const responses = prepareWebSearchResponsesPayload(payload, {
      model: "gpt-5.5",
    })

    expect(responses.max_tool_calls).toBe(2)
    expect(responses.tools).toEqual([{ type: "web_search" }])
    expect(responses.include).toContain("web_search_call.action.sources")
  })
})

describe("reconstructWebSearchResponse", () => {
  it.each(["max_output_tokens", "max_tokens"])(
    "maps incomplete %s to Anthropic max_tokens",
    (reason) => {
      const result = makeResponsesResult({
        status: "incomplete",
        incomplete_details: { reason } as never,
      })

      const { response } = reconstructWebSearchResponse(makePayload(), result, {
        requestId: "req-limit",
      })

      expect(response.stop_reason).toBe("max_tokens")
    },
  )

  it("fails closed for an incomplete reason without an Anthropic equivalent", () => {
    const result = makeResponsesResult({
      status: "incomplete",
      incomplete_details: { reason: "tool_limit" } as never,
    })

    expect(() =>
      reconstructWebSearchResponse(makePayload(), result, {
        requestId: "req-unknown-incomplete",
      }),
    ).toThrow("no Anthropic stop-reason equivalent")
  })

  it("maps content filtering to refusal only with an explicit refusal item", () => {
    const withoutRefusal = makeResponsesResult({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    })
    expect(() =>
      reconstructWebSearchResponse(makePayload(), withoutRefusal, {
        requestId: "req-filter-without-refusal",
      }),
    ).toThrow("no Anthropic stop-reason equivalent")

    const withRefusal = makeResponsesResult({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [
        {
          id: "msg-refusal",
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "refusal", refusal: "Cannot provide that." }],
        },
      ] satisfies ResponsesResult["output"],
    })
    const { response } = reconstructWebSearchResponse(
      makePayload(),
      withRefusal,
      { requestId: "req-filter-refusal" },
    )
    expect(response.stop_reason).toBe("refusal")
    expect(response.content).toEqual([
      { type: "text", text: "Cannot provide that." },
    ])
  })

  it("uses actual call items for usage and preserves normalized cache buckets", () => {
    const result = makeResponsesResult({
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: ["first", "second", "third"],
          },
        },
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "open", url: "https://example.test" },
        },
        {
          id: "message-usage",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      ] satisfies ResponsesResult["output"],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 6 },
        output_tokens: 4,
        total_tokens: 24,
      },
    })

    const { response } = reconstructWebSearchResponse(makePayload(), result, {
      requestId: "req-usage",
    })

    expect(response.usage).toEqual({
      input_tokens: 14,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      server_tool_use: { web_search_requests: 2 },
    })
  })

  it("reports zero calls as zero and never fabricates encrypted search content", () => {
    const result = makeResponsesResult({
      output: [
        {
          id: "message-no-search",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "No search needed.", annotations: [] },
          ],
        },
      ] satisfies ResponsesResult["output"],
    })

    const { response } = reconstructWebSearchResponse(makePayload(), result, {
      requestId: "req-zero-calls",
    })

    expect(response.usage.server_tool_use?.web_search_requests).toBe(0)
    expect(JSON.stringify(response)).not.toContain("encrypted_content")
    expect(response.content.map((block) => block.type)).toEqual(["text"])
  })

  it("preserves each call, query, result outcome, and repeated claim citation", () => {
    const result = makeResponsesResult({
      output: [
        {
          id: "search-primary",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: ["first query", "second query"],
            sources: [
              {
                type: "url",
                url: "https://example.test/repeated",
                title: "Primary source",
                page_age: "2 days ago",
              },
            ],
          },
        },
        {
          id: "search-follow-up",
          type: "web_search_call",
          status: "failed",
          action: {
            type: "find",
            query: "third query",
            url: "https://example.test/repeated",
            pattern: "Beta",
          },
        },
        {
          id: "message-search-answer",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Alpha claim. Beta claim.",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: 11,
                  url: "https://example.test/repeated",
                  title: "Primary source",
                  provider_rank: 1,
                },
                {
                  type: "url_citation",
                  start_index: 13,
                  end_index: 23,
                  url: "https://example.test/repeated",
                  title: "Primary source",
                  provider_rank: 2,
                },
              ],
            },
          ],
        },
      ] satisfies ResponsesResult["output"],
    })

    const { extract, response } = reconstructWebSearchResponse(
      makePayload(),
      result,
      { requestId: "req-multi-call" },
    )

    expect(extract.queries).toEqual([
      "first query",
      "second query",
      "third query",
    ])
    expect(response.content).toEqual([
      {
        type: "server_tool_use",
        id: "search-primary",
        name: "web_search",
        input: {
          type: "search",
          queries: ["first query", "second query"],
        },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "search-primary",
        content: [
          {
            type: "web_search_result",
            url: "https://example.test/repeated",
            title: "Primary source",
            page_age: "2 days ago",
          },
        ],
      },
      {
        type: "server_tool_use",
        id: "search-follow-up",
        name: "web_search",
        input: {
          type: "find",
          query: "third query",
          url: "https://example.test/repeated",
          pattern: "Beta",
        },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "search-follow-up",
        content: {
          type: "web_search_tool_result_error",
          error_code: "unavailable",
        },
      },
      {
        type: "text",
        text: "Alpha claim. Beta claim.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.test/repeated",
            title: "Primary source",
            cited_text: "Alpha claim",
          },
          {
            type: "web_search_result_location",
            url: "https://example.test/repeated",
            title: "Primary source",
            cited_text: "Beta claim",
          },
        ],
      },
    ])
    expect(JSON.stringify(response)).not.toContain("encrypted_index")
    expect(JSON.stringify(response)).not.toContain("provider_rank")
  })

  it("writes one scoped v1 carrier from the exact ordered Responses output", () => {
    const result = makeResponsesResult({
      copilot_usage: { total_nano_aiu: 42 },
      output: [
        {
          id: "search-carried",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "carrier query",
            sources: [{ type: "url", url: "https://example.test/carrier" }],
            provider_extension: { preserved: true },
          },
        },
        {
          id: "message-carried",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Carrier answer",
              annotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: 7,
                  title: "Carrier source",
                  url: "https://example.test/carrier",
                  provider_offset_unit: "utf16",
                },
              ],
            },
          ],
        },
      ] satisfies ResponsesResult["output"],
    })
    const source = {
      destination: "responses",
      adapter: "copilot-responses",
      provider: "copilot",
      model: "gpt-5-mini",
    } as const

    const { carrierMode, response } = reconstructWebSearchResponse(
      makePayload(),
      result,
      { requestId: "req-carrier", carrierSource: source },
    )

    expect(carrierMode).toBe("gateway-v1-exact-responses-scope")
    expect(response.copilot_usage).toEqual({ total_nano_aiu: 42 })
    const firstInput = (
      response.content[0] as { input: Record<string, unknown> }
    ).input
    const carrier = firstInput[WEB_SEARCH_HISTORY_CARRIER_FIELD]
    expect(typeof carrier).toBe("string")
    expect(
      response.content
        .slice(1)
        .some((block) =>
          JSON.stringify(block).includes(WEB_SEARCH_HISTORY_CARRIER_FIELD),
        ),
    ).toBe(false)
    expect(
      decodeWebSearchHistoryCarrier(carrier, {
        destination: "responses",
        canonicalTarget: source,
      }),
    ).toMatchObject({
      kind: "accepted",
      envelope: {
        output_items: result.output,
        continuation: { kind: "complete" },
        source,
      },
    })
  })

  it("keeps output without stable call IDs explicitly non-resumable", () => {
    const { carrierMode, response } = reconstructWebSearchResponse(
      makePayload(),
      makeResponsesResult(),
      {
        requestId: "req-legacy",
        carrierSource: {
          destination: "responses",
          adapter: "copilot-responses",
          provider: "copilot",
          model: "gpt-5-mini",
        },
      },
    )

    expect(carrierMode).toBe("synthetic-without-encrypted-content")
    expect(JSON.stringify(response)).not.toContain(
      WEB_SEARCH_HISTORY_CARRIER_FIELD,
    )
  })

  it("rejects malformed nested search facts as an upstream protocol mismatch", async () => {
    const malformed = makeResponsesResult({
      output: [
        {
          id: "search-malformed",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: ["valid", { private_query: "must-not-echo" }],
          },
        },
      ] as never,
    })

    let thrown: unknown
    try {
      reconstructWebSearchResponse(makePayload(), malformed, {
        requestId: "req-malformed",
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HTTPError)
    expect((thrown as HTTPError).response.status).toBe(502)
    const body = await (thrown as HTTPError).response.text()
    expect(body).toContain("malformed Web Search output")
    expect(body).not.toContain("must-not-echo")
  })

  it("fails closed when a terminal response still has an unfinished search call", () => {
    const unfinished = makeResponsesResult({
      output: [
        {
          id: "search-unfinished",
          type: "web_search_call",
          status: "searching",
          action: { type: "search", query: "still running" },
        },
      ] satisfies ResponsesResult["output"],
    })

    expect(() =>
      reconstructWebSearchResponse(makePayload(), unfinished, {
        requestId: "req-unfinished",
      }),
    ).toThrow("Responses ended with an unfinished Web Search call")
  })

  it("fails closed when a completed response contains an incomplete message", () => {
    const unfinished = makeResponsesResult({
      output: [
        {
          id: "message-unfinished",
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [],
        },
      ] satisfies ResponsesResult["output"],
    })

    expect(() =>
      reconstructWebSearchResponse(makePayload(), unfinished, {
        requestId: "req-unfinished-message",
      }),
    ).toThrow("malformed Web Search output")
  })

  for (const [label, output] of [
    ["output array", null],
    ["output item", [null]],
    [
      "missing call status",
      [
        {
          id: "search-missing-status",
          type: "web_search_call",
          action: { type: "search", query: "missing status" },
        },
      ],
    ],
    [
      "missing call action",
      [
        {
          id: "search-missing-action",
          type: "web_search_call",
          status: "completed",
        },
      ],
    ],
    [
      "action object",
      [
        {
          id: "search-bad-action",
          type: "web_search_call",
          status: "completed",
          action: 1,
        },
      ],
    ],
    [
      "call status",
      [
        {
          id: "search-bad-status",
          type: "web_search_call",
          status: "unknown-future-status",
          action: { type: "search", query: "invalid status" },
        },
      ],
    ],
    [
      "action type",
      [
        {
          id: "search-bad-action-type",
          type: "web_search_call",
          status: "completed",
          action: { type: "teleport", query: "invalid action" },
        },
      ],
    ],
    [
      "duplicate output IDs",
      [
        {
          id: "duplicate-search-item",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "duplicate" },
        },
        {
          id: "duplicate-search-item",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [],
        },
      ],
    ],
    [
      "message role",
      [
        {
          id: "message-bad-role",
          type: "message",
          role: "user",
          status: "completed",
          content: [],
        },
      ],
    ],
    [
      "message status",
      [
        {
          id: "message-bad-status",
          type: "message",
          role: "assistant",
          status: "failed",
          content: [],
        },
      ],
    ],
    [
      "source list",
      [
        {
          id: "search-bad-sources",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "q", sources: {} },
        },
      ],
    ],
    [
      "source type",
      [
        {
          id: "search-bad-source-type",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "q",
            sources: [
              {
                type: "not-a-url",
                url: "https://example.test/private",
              },
            ],
          },
        },
      ],
    ],
    [
      "source URL",
      [
        {
          id: "search-bad-source-url",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "q",
            sources: [{ type: "url", url: "" }],
          },
        },
      ],
    ],
    [
      "source age",
      [
        {
          id: "search-bad-source-age",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "q",
            sources: [
              { type: "url", url: "https://example.test", page_age: 12 },
            ],
          },
        },
      ],
    ],
    [
      "citation URL",
      [
        {
          id: "message-bad-citation-url",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "claim",
              annotations: [{ type: "url_citation", url: "" }],
            },
          ],
        },
      ],
    ],
    [
      "citation range",
      [
        {
          id: "message-bad-citation-range",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "claim",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test",
                  start_index: 4,
                  end_index: 99,
                },
              ],
            },
          ],
        },
      ],
    ],
    [
      "message content",
      [
        {
          id: "message-bad-content",
          type: "message",
          role: "assistant",
          status: "completed",
          content: {},
        },
      ],
    ],
    [
      "null message content block",
      [
        {
          id: "message-null-block",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [null],
        },
      ],
    ],
    [
      "primitive message content block",
      [
        {
          id: "message-primitive-block",
          type: "message",
          role: "assistant",
          status: "completed",
          content: ["not-a-block"],
        },
      ],
    ],
    [
      "unknown message content type",
      [
        {
          id: "message-unknown-block",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "future_private_block", private: "not-visible" }],
        },
      ],
    ],
    [
      "refusal",
      [
        {
          id: "message-bad-refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: 1 }],
        },
      ],
    ],
    [
      "output text",
      [
        {
          id: "message-bad-text",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: 1, annotations: [] }],
        },
      ],
    ],
    [
      "annotations",
      [
        {
          id: "message-bad-annotations",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "claim", annotations: {} }],
        },
      ],
    ],
  ] as const) {
    it(`rejects malformed ${label} before semantic reconstruction`, () => {
      expect(() =>
        reconstructWebSearchResponse(
          makePayload(),
          makeResponsesResult({ output: output as never }),
          { requestId: `req-malformed-${label}` },
        ),
      ).toThrow("Responses returned malformed Web Search output")
    })
  }

  for (const [label, output] of [
    [
      "output item count",
      Array.from({ length: 257 }, (_, index) => ({
        id: `extension-${index}`,
        type: "provider_extension",
      })),
    ],
    [
      "query count",
      [
        {
          id: "search-query-bound",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: Array.from({ length: 257 }, (_, index) => `q-${index}`),
          },
        },
      ],
    ],
    [
      "source count",
      [
        {
          id: "search-source-bound",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "q",
            sources: Array.from({ length: 257 }, (_, index) => ({
              type: "url",
              url: `https://example.test/${index}`,
            })),
          },
        },
      ],
    ],
    [
      "annotation count",
      [
        {
          id: "message-annotation-bound",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "claim",
              annotations: Array.from({ length: 1_025 }, () => ({
                type: "url_citation",
                url: "https://example.test",
              })),
            },
          ],
        },
      ],
    ],
    [
      "known string size",
      [
        {
          id: "search-string-bound",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "q".repeat(1024 * 1024 + 1) },
        },
      ],
    ],
    [
      "collection width",
      [
        {
          id: "extension-width-bound",
          type: "provider_extension",
          values: Array<number>(10_001).fill(0),
        },
      ],
    ],
    [
      "node count",
      [
        {
          id: "extension-node-bound",
          type: "provider_extension",
          values: Array.from({ length: 101 }, () =>
            Array<number>(1_000).fill(0),
          ),
        },
      ],
    ],
    [
      "byte size",
      [
        {
          id: "extension-byte-bound",
          type: "provider_extension",
          value: "x".repeat(4 * 1024 * 1024 + 1),
        },
      ],
    ],
  ] as const) {
    it(`bounds Web Search ${label} before semantic copying`, () => {
      expect(() =>
        reconstructWebSearchResponse(
          makePayload(),
          makeResponsesResult({ output: output as never }),
          { requestId: `req-bound-${label}` },
        ),
      ).toThrow("Responses returned malformed Web Search output")
    })
  }
})

describe("handleWebSearchViaResponses", () => {
  it("uses the production usage recorder when the flow does not override it", async () => {
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(makeResponsesResult())) as never

    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    expect((captured.json as AnthropicResponse).content).toHaveLength(3)
  })

  it("preserves explicit effort after validating the selected search model", async () => {
    let sentPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: {
        limits: {},
        supports: { reasoning_effort: ["low", "high"] },
      },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses"],
    })) as never
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      sentPayload = payload
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c } = makeContext()
    await handleWebSearchViaResponses(
      c,
      makePayload({ output_config: { effort: "high" } }),
      baseOptions,
    )

    expect(sentPayload?.reasoning?.effort).toBe("high")
  })

  it("rejects unsupported explicit effort before search dispatch", async () => {
    let dispatched = false
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: {
        limits: {},
        supports: { reasoning_effort: ["low"] },
      },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses"],
    })) as never
    webSearchFlowDependencies.createResponses = (() => {
      dispatched = true
      return Promise.resolve(makeResponsesResult())
    }) as never

    const { c } = makeContext()
    let caught: unknown
    try {
      await handleWebSearchViaResponses(
        c,
        makePayload({ output_config: { effort: "high" } }),
        baseOptions,
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HTTPError)
    expect((caught as Error).message).toContain("not supported by search model")
    expect(dispatched).toBe(false)
  })
  it("enables HTTP fallback for a dual-endpoint search model", async () => {
    let allowHttpFallback: boolean | undefined
    let reasoningRecoverySessionId: string | undefined
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: { limits: {}, supports: {} },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses", "ws:/responses"],
    })) as never
    webSearchFlowDependencies.createResponses = ((
      _payload: ResponsesPayload,
      options: {
        allowHttpFallback?: boolean
        reasoningRecoverySessionId?: string
      },
    ) => {
      allowHttpFallback = options.allowHttpFallback
      reasoningRecoverySessionId = options.reasoningRecoverySessionId
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never
    const { c } = makeContext()

    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    expect(allowHttpFallback).toBe(true)
    expect(reasoningRecoverySessionId).toBe("stable-sess-1")
  })

  it("admits the effective subagent initiator for websocket search", async () => {
    let captured:
      | {
          initiator?: "agent" | "user"
          wireArtifact?: ResponsesWireArtifact
        }
      | undefined
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: { limits: {}, supports: {} },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses", "ws:/responses"],
    })) as never
    webSearchFlowDependencies.createResponses = ((
      _payload: ResponsesPayload,
      options: typeof captured,
    ) => {
      captured = options
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never
    const { c } = makeContext()

    await handleWebSearchViaResponses(c, makePayload(), {
      ...baseOptions,
      subagentMarker: {
        agent_id: "synthetic-agent",
        agent_type: "review",
        session_id: "synthetic-session",
      },
    })

    expect(captured?.initiator).toBe("agent")
    const frame = JSON.parse(
      captured?.wireArtifact?.websocketFrame ?? "{}",
    ) as { initiator?: string }
    expect(frame.initiator).toBe("agent")
  })

  it("forwards the caller abort signal to the Responses search", async () => {
    let sentSignal: AbortSignal | undefined
    webSearchFlowDependencies.createResponses = ((
      _payload: ResponsesPayload,
      options: { signal?: AbortSignal },
    ) => {
      sentSignal = options.signal
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never
    const controller = new AbortController()
    const { c } = makeContext()

    await handleWebSearchViaResponses(c, makePayload(), {
      ...baseOptions,
      signal: controller.signal,
    })

    expect(sentSignal).toBe(controller.signal)
  })

  it("marks newer dynamic web search as an explicit direct fallback", async () => {
    let sentPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      sentPayload = payload
      return Promise.resolve(makeResponsesResult())
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const payload = makePayload({
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 1,
          response_inclusion: "excluded",
        },
      ],
    })
    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, payload, baseOptions)

    expect(sentPayload?.max_tool_calls).toBe(1)
    expect(captured.headers["x-copilot-api-web-search-mode"]).toBe(
      "direct-fallback",
    )
    expect(captured.headers["x-copilot-api-web-search-carrier"]).toBe(
      "synthetic-without-encrypted-content",
    )
    expect(captured.headers["x-copilot-api-web-search-downgrade"]).toBe(
      "dynamic-filtering,response-inclusion",
    )
    const response = captured.json as AnthropicResponse
    expect(response.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  it("keeps direct callers and direct response-inclusion semantics", async () => {
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(makeResponsesResult())) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const payload = makePayload({
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          allowed_callers: ["direct"],
          response_inclusion: "excluded",
        },
      ],
    })
    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, payload, baseOptions)

    expect(captured.headers["x-copilot-api-web-search-mode"]).toBe("direct")
    expect(
      captured.headers["x-copilot-api-web-search-downgrade"],
    ).toBeUndefined()
    const response = captured.json as AnthropicResponse
    expect(response.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
  })

  it("switches model, runs Responses web_search, and reconstructs blocks", async () => {
    let sentPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      sentPayload = payload
      return Promise.resolve(makeResponsesStream(makeResponsesResult()))
    }) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    // Request was switched to the GPT model with a Responses web_search tool.
    expect(sentPayload?.model).toBe("gpt-5-mini")
    expect(sentPayload?.stream).toBe(true)
    expect(sentPayload?.tools).toEqual([{ type: "web_search" }])
    expect(captured.headers["x-copilot-api-web-search-mode"]).toBe("direct")

    const response = captured.json as AnthropicResponse
    const types = response.content.map((b) => b.type as string)
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])

    const serverToolUse = response.content[0] as unknown as {
      name: string
      input: { query: string }
    }
    expect(serverToolUse.name).toBe("web_search")
    expect(serverToolUse.input.query).toBe("node lts version")

    const result = response.content[1] as unknown as {
      content: Array<{ url: string; title: string }>
    }
    expect(result.content[0].url).toBe("https://nodejs.org")

    const text = response.content[2] as unknown as { text: string }
    expect(text.text).toBe("Node.js 24 is the latest LTS.")

    // Response keeps the original Claude model id.
    expect(response.model).toBe("claude-sonnet-4.5")
    expect(
      (response.usage as { server_tool_use?: unknown }).server_tool_use,
    ).toEqual({ web_search_requests: 1 })
  })

  it("restores a builtin same-model carrier at the exact Responses position", async () => {
    const exactOutput = [
      {
        id: "search-builtin-history",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "builtin history",
          sources: [
            { type: "url", url: "https://example.test/builtin-history" },
          ],
        },
      },
      {
        id: "message-builtin-history",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Builtin history answer",
            annotations: [],
          },
        ],
      },
    ] as ResponsesResult["output"]
    const result = makeResponsesResult({ output: exactOutput })
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: { limits: {}, supports: {} },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses"],
    })) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(result)) as never

    const firstContext = makeContext()
    await handleWebSearchViaResponses(
      firstContext.c,
      makePayload(),
      baseOptions,
    )
    expect(
      firstContext.captured.headers["x-copilot-api-web-search-carrier"],
    ).toBe("gateway-v1-exact-responses-scope")
    const firstResponse = firstContext.captured.json as AnthropicResponse

    let continuedPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      continuedPayload = payload
      return Promise.resolve(result)
    }) as never
    const continued = makePayload({
      messages: [
        { role: "user", content: "Search" },
        { role: "assistant", content: firstResponse.content },
        { role: "user", content: "Continue" },
      ],
    })
    await handleWebSearchViaResponses(makeContext().c, continued, baseOptions)

    if (!Array.isArray(continuedPayload?.input)) {
      throw new Error("expected Responses input")
    }
    expect(JSON.stringify(continuedPayload.input.slice(1, 3))).toBe(
      JSON.stringify(exactOutput),
    )
    expect(JSON.stringify(continuedPayload)).not.toContain(
      WEB_SEARCH_HISTORY_CARRIER_FIELD,
    )
  })

  it("keeps top-level-only output text legacy across a self round-trip", async () => {
    const result = makeResponsesResult({
      output: [
        {
          id: "search-top-level-text",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "top-level text",
            sources: [],
          },
        },
      ] satisfies ResponsesResult["output"],
      output_text: "Visible fallback answer",
    })
    webSearchFlowDependencies.findEndpointModel = (() => ({
      capabilities: { limits: {}, supports: {} },
      id: "gpt-5-mini",
      supported_endpoints: ["/responses"],
    })) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(result)) as never

    const firstContext = makeContext()
    await handleWebSearchViaResponses(
      firstContext.c,
      makePayload(),
      baseOptions,
    )
    expect(
      firstContext.captured.headers["x-copilot-api-web-search-carrier"],
    ).toBe("synthetic-without-encrypted-content")
    const firstResponse = firstContext.captured.json as AnthropicResponse
    expect(firstResponse.content.at(-1)).toEqual({
      type: "text",
      text: "Visible fallback answer",
    })
    expect(JSON.stringify(firstResponse)).not.toContain(
      WEB_SEARCH_HISTORY_CARRIER_FIELD,
    )

    let continuedPayload: ResponsesPayload | undefined
    webSearchFlowDependencies.createResponses = ((
      payload: ResponsesPayload,
    ) => {
      continuedPayload = payload
      return Promise.resolve(result)
    }) as never
    await handleWebSearchViaResponses(
      makeContext().c,
      makePayload({
        messages: [
          { role: "user", content: "Search" },
          { role: "assistant", content: firstResponse.content },
          { role: "user", content: "Continue" },
        ],
      }),
      baseOptions,
    )

    if (!Array.isArray(continuedPayload?.input)) {
      throw new Error("expected Responses input")
    }
    expect(
      continuedPayload.input.some(
        (item) => (item as { type?: string }).type === "web_search_call",
      ),
    ).toBe(false)
    expect(JSON.stringify(continuedPayload.input)).toContain(
      "Visible fallback answer",
    )
  })

  it("returns just text when the backend produced no sources", async () => {
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(
        makeResponsesResult({
          output: [
            {
              id: "message-no-results",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "No results.", annotations: [] },
              ],
            },
          ] satisfies ResponsesResult["output"],
        }),
      )) as never
    webSearchFlowDependencies.createUsageRecorder = (() => () => {}) as never

    const { c, captured } = makeContext()
    await handleWebSearchViaResponses(c, makePayload(), baseOptions)

    const response = captured.json as AnthropicResponse
    expect(response.content.map((b) => b.type as string)).toEqual(["text"])
  })

  it("rejects a failed Responses result instead of returning empty success", async () => {
    let recordedUsage: unknown
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(
        makeResponsesResult({
          status: "failed",
          error: { code: "server_error", message: "backend down" },
          output: [],
          output_text: "",
        }),
      )) as never
    webSearchFlowDependencies.createUsageRecorder = (() => (usage: unknown) => {
      recordedUsage = usage
    }) as never

    const { c } = makeContext()
    let caught: unknown
    try {
      await handleWebSearchViaResponses(c, makePayload(), baseOptions)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HTTPError)
    const response = (caught as HTTPError).response
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "backend down",
      },
    })
    expect(recordedUsage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
    })
  })

  it("records a buffered failure once before surfacing a protocol error", async () => {
    const calls: Array<Array<unknown>> = []
    const failed = makeResponsesResult({
      error: {
        code: "server_error",
        message: "private backend failure detail",
      },
      id: "resp-private-failure",
      output: [],
      output_text: "",
      status: "failed",
      usage: {
        input_tokens: 14,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 2,
        total_tokens: 16,
      },
    })
    webSearchFlowDependencies.createResponses = (() =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve()
          yield {
            data: JSON.stringify({
              copilot_usage: { total_nano_aiu: 900 },
              response: failed,
              sequence_number: 1,
              type: "response.failed",
            }),
          }
        })(),
      )) as never
    webSearchFlowDependencies.createUsageRecorder = (() =>
      (...args: Array<unknown>) => {
        calls.push(args)
        return "accepted"
      }) as never

    const { c } = makeContext()
    let caught: unknown
    try {
      await handleWebSearchViaResponses(c, makePayload(), baseOptions)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HTTPError)
    expect((caught as HTTPError).response.status).toBe(502)
    expect(await (caught as HTTPError).response.json()).toEqual({
      type: "error",
      error: {
        code: "upstream_error",
        message: "Responses upstream reported an error",
        type: "api_error",
      },
    })
    expect(calls).toEqual([
      [
        {
          cache_read_input_tokens: 4,
          input_tokens: 10,
          output_tokens: 2,
          total_nano_aiu: 900,
          total_tokens: 16,
        },
        {
          errorCode: "upstream_error",
          outcome: "failed",
          terminal: "response.failed",
        },
      ],
    ])
    expect(JSON.stringify(caught)).not.toContain("private backend")
    expect(JSON.stringify(caught)).not.toContain("resp-private")
  })
})

describe("buildSyntheticStreamEvents", () => {
  it("emits a well-formed Anthropic event sequence", () => {
    const response = {
      id: "msg_1",
      type: "message" as const,
      role: "assistant" as const,
      model: "claude-sonnet-4.5",
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      copilot_usage: { total_nano_aiu: 24 },
      content: [
        {
          type: "server_tool_use" as const,
          id: "toolu_1",
          name: "web_search" as const,
          input: { query: "q" },
        },
        {
          type: "web_search_tool_result" as const,
          tool_use_id: "toolu_1",
          content: [
            {
              type: "web_search_result" as const,
              url: "https://x",
              title: "X",
            },
          ],
        },
        {
          type: "text" as const,
          text: "answer",
          citations: [
            {
              type: "web_search_result_location" as const,
              url: "https://x",
              title: "X",
              cited_text: "answer",
            },
          ],
        },
      ],
    }

    const events = buildSyntheticStreamEvents(response)
    const types = events.map((e) => e.type)

    expect(types[0]).toBe("message_start")
    expect(types.at(-1)).toBe("message_stop")
    expect(types.at(-2)).toBe("message_delta")
    expect(types.slice(1, 4)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ])
    expect(types.slice(4, 6)).toEqual([
      "content_block_start",
      "content_block_stop",
    ])
    expect(types.slice(6, 10)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
    ])
    expect(events.at(-2)).toMatchObject({
      type: "message_delta",
      copilot_usage: { total_nano_aiu: 24 },
    })
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 2,
      delta: {
        type: "citations_delta",
        citation: {
          type: "web_search_result_location",
          url: "https://x",
          title: "X",
          cited_text: "answer",
        },
      },
    })
  })
})
