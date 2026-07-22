import { describe, expect, it } from "bun:test"
import { Buffer } from "node:buffer"

import { requestContext } from "~/lib/request-context"
import { createMcpToolSearchSentinel } from "~/lib/tool-search"
import { HTTPError } from "~/lib/error"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type {
  ResponseFunctionCallOutputItem,
  ResponseInputMessage,
  ResponseInputReasoning,
  ResponseToolSearchCallItem,
  ResponseToolSearchOutputItem,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"

const samplePayload = {
  model: "claude-3-5-sonnet",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
        },
        {
          type: "text",
          text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
        },
        {
          type: "text",
          text: "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
        },
        {
          type: "text",
          text: "hi",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    },
  ],
} as unknown as AnthropicMessagesPayload

const sampleTools = [
  {
    name: "getWeather",
    description: "Gets weather info",
    input_schema: {
      location: {
        type: "string",
      },
    },
  },
]

const jsonStyleUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752",
})

const legacyStyleUserId =
  "user_8b7e2c1d4f6a9b3c0d1e2f3456789abcdeffedcba9876543210fedcba1234567_account__session_7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b"

const emptySessionUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "",
})

const subagentAgentId = "agent-123"

const translateThinking = (thinking: string): ResponseInputReasoning => {
  const result = translateAnthropicMessagesToResponsesPayload({
    ...samplePayload,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking,
            signature: `${"A".repeat(64)}@rs_reasoning-id`,
          },
        ],
      },
    ],
  })

  return (result.input as Array<ResponseInputReasoning>)[0]
}

