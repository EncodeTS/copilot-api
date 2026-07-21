import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { webSearchCarrierSanitizer } from "~/routes/messages/web-search/carrier-sanitizer"
import { projectWebSearchSyntheticHistory } from "~/routes/messages/web-search/reconstruction"
import {
  encodeWebSearchHistoryCarrier,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
} from "~/routes/messages/web-search/history-carrier"

const source = {
  destination: "responses",
  adapter: "copilot-responses",
  provider: "copilot",
  model: "gpt-5.6-sol",
} as const

const outputItems = [
  {
    id: "search-history",
    type: "web_search_call",
    status: "completed",
    action: {
      type: "search",
      query: "history query",
      sources: [{ type: "url", url: "https://example.test/history" }],
    },
  },
  {
    id: "message-history",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: "History answer",
        annotations: [],
      },
    ],
  },
] as const

const carrier = encodeWebSearchHistoryCarrier({
  source,
  output_items: outputItems,
  continuation: { kind: "complete" },
})

const makePayload = (): AnthropicMessagesPayload =>
  ({
    model: source.model,
    max_tokens: 256,
    messages: [
      { role: "user", content: "Before" },
      {
        role: "assistant",
        content: projectWebSearchSyntheticHistory(outputItems, carrier),
      },
      { role: "user", content: "After" },
    ],
  }) as AnthropicMessagesPayload

const responsesContext = {
  destination: "responses",
  canonicalTarget: {
    adapter: "copilot-responses",
    provider: source.provider,
    model: source.model,
  },
} as const