describe("translateAnthropicMessagesToResponsesPayload", () => {
  it("restores NBSP and legacy U+2063 summary boundaries", () => {
    const firstSummary =
      "**Preparing to search online**\n\nI need to use web.run."
    const secondSummary = "**Running the search**"

    for (const separator of ["\u00a0\n\n", "\u2063\n\n"]) {
      expect(
        translateThinking(firstSummary + separator + secondSummary).summary,
      ).toEqual([
        { type: "summary_text", text: firstSummary },
        { type: "summary_text", text: secondSummary },
      ])
    }
  })

  it("preserves unmarked reasoning history as one summary", () => {
    const unmarkedThinking =
      "**Preparing**\n\nDescription\n\n**A bold body line**\n\nMore text"

    expect(translateThinking(unmarkedThinking).summary).toEqual([
      { type: "summary_text", text: unmarkedThinking },
    ])
  })

  it("does not restore legacy malformed reasoning signatures into Responses input", () => {
    const translateSignature = (signature: string) =>
      translateAnthropicMessagesToResponsesPayload({
        model: "gpt-5.6-sol",
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Historical summary",
                signature,
              },
            ],
          },
        ],
      }).input

    expect([
      translateSignature("@reasoning-id"),
      translateSignature("opaque-cipher@"),
      translateSignature("native-anthropic@sig"),
    ]).toEqual([[], [], []])
  })

  it("restores legacy long opaque Copilot reasoning carriers", () => {
    const encryptedContent = "A".repeat(96)
    const id = "B".repeat(96)
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Historical summary",
              signature: `${encryptedContent}@${id}`,
            },
          ],
        },
      ],
    })

    expect(result.input).toEqual([
      {
        id,
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Historical summary" }],
        encrypted_content: encryptedContent,
      },
    ])
  })

  it("does not restore malformed versioned reasoning carriers", () => {
    const translateCarrier = (value: unknown) =>
      translateAnthropicMessagesToResponsesPayload({
        model: "gpt-5.6-sol",
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "Historical summary",
                signature:
                  "copilot-api-openai-reasoning-v1:"
                  + Buffer.from(JSON.stringify(value), "utf8").toString(
                    "base64url",
                  ),
              },
            ],
          },
        ],
      }).input

    expect([
      translateCarrier({
        id: "reason_invalid_summary",
        type: "reasoning",
        summary: [1],
        encrypted_content: "opaque",
      }),
      translateCarrier({
        id: "reason_invalid_status",
        type: "reasoning",
        summary: [],
        status: "done-ish",
        encrypted_content: "opaque",
      }),
    ]).toEqual([[], []])
  })

  it("prefers the requested output_config reasoning effort", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      output_config: {
        effort: "xhigh",
      },
    })

    expect(result.reasoning?.effort).toBe("xhigh")
  })

  it("forwards Codex ultra reasoning effort through Messages to Responses", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      output_config: {
        effort: "ultra",
      },
    })

    expect(result.reasoning?.effort).toBe("ultra")
  })

  it("preserves the Claude client request bundle when bridging to GPT Responses", () => {
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    }
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 100,
      messages: [{ role: "user", content: "return structured output" }],
      temperature: 0.7,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "max",
        format: {
          type: "json_schema",
          schema,
        },
      },
      tools: [],
      tool_choice: {
        type: "auto",
        disable_parallel_tool_use: true,
      },
    })

    expect(result).toMatchObject({
      max_output_tokens: 100,
      temperature: 0.7,
      parallel_tool_calls: false,
      reasoning: {
        effort: "max",
        summary: "auto",
        context: "all_turns",
      },
      text: {
        format: {
          type: "json_schema",
          name: "anthropic_output",
          strict: true,
          schema,
        },
      },
      tools: [],
    })
    expect(result).not.toHaveProperty("tool_choice")
  })

  it("preserves forced executeCode as a Responses function tool", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [{ role: "user", content: "Run 1+1" }],
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code in the IDE",
          input_schema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: "mcp__ide__executeCode",
      },
    })

    expect(result.tools).toEqual([
      {
        type: "function",
        name: "mcp__ide__executeCode",
        description: "Execute code in the IDE",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
        },
        strict: false,
      },
    ])
    expect(result.tool_choice).toEqual({
      type: "function",
      name: "mcp__ide__executeCode",
    })
  })

  it("converts anthropic text blocks into response input messages", () => {
    const result = translateAnthropicMessagesToResponsesPayload(samplePayload)

    expect(Array.isArray(result.input)).toBe(true)
    const input = result.input as Array<ResponseInputMessage>
    expect(input).toHaveLength(1)

    const message = input[0]
    expect(message.role).toBe("user")
    expect(Array.isArray(message.content)).toBe(true)

    const content = message.content as Array<{ text: string }>
    expect(content.map((item) => item.text)).toEqual([
      "<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>",
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>",
      "hi",
      "<system-reminder>\nThe user opened the file c:\\Work2\\copilot-api\\src\\routes\\responses\\translation.ts in the IDE. This may or may not be related to the current task.\n</system-reminder>",
      "hi",
    ])
  })

  it("extracts identifiers from JSON-like user_id metadata", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: jsonStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("appends subagent agent_id to metadata prompt cache key", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: sampleTools,
      },
      ` ${subagentAgentId} `,
    )

    expect(result.prompt_cache_key).toBe(
      "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752:agent:agent-123",
    )
  })

  it("keeps legacy user_id parsing before JSON fallback", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      ...samplePayload,
      metadata: {
        user_id: legacyStyleUserId,
      },
      tools: sampleTools,
    })

    expect(result.prompt_cache_key).toBe("7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b")
  })

  it("falls back to session affinity when metadata session id is empty", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translateAnthropicMessagesToResponsesPayload({
          ...samplePayload,
          metadata: {
            user_id: emptySessionUserId,
          },
          tools: sampleTools,
        }),
    )

    expect(result.prompt_cache_key).toBe("opencode-session")
  })

  it("appends subagent agent_id to session affinity fallback", () => {
    const result = requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () =>
        translateAnthropicMessagesToResponsesPayload(
          {
            ...samplePayload,
            metadata: {
              user_id: emptySessionUserId,
            },
            tools: sampleTools,
          },
          ` ${subagentAgentId} `,
        ),
    )

    expect(result.prompt_cache_key).toBe("opencode-session:agent:agent-123")
  })

  it("keeps unrelated system prompt text unchanged", () => {
    const payload = {
      model: "gpt-5.4",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: "ordinary system prompt",
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello gpt54" }],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    const result = translateAnthropicMessagesToResponsesPayload(payload)

    expect(result.instructions).toContain("ordinary system prompt")
    expect(result.instructions).not.toContain("cch=<stable>;")
  })

  it("ignores blank subagent agent_id", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: sampleTools,
      },
      "   ",
    )

    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("keeps prompt_cache_key null when only subagent agent_id is provided", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        tools: sampleTools,
      },
      subagentAgentId,
    )

    expect(result.prompt_cache_key).toBeNull()
  })

  it("keeps a stable prompt_cache_key when tools are missing", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        model: "gpt-5.6-sol",
        metadata: {
          user_id: jsonStyleUserId,
        },
      },
      subagentAgentId,
    )

    expect(result.prompt_cache_key).toBe(
      "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752:agent:agent-123",
    )
  })

  it("keeps a stable prompt_cache_key when tools are empty", () => {
    const result = translateAnthropicMessagesToResponsesPayload(
      {
        ...samplePayload,
        model: "gpt-5.6-sol",
        metadata: {
          user_id: jsonStyleUserId,
        },
        tools: [],
      },
      subagentAgentId,
    )

    expect(result.prompt_cache_key).toBe(
      "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752:agent:agent-123",
    )
  })

  it("maps the latest three caller cache markers to GPT-5.6 breakpoints", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      metadata: {
        user_id: jsonStyleUserId,
      },
      messages: ["one", "two", "three", "four"].map((text) => ({
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text,
            cache_control: { type: "ephemeral" as const },
          },
        ],
      })),
    })

    const input = result.input as Array<ResponseInputMessage>
    const content = input.map(
      (message) => (message.content as Array<Record<string, unknown>>)[0],
    )

    expect(content[0]).not.toHaveProperty("prompt_cache_breakpoint")
    for (const block of content.slice(1)) {
      expect(block.prompt_cache_breakpoint).toEqual({ mode: "explicit" })
    }
    expect(result.prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    })
    expect(result.prompt_cache_key).toBe("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752")
  })

  it("keeps old-model no-tool cache behavior without GPT-5.6 fields", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.5",
      max_tokens: 128,
      metadata: { user_id: jsonStyleUserId },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "stable prefix",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    })

    expect(result).not.toHaveProperty("prompt_cache_key")
    expect(result).not.toHaveProperty("prompt_cache_options")
    const input = result.input as Array<ResponseInputMessage>
    expect(input[0]?.content?.[0]).not.toHaveProperty("prompt_cache_breakpoint")
  })

  it("maps tool_reference tool results into function_call_output text", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "Tool AskUserQuestion loaded",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("maps document tool results into function_call_output input_file content", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-4.1",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "pdf-data",
                  },
                  title: "report.pdf",
                },
              ],
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseFunctionCallOutputItem>
    expect(input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_file",
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,pdf-data",
          },
        ],
        status: "completed",
      },
    ])
  })

  it("maps canonical file-backed image and document sources", () => {
    const payload = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              cache_control: { type: "ephemeral" },
              source: { file_id: "file_image", type: "file" },
              type: "image",
            },
            {
              cache_control: { type: "ephemeral" },
              source: { file_id: "file_document", type: "file" },
              type: "document",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-5.6-sol",
    } satisfies AnthropicMessagesPayload

    expect(translateAnthropicMessagesToResponsesPayload(payload).input).toEqual(
      [
        {
          content: [
            {
              detail: "auto",
              file_id: "file_image",
              prompt_cache_breakpoint: { mode: "explicit" },
              type: "input_image",
            },
            {
              file_id: "file_document",
              prompt_cache_breakpoint: { mode: "explicit" },
              type: "input_file",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
    )
  })

  it("maps canonical file-backed tool-result media without JSON text", () => {
    const payload = {
      max_tokens: 128,
      messages: [
        {
          content: [
            { id: "tool_1", input: {}, name: "inspect", type: "tool_use" },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              content: [
                {
                  source: { file_id: "file_image", type: "file" },
                  type: "image",
                },
                {
                  source: { file_id: "file_document", type: "file" },
                  type: "document",
                },
              ],
              tool_use_id: "tool_1",
              type: "tool_result",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-5.6-sol",
    } satisfies AnthropicMessagesPayload

    const result = translateAnthropicMessagesToResponsesPayload(payload)
    expect(result.input).toContainEqual({
      call_id: "tool_1",
      output: [
        { detail: "auto", file_id: "file_image", type: "input_image" },
        { file_id: "file_document", type: "input_file" },
      ],
      status: "completed",
      type: "function_call_output",
    })
  })

  it("fails closed on canonical text/content document sources", async () => {
    const payloads: Array<AnthropicMessagesPayload> = [
      {
        max_tokens: 128,
        messages: [
          {
            content: [
              {
                source: {
                  data: "document text",
                  media_type: "text/plain",
                  type: "text",
                },
                type: "document",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-5.6-sol",
      },
      {
        max_tokens: 128,
        messages: [
          {
            content: [
              {
                source: {
                  content: [{ text: "document text", type: "text" }],
                  type: "content",
                },
                type: "document",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-5.6-sol",
      },
    ]

    for (const payload of payloads) {
      let thrown: unknown
      try {
        translateAnthropicMessagesToResponsesPayload(payload)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(HTTPError)
      const response = (thrown as HTTPError).response
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          message:
            "Anthropic document text/content sources are not supported by the Responses translation path.",
          type: "invalid_request_error",
        },
      })
    }
  })

  it("fails closed on text documents nested in tool results", () => {
    const payload = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              content: [
                {
                  source: {
                    data: "document text",
                    media_type: "text/plain",
                    type: "text",
                  },
                  type: "document",
                },
              ],
              tool_use_id: "tool_1",
              type: "tool_result",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-5.6-sol",
    } satisfies AnthropicMessagesPayload

    expect(() => translateAnthropicMessagesToResponsesPayload(payload)).toThrow(
      HTTPError,
    )
  })

  it("fails closed on malformed Anthropic image and document sources", () => {
    const payloads = ["image", "document"].map(
      (type) =>
        ({
          max_tokens: 128,
          messages: [{ content: [{ source: {}, type }], role: "user" }],
          model: "gpt-5.6-sol",
        }) as unknown as AnthropicMessagesPayload,
    )
    payloads.push({
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              source: { content: [null], type: "content" },
              type: "document",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-5.6-sol",
    } as unknown as AnthropicMessagesPayload)

    for (const payload of payloads) {
      expect(() =>
        translateAnthropicMessagesToResponsesPayload(payload),
      ).toThrow(HTTPError)
    }
  })

  it("preserves Anthropic URL image and document sources", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: "https://example.com/image.png",
              },
            },
            {
              type: "document",
              title: "remote.pdf",
              source: {
                type: "url",
                url: "https://example.com/document.pdf",
              },
            },
          ],
        },
      ],
    })

    const input = result.input as Array<ResponseInputMessage>
    expect(input[0]?.content).toEqual([
      {
        type: "input_image",
        image_url: "https://example.com/image.png",
        detail: "auto",
      },
      {
        type: "input_file",
        file_url: "https://example.com/document.pdf",
      },
    ])
  })

  it("keeps unknown tool-result blocks as JSON text", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_future",
              content: [
                {
                  type: "future_result",
                  score: 0.75,
                  payload: { ok: true },
                },
              ],
            },
          ],
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_future",
        output: [
          {
            type: "input_text",
            text: '{"type":"future_result","score":0.75,"payload":{"ok":true}}',
          },
        ],
        status: "completed",
      },
    ])
  })

  it("rejects malformed tool-result content with a structured 400", async () => {
    const malformedContents: Array<unknown> = [
      null,
      [null],
      { text: "not an array", type: "text" },
      [{ type: "text" }],
      [{ type: "tool_reference" }],
      [
        {
          source: { media_type: "image/png", type: "base64" },
          type: "image",
        },
      ],
      [
        {
          source: {
            data: "AQID",
            media_type: "application/pdf",
            type: "base64",
          },
          type: "image",
        },
      ],
      [{ source: { type: "file" }, type: "document" }],
    ]

    for (const content of malformedContents) {
      const payload = {
        max_tokens: 128,
        messages: [
          {
            content: [
              {
                content,
                tool_use_id: "call_malformed",
                type: "tool_result",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-5.6-sol",
      } as unknown as AnthropicMessagesPayload

      let thrown: unknown
      try {
        translateAnthropicMessagesToResponsesPayload(payload)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(HTTPError)
      const response = (thrown as HTTPError).response
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          message:
            "Anthropic tool_result content must be a string or an array of typed content blocks.",
          type: "invalid_request_error",
        },
      })
    }
  })

  it("maps a tool-result cache marker onto its Responses output content", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      metadata: { user_id: jsonStyleUserId },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_cached",
              content: "stable tool output",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_cached",
        output: [
          {
            type: "input_text",
            text: "stable tool output",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
        status: "completed",
      },
    ])
    expect(result.prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    })
  })

  it("preserves cache markers nested inside tool-result content", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      metadata: { user_id: jsonStyleUserId },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_nested_cache",
              content: [
                {
                  type: "text",
                  text: "stable nested output",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
      ],
    })

    const output = (result.input as Array<ResponseFunctionCallOutputItem>)[0]
      ?.output as Array<Record<string, unknown>>
    expect(output[0]?.prompt_cache_breakpoint).toEqual({ mode: "explicit" })
    expect(result.prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    })
  })

  it("converts bridge and deferred tools into Responses tool_search and namespaces", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          description: "Search deferred tools",
          input_schema: {
            type: "object",
            properties: {
              names: { type: "string" },
            },
            required: ["names"],
          },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
            required: ["url"],
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
            required: ["uid"],
          },
        },
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description:
          "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              description: "Exact deferred tool names to load.",
              items: {
                type: "string",
                enum: ["mcp__fetch__fetch", "chrome-devtools_click"],
              },
              minItems: 1,
            },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
      {
        type: "namespace",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        tools: [
          {
            type: "function",
            name: "mcp__fetch__fetch",
            description: "Fetch a URL",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string" },
              },
              required: ["url"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "namespace",
        name: "chrome-devtools_click",
        description: "Click an element",
        tools: [
          {
            type: "function",
            name: "chrome-devtools_click",
            description: "Click an element",
            parameters: {
              type: "object",
              properties: {
                uid: { type: "string" },
              },
              required: ["uid"],
            },
            strict: false,
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
          },
          required: ["file_path"],
        },
        strict: false,
      },
    ])
  })

  it("keeps workflow control tool definitions and history eager", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_workflow",
              name: "Workflow",
              input: { action: "plan" },
            },
            {
              type: "tool_use",
              id: "call_report",
              name: "ReportFindings",
              input: { summary: "ready" },
            },
            {
              type: "tool_use",
              id: "call_fetch",
              name: "mcp__fetch__fetch",
              input: { url: "https://example.com" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "Workflow",
          description: "Plan and run a workflow",
          input_schema: { type: "object" },
        },
        {
          name: "ReportFindings",
          description: "Report workflow findings",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: { type: "object" },
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call",
        call_id: "call_workflow",
        name: "Workflow",
        arguments: '{"action":"plan"}',
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "call_report",
        name: "ReportFindings",
        arguments: '{"summary":"ready"}',
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "call_fetch",
        name: "mcp__fetch__fetch",
        namespace: "mcp__fetch__fetch",
        arguments: '{"url":"https://example.com"}',
        status: "completed",
      },
    ])
    expect(result.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description:
          "Load deferred tools by exact name before using them. Return only the searchable tool names you need for the next step.",
        parameters: {
          type: "object",
          properties: {
            names: {
              type: "array",
              description: "Exact deferred tool names to load.",
              items: {
                type: "string",
                enum: ["mcp__fetch__fetch"],
              },
              minItems: 1,
            },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "Workflow",
        description: "Plan and run a workflow",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
      {
        type: "function",
        name: "ReportFindings",
        description: "Report workflow findings",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
      {
        type: "namespace",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        tools: [
          {
            type: "function",
            name: "mcp__fetch__fetch",
            parameters: { type: "object", properties: {} },
            strict: false,
            defer_loading: true,
            description: "Fetch a URL",
          },
        ],
      },
    ])
  })

  it("keeps deferred candidates as normal functions when the bridge tool is absent", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "fetch a page" }],
      tools: [
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
        {
          name: "chrome-devtools_click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: {
              uid: { type: "string" },
            },
          },
        },
      ],
    })

    expect(result.parallel_tool_calls).toBe(true)
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "mcp__fetch__fetch",
        description: "Fetch a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
          },
        },
        strict: false,
      },
      {
        type: "function",
        name: "chrome-devtools_click",
        description: "Click an element",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "string" },
          },
        },
        strict: false,
      },
    ])
  })

  it("maps bridge tool_use history into tool_search_call input items", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<ResponseToolSearchCallItem>
    expect(input).toEqual([
      {
        type: "tool_search_call",
        call_id: "call_search",
        arguments: { names: ["mcp__fetch__fetch"] },
        execution: "client",
        status: "completed",
      },
    ])
  })

  it("preserves namespace on deferred tool_use history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_shipping_eta",
              name: "get_shipping_eta",
              input: { order_id: "order_42" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "get_shipping_eta",
          input_schema: { type: "object" },
        },
      ],
    })

    expect(result.input).toEqual([
      {
        type: "function_call",
        call_id: "call_shipping_eta",
        name: "get_shipping_eta",
        namespace: "get_shipping_eta",
        arguments: '{"order_id":"order_42"}',
        status: "completed",
      },
    ])
  })

  it("accepts tool_search bridge aliases in tool_use history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "tool_search_search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "tool_search_search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<ResponseToolSearchCallItem>
    expect(input).toEqual([
      {
        type: "tool_search_call",
        call_id: "call_search",
        arguments: { names: ["mcp__fetch__fetch"] },
        execution: "client",
        status: "completed",
      },
    ])
  })

  it("rebuilds tool_search_output from tool_reference history", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "mcp__fetch__fetch" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: [
                {
                  type: "tool_reference",
                  tool_name: "mcp__fetch__fetch",
                },
              ],
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: {
            type: "object",
            properties: {
              url: { type: "string" },
            },
          },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    expect(input[1]).toEqual({
      type: "tool_search_output",
      call_id: "call_search",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          tools: [
            {
              type: "function",
              name: "mcp__fetch__fetch",
              description: "Fetch a URL",
              parameters: {
                type: "object",
                properties: {
                  url: { type: "string" },
                },
              },
              strict: false,
              defer_loading: true,
            },
          ],
        },
      ],
      status: "completed",
    })
  })

  it("rebuilds tool_search_output from bridge sentinel results", () => {
    const result = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.4",
      max_tokens: 1024,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_search",
              name: "mcp__tool_search__search",
              input: { names: "TaskList" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_search",
              content: createMcpToolSearchSentinel("TaskList"),
            },
          ],
        },
      ],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__fetch__fetch",
          description: "Fetch a URL",
          input_schema: { type: "object" },
        },
        {
          name: "TaskList",
          description: "List tasks",
          input_schema: { type: "object" },
        },
      ],
    })

    const input = result.input as Array<
      ResponseToolSearchCallItem | ResponseToolSearchOutputItem
    >
    const output = input[1] as ResponseToolSearchOutputItem
    expect(output.type).toBe("tool_search_output")
    expect(output.execution).toBe("client")
    expect(
      (output.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["TaskList"])
  })
})