describe("Web Search carrier sanitizer", () => {
  test("restores an accepted turn exactly once at its original message position", () => {
    const payload = makePayload()
    const sanitization = webSearchCarrierSanitizer.sanitize(
      payload,
      responsesContext,
    )

    expect(payload.messages[1]).toEqual({ role: "assistant", content: [] })
    expect(sanitization.restoredTurns).toEqual([
      { continuation: { kind: "complete" }, messageIndex: 1, outputItems },
    ])

    const translated = translateAnthropicMessagesToResponsesPayload(
      payload,
      undefined,
      { provider: "copilot", model: source.model },
      { restoredWebSearchTurns: sanitization.restoredTurns },
    )

    expect(translated.input).toEqual([
      { type: "message", role: "user", content: "Before" },
      ...outputItems,
      { type: "message", role: "user", content: "After" },
    ])
    expect(JSON.stringify(translated)).not.toContain(
      WEB_SEARCH_HISTORY_CARRIER_FIELD,
    )
  })

  test("restores every multi-call carrier companion item exactly once", () => {
    const multiOutput = [
      outputItems[0],
      {
        id: "search-history-open",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "open",
          url: "https://example.test/history",
          provider_extension: { preserved: true },
        },
      },
      outputItems[1],
    ] as const
    const multiCarrier = encodeWebSearchHistoryCarrier({
      source,
      output_items: multiOutput,
      continuation: { kind: "complete" },
    })
    const payload = {
      model: source.model,
      max_tokens: 256,
      messages: [
        { role: "user", content: "Before" },
        {
          role: "assistant",
          content: projectWebSearchSyntheticHistory(multiOutput, multiCarrier),
        },
        { role: "user", content: "After" },
      ],
    } as AnthropicMessagesPayload

    const sanitization = webSearchCarrierSanitizer.sanitize(
      payload,
      responsesContext,
    )
    const translated = translateAnthropicMessagesToResponsesPayload(
      payload,
      undefined,
      { provider: "copilot", model: source.model },
      { restoredWebSearchTurns: sanitization.restoredTurns },
    )

    expect(sanitization.restoredTurns).toEqual([
      {
        continuation: { kind: "complete" },
        messageIndex: 1,
        outputItems: multiOutput,
      },
    ])
    if (!Array.isArray(translated.input)) throw new Error("invalid input")
    const restoredStart = translated.input.findIndex(
      (item) => (item as { id?: string }).id === "search-history",
    )
    expect(
      JSON.stringify(translated.input.slice(restoredStart, restoredStart + 3)),
    ).toBe(JSON.stringify(multiOutput))
    expect(
      (translated.input as Array<{ id?: string }>).filter(
        (item) => item.id === "search-history-open",
      ),
    ).toHaveLength(1)
  })

  for (const [label, mutate] of [
    [
      "ordinary tool use",
      (content: Array<Record<string, unknown>>) => {
        content.push({
          type: "tool_use",
          id: "toolu-extra",
          name: "get_weather",
          input: {},
        })
      },
    ],
    [
      "extra text",
      (content: Array<Record<string, unknown>>) => {
        content.push({ type: "text", text: "extra text not in carrier" })
      },
    ],
    [
      "wrong result ID",
      (content: Array<Record<string, unknown>>) => {
        content[1] = {
          ...content[1],
          tool_use_id: "srvtoolu-wrong-result",
        }
      },
    ],
  ] as const) {
    test(`rejects carrier turns with ${label} before clearing history`, () => {
      const payload = makePayload()
      const assistant = payload.messages[1]
      if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
        throw new Error("invalid fixture")
      }
      mutate(assistant.content as unknown as Array<Record<string, unknown>>)

      expect(() =>
        webSearchCarrierSanitizer.sanitize(payload, responsesContext),
      ).toThrow("does not match its synthetic projection")
      expect(assistant.content).not.toEqual([])
    })
  }

  for (const [label, change] of [
    ["adapter", { adapter: "provider-responses" as const }],
    ["provider", { provider: "other-provider" }],
    ["model", { model: "gpt-other" }],
  ] as const) {
    test(`rejects a ${label} mismatch without echoing private history`, () => {
      const payload = makePayload()
      let thrown: unknown
      try {
        webSearchCarrierSanitizer.sanitize(payload, {
          ...responsesContext,
          canonicalTarget: { ...responsesContext.canonicalTarget, ...change },
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HTTPError)
      expect((thrown as HTTPError).response.status).toBe(400)
      expect((thrown as Error).message).not.toContain(carrier)
      expect((thrown as Error).message).not.toContain("history query")
    })
  }

  test("rejects a gateway carrier before native Messages dispatch", () => {
    expect(() =>
      webSearchCarrierSanitizer.sanitize(makePayload(), {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "copilot",
          model: "claude-sonnet-4.5",
        },
      }),
    ).toThrow("destination-mismatch")
  })

  test("passes native opaque history unchanged only on the native route", () => {
    const nativePayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu-native",
              name: "web_search",
              input: { query: "native" },
              caller: { type: "direct" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu-native",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.test/native",
                  title: "Native",
                  encrypted_content: "opaque-native-result",
                },
              ],
            },
            {
              type: "text",
              text: "Native answer",
              citations: [
                {
                  type: "web_search_result_location",
                  url: "https://example.test/native",
                  title: "Native",
                  cited_text: "Native answer",
                  encrypted_index: "opaque-native-index",
                },
              ],
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload
    const snapshot = structuredClone(nativePayload)

    expect(
      webSearchCarrierSanitizer.sanitize(nativePayload, {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: nativePayload.model,
        },
      }).restoredTurns,
    ).toEqual([])
    expect(nativePayload).toEqual(snapshot)

    expect(() =>
      webSearchCarrierSanitizer.sanitize(structuredClone(nativePayload), {
        destination: "responses",
        canonicalTarget: {
          adapter: "provider-responses",
          provider: "openai",
          model: "gpt-5.6-sol",
        },
      }),
    ).toThrow("native Web Search history")
  })

  test("rejects clearly synthetic markerless results before native Messages", () => {
    const payload = makePayload()
    const assistant = payload.messages[1]
    if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("invalid fixture")
    }
    const serverTool = assistant.content[0] as {
      input: Record<string, unknown>
    }
    delete serverTool.input[WEB_SEARCH_HISTORY_CARRIER_FIELD]
    assistant.content[2] = {
      type: "text",
      text: "History answer",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://example.test/repeated",
          title: "Repeated",
          cited_text: "History",
        },
        {
          type: "web_search_result_location",
          url: "https://example.test/repeated",
          title: "Repeated",
          cited_text: "answer",
        },
      ],
    }
    assistant.content[1] = {
      type: "web_search_tool_result",
      tool_use_id: "search-history",
      content: [
        {
          type: "web_search_result",
          url: "https://example.test/synthetic",
          title: "Synthetic",
        },
      ],
    }

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }),
    ).toThrow("synthetic Web Search history")
  })

  test("rejects ambiguous markerless empty success before native Messages", () => {
    const payload = makePayload()
    const assistant = payload.messages[1]
    if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("invalid fixture")
    }
    const serverTool = assistant.content[0] as {
      input: Record<string, unknown>
    }
    delete serverTool.input[WEB_SEARCH_HISTORY_CARRIER_FIELD]

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }),
    ).toThrow("ambiguous synthetic Web Search history")
  })

  test("keeps native search errors on Messages and rejects them on Responses", () => {
    const nativeErrorPayload = {
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu-native-error",
              name: "web_search",
              input: { query: "native error" },
              caller: { type: "direct" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu-native-error",
              content: {
                type: "web_search_tool_result_error",
                error_code: "unavailable",
              },
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    expect(
      webSearchCarrierSanitizer.sanitize(structuredClone(nativeErrorPayload), {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }).restoredTurns,
    ).toEqual([])
    expect(() =>
      webSearchCarrierSanitizer.sanitize(
        structuredClone(nativeErrorPayload),
        responsesContext,
      ),
    ).toThrow("native Web Search history")
  })

  test("rejects markerless search errors without native or gateway provenance", () => {
    const ambiguousError = {
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu-ambiguous-error",
              name: "web_search",
              input: { query: "ambiguous" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu-ambiguous-error",
              content: {
                type: "web_search_tool_result_error",
                error_code: "unavailable",
              },
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    expect(() =>
      webSearchCarrierSanitizer.sanitize(structuredClone(ambiguousError), {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }),
    ).toThrow("error provenance is ambiguous")
    expect(() =>
      webSearchCarrierSanitizer.sanitize(
        structuredClone(ambiguousError),
        responsesContext,
      ),
    ).toThrow("error provenance is ambiguous")
  })

  test("classifies citation-only native history before Responses translation", () => {
    const citationOnly = {
      model: "claude-sonnet-4.5",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Native cited answer",
              citations: [
                {
                  type: "web_search_result_location",
                  url: "https://example.test/native-citation",
                  title: "Native citation",
                  cited_text: "Native cited answer",
                  encrypted_index: "opaque-citation-only-index",
                },
              ],
            },
          ],
        },
      ],
    } as AnthropicMessagesPayload

    const nativeCopy = structuredClone(citationOnly)
    expect(
      webSearchCarrierSanitizer.sanitize(nativeCopy, {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }).restoredTurns,
    ).toEqual([])
    expect(nativeCopy).toEqual(citationOnly)
    expect(() =>
      webSearchCarrierSanitizer.sanitize(
        structuredClone(citationOnly),
        responsesContext,
      ),
    ).toThrow("native Web Search history")
  })

  test("classifies every assistant turn instead of letting native history mask synthetic history", () => {
    const payload = makePayload()
    const synthetic = payload.messages[1]
    if (synthetic.role !== "assistant" || !Array.isArray(synthetic.content)) {
      throw new Error("invalid fixture")
    }
    const serverTool = synthetic.content[0] as {
      input: Record<string, unknown>
    }
    delete serverTool.input[WEB_SEARCH_HISTORY_CARRIER_FIELD]
    payload.messages.splice(1, 0, {
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu-native-mixed",
          name: "web_search",
          input: { query: "native" },
          caller: { type: "direct" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu-native-mixed",
          content: [
            {
              type: "web_search_result",
              url: "https://example.test/native",
              title: "Native",
              encrypted_content: "opaque-native-mixed",
            },
          ],
        },
      ],
    })

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, {
        destination: "messages",
        canonicalTarget: {
          adapter: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4.5",
        },
      }),
    ).toThrow("ambiguous synthetic Web Search history")
  })

  test("rejects a native turn even when another turn has an accepted carrier", () => {
    const payload = makePayload()
    payload.messages.splice(2, 0, {
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu-native-alongside-carrier",
          name: "web_search",
          input: { query: "native" },
          caller: { type: "direct" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu-native-alongside-carrier",
          content: [
            {
              type: "web_search_result",
              url: "https://example.test/native",
              title: "Native",
              encrypted_content: "opaque-native-alongside-carrier",
            },
          ],
        },
      ],
    })

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, responsesContext),
    ).toThrow("native Web Search history")
  })

  test("rejects unmatched markerless server calls instead of silently dropping them", () => {
    const payload = makePayload()
    const assistant = payload.messages[1]
    if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("invalid fixture")
    }
    const serverTool = assistant.content[0] as {
      input: Record<string, unknown>
    }
    delete serverTool.input[WEB_SEARCH_HISTORY_CARRIER_FIELD]
    assistant.content = assistant.content.filter(
      (block) => block.type !== "web_search_tool_result",
    )

    expect(() =>
      webSearchCarrierSanitizer.sanitize(payload, responsesContext),
    ).toThrow("markerless Web Search calls are incomplete")
  })

  test("keeps markerless legacy output visible but non-resumable", () => {
    const payload = makePayload()
    const assistant = payload.messages[1]
    if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("invalid fixture")
    }
    const serverTool = assistant.content[0] as {
      input: Record<string, unknown>
    }
    delete serverTool.input[WEB_SEARCH_HISTORY_CARRIER_FIELD]
    assistant.content[2] = {
      type: "text",
      text: "History answer",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://example.test/repeated",
          title: "Repeated",
          cited_text: "History",
        },
        {
          type: "web_search_result_location",
          url: "https://example.test/repeated",
          title: "Repeated",
          cited_text: "answer",
        },
      ],
    }

    const sanitization = webSearchCarrierSanitizer.sanitize(
      payload,
      responsesContext,
    )
    const translated = translateAnthropicMessagesToResponsesPayload(
      payload,
      undefined,
      { provider: "copilot", model: source.model },
      { restoredWebSearchTurns: sanitization.restoredTurns },
    )

    expect(sanitization.restoredTurns).toEqual([])
    expect(translated.input).toEqual([
      { type: "message", role: "user", content: "Before" },
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: "History answer",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 7,
                url: "https://example.test/repeated",
                title: "Repeated",
              },
              {
                type: "url_citation",
                start_index: 8,
                end_index: 14,
                url: "https://example.test/repeated",
                title: "Repeated",
              },
            ],
          },
        ],
      },
      { type: "message", role: "user", content: "After" },
    ])
    if (!Array.isArray(translated.input)) throw new Error("invalid input")
    expect(
      translated.input.some(
        (item) => (item as { type?: string }).type === "web_search_call",
      ),
    ).toBe(false)
  })

  for (const [label, citations, text] of [
    ["non-array", {}, "visible"],
    ["primitive entry", [null], "visible"],
    [
      "unknown type",
      [
        {
          type: "private_future_location",
          url: "https://example.test",
          title: "Private",
          cited_text: "visible",
        },
      ],
      "visible",
    ],
    [
      "unexpected range fields",
      [
        {
          type: "web_search_result_location",
          url: "https://example.test",
          title: "Private",
          cited_text: "visible",
          start_index: 0,
          end_index: 7,
        },
      ],
      "visible",
    ],
    [
      "missing cited text",
      [
        {
          type: "web_search_result_location",
          url: "https://example.test",
          title: "Private",
          cited_text: "private-not-in-text",
        },
      ],
      "visible",
    ],
    [
      "citation count",
      Array.from({ length: 1_025 }, () => ({
        type: "web_search_result_location",
        url: "https://example.test",
        title: "Private",
        cited_text: "visible",
      })),
      "visible",
    ],
    [
      "citation bytes",
      [
        {
          type: "web_search_result_location",
          url: "https://example.test",
          title: "Private",
          cited_text: "x".repeat(1024 * 1024 + 1),
        },
      ],
      "x".repeat(1024 * 1024 + 1),
    ],
  ] as const) {
    test(`rejects ${label} Web Search citations with a structured 400`, () => {
      const payload = {
        model: source.model,
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text, citations }],
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicMessagesPayload
      const sanitization = webSearchCarrierSanitizer.sanitize(
        payload,
        responsesContext,
      )
      let thrown: unknown
      try {
        translateAnthropicMessagesToResponsesPayload(
          payload,
          undefined,
          { provider: "copilot", model: source.model },
          { restoredWebSearchTurns: sanitization.restoredTurns },
        )
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HTTPError)
      expect((thrown as HTTPError).response.status).toBe(400)
      expect((thrown as Error).message).not.toContain("private-not-in-text")
    })
  }
})