describe("translateResponsesResultToAnthropic", () => {
  it("clamps ordinary input usage while preserving cache buckets", () => {
    const response = {
      id: "resp_usage",
      object: "response",
      created_at: 0,
      model: "gpt-5.6-sol",
      output: [],
      output_text: "",
      status: "completed",
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
    } as ResponsesResult

    expect(translateResponsesResultToAnthropic(response).usage).toEqual({
      input_tokens: 0,
      output_tokens: 3,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 8,
    })
  })

  it("does not invent a reasoning signature when Copilot returned no encrypted carrier", () => {
    const response = {
      id: "resp_without_carrier",
      object: "response",
      created_at: 0,
      model: "gpt-5.6-sol",
      output: [
        {
          id: "reason_without_carrier",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Visible summary" }],
          status: "completed",
        },
      ],
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
    } as ResponsesResult

    expect(translateResponsesResultToAnthropic(response).content).toEqual([
      {
        type: "thinking",
        thinking: "Visible summary",
        signature: "",
      },
    ])
  })

  it("round-trips a real encrypted reasoning carrier into the next Responses input", () => {
    const firstTurn = {
      id: "resp_carrier",
      object: "response",
      created_at: 0,
      model: "gpt-5.6-sol",
      output: [
        {
          id: "reason_carrier",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checked the request." }],
          encrypted_content: "opaque-encrypted-carrier",
          status: "completed",
          provider_extension: {
            opaque_state: "preserve-me",
          },
        },
      ],
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
    } as unknown as ResponsesResult

    const anthropic = translateResponsesResultToAnthropic(firstTurn)
    expect(anthropic.content).toHaveLength(1)
    expect(anthropic.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Checked the request.",
    })
    const reasoningBlock = anthropic.content[0]
    if (reasoningBlock?.type !== "thinking") {
      throw new Error("Expected translated encrypted reasoning")
    }
    expect(reasoningBlock.signature).toStartWith(
      "copilot-api-openai-reasoning-v2:",
    )

    const nextTurn = translateAnthropicMessagesToResponsesPayload({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [reasoningBlock],
        },
        {
          role: "user",
          content: "continue",
        },
      ],
    })

    expect(nextTurn.input).toEqual([
      {
        id: "reason_carrier",
        type: "reasoning",
        summary: [
          {
            type: "summary_text",
            text: "Checked the request.",
          },
        ],
        encrypted_content: "opaque-encrypted-carrier",
        status: "completed",
        provider_extension: {
          opaque_state: "preserve-me",
        },
      },
      {
        type: "message",
        role: "user",
        content: "continue",
      },
    ])
  })

  it("does not replay a versioned reasoning carrier across provider or model boundaries", () => {
    const firstTurn = {
      id: "resp_carrier_scope",
      object: "response",
      created_at: 0,
      model: "gpt-5.6-sol",
      output: [
        {
          id: "reason_scoped",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Scoped reasoning." }],
          encrypted_content: "opaque-scoped-carrier",
          status: "completed",
        },
      ],
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
    } as unknown as ResponsesResult
    const anthropic = translateResponsesResultToAnthropic(firstTurn, {
      carrierSource: { provider: "copilot", model: "gpt-5.6-sol" },
    })
    const reasoningBlock = anthropic.content[0]
    if (reasoningBlock?.type !== "thinking") {
      throw new Error("Expected translated encrypted reasoning")
    }

    const makeNextTurn = (provider: string, model: string) =>
      translateAnthropicMessagesToResponsesPayload(
        {
          model,
          max_tokens: 128,
          messages: [
            { role: "assistant", content: [reasoningBlock] },
            { role: "user", content: "continue" },
          ],
        },
        undefined,
        { provider, model },
      )
    const hasReasoning = (provider: string, model: string) => {
      const input = makeNextTurn(provider, model).input
      return (
        Array.isArray(input) && input.some((item) => item.type === "reasoning")
      )
    }

    expect(hasReasoning("copilot", "gpt-5.6-sol")).toBe(true)
    expect(hasReasoning("copilot", "gpt-5.6-terra")).toBe(false)
    expect(hasReasoning("codex", "gpt-5.6-sol")).toBe(false)
  })

  it("handles reasoning and function call items", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_123",
      object: "response",
      created_at: 0,
      model: "gpt-4.1",
      output: [
        {
          id: "reason_1",
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: "**Thinking about the task**\n\nReviewing the request.",
            },
            { type: "summary_text", text: "**Preparing the tool call**" },
          ],
          status: "completed",
          encrypted_content: "encrypted_reasoning_content",
        },
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "TodoWrite",
          arguments:
            '{"todos":[{"content":"Read src/routes/responses/translation.ts","status":"in_progress"}]}',
          status: "completed",
        },
        {
          id: "message_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Added the task to your todo list.",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "Added the task to your todo list.",
      status: "incomplete",
      usage: {
        input_tokens: 120,
        output_tokens: 36,
        total_tokens: 156,
      },
      error: null,
      incomplete_details: { reason: "content_filter" },
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBeNull()
    expect(anthropicResponse.content).toHaveLength(3)

    const [thinkingBlock, toolUseBlock, textBlock] = anthropicResponse.content

    expect(thinkingBlock.type).toBe("thinking")
    if (thinkingBlock.type === "thinking") {
      const thinking = thinkingBlock.thinking
      expect(thinking).toBe(
        "**Thinking about the task**\n\nReviewing the request."
          + "\u00a0\n\n"
          + "**Preparing the tool call**",
      )
      expect(thinking.match(/\u00a0\n\n/g)).toHaveLength(1)
      expect(thinking).not.toContain("\u2063\n\n")
    }

    expect(toolUseBlock.type).toBe("tool_use")
    if (toolUseBlock.type === "tool_use") {
      expect(toolUseBlock.id).toBe("call_1")
      expect(toolUseBlock.name).toBe("TodoWrite")
      expect(toolUseBlock.input).toEqual({
        todos: [
          {
            content: "Read src/routes/responses/translation.ts",
            status: "in_progress",
          },
        ],
      })
    }

    expect(textBlock.type).toBe("text")
    if (textBlock.type === "text") {
      expect(textBlock.text).toBe("Added the task to your todo list.")
    }
  })

  it("suppresses reasoning output when thinking is disabled", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_disabled",
      object: "response",
      created_at: 0,
      model: "gpt-5.5",
      output: [
        {
          id: "reasoning-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "hidden reasoning" }],
          encrypted_content: "opaque",
          status: "completed",
        },
        {
          id: "compaction-1",
          type: "compaction",
          encrypted_content: "opaque-compaction",
        },
        {
          id: "message-1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "OK",
              annotations: [],
            },
          ],
        },
      ],
      output_text: "OK",
      status: "completed",
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3,
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
    }

    const anthropicResponse = translateResponsesResultToAnthropic(
      responsesResult,
      { includeThinking: false },
    )

    expect(anthropicResponse.content).toEqual([{ type: "text", text: "OK" }])
  })

  it("uses function_call namespace as the Anthropic tool_use name", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_namespace",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "call_1",
          type: "function_call",
          call_id: "call_1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: '{"url":"https://example.com"}',
          status: "completed",
        },
      ],
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
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "mcp__fetch__fetch",
        input: {
          url: "https://example.com",
        },
      },
    ])
  })

  it("maps tool_search_call output into the bridge Anthropic tool_use", () => {
    const responsesResult: ResponsesResult = {
      id: "resp_search",
      object: "response",
      created_at: 0,
      model: "gpt-5.4",
      output: [
        {
          id: "search_1",
          type: "tool_search_call",
          call_id: "call_search",
          arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
          status: "completed",
        },
      ],
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
    }

    const anthropicResponse =
      translateResponsesResultToAnthropic(responsesResult)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content).toEqual([
      {
        type: "tool_use",
        id: "call_search",
        name: "mcp__tool_search__search",
        input: {
          names: "mcp__fetch__fetch,TaskList",
        },
      },
    ])
  })
})
