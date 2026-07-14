import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

const actualConfigModule = await import("../src/lib/config")

let mockedReasoningEffort:
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh" = "xhigh"

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getReasoningEffortForModel: () => mockedReasoningEffort,
}))

import {
  normalizeSystemMessages,
  prepareMessagesApiPayload,
  sanitizeIdeTools,
} from "../src/routes/messages/preprocess"

beforeEach(() => {
  mockedReasoningEffort = "xhigh"
})

afterEach(() => {
  mockedReasoningEffort = "xhigh"
})

describe("normalizeSystemMessages", () => {
  test("merges system string content into the previous message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "follow the repo style",
        },
        {
          role: "assistant",
          content: "working on it",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.system).toBeUndefined()
    expect(payload.messages).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nfollow the repo style\n</system-reminder>\n\nhello",
      },
      {
        role: "assistant",
        content: "working on it",
      },
    ])
  })

  test("moves leading system messages to payload.system and appends block content to the previous array message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "system",
          content: "leading system prompt",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
            },
          ],
        },
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "follow the repo style",
            },
          ],
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.system).toBe(
      "<system-reminder>\nleading system prompt\n</system-reminder>",
    )
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nfollow the repo style\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })

  test("inserts system text after tool_result blocks in user array content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "tool output",
            },
            {
              type: "text",
              text: "hello",
            },
          ],
        },
        {
          role: "system",
          content: "follow the repo style",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "tool output",
          },
          {
            type: "text",
            text: "<system-reminder>\nfollow the repo style\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })

  test("splits SubagentStart hook additional first line into its own content block", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: "hello",
        },
        {
          role: "system",
          content: "SubagentStart hook additional\nextra reminder",
        },
      ],
    }

    normalizeSystemMessages(payload)

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nSubagentStart hook additional\n</system-reminder>",
          },
          {
            type: "text",
            text: "<system-reminder>\nextra reminder\n</system-reminder>",
          },
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ])
  })
})

describe("sanitizeIdeTools", () => {
  test("continues to remove executeCode when Responses tool search is disabled", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__tool_search__search",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__tool_search__search",
      "mcp__ide__getDiagnostics",
    ])
  })

  test("does not keep executeCode for GPT models without the tool search bridge", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "mcp__ide__executeCode",
          description: "Execute code",
          input_schema: { type: "object" },
        },
        {
          name: "mcp__ide__getDiagnostics",
          description: "Old description",
          input_schema: { type: "object" },
        },
      ],
    }

    sanitizeIdeTools(payload)

    expect(payload.tools?.map((tool) => tool.name)).toEqual([
      "mcp__ide__getDiagnostics",
    ])
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({ effort: "xhigh" })
  })

  test("uses adaptive thinking for Claude Opus versions at least 4.7", () => {
    const models = [
      "claude-opus-4.7",
      "claude-opus-4.8",
      "claude-opus-4.10",
      "claude-opus-4-7-20260101",
    ]

    for (const model of models) {
      const payload: AnthropicMessagesPayload = {
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        thinking: {
          type: "enabled",
          budget_tokens: 1024,
        },
        output_config: {
          effort: "low",
        },
      }

      prepareMessagesApiPayload(payload, {
        capabilities: {
          supports: {
            adaptive_thinking: true,
            reasoning_effort: ["low", "medium", "high", "xhigh"],
          },
        },
      } as never)

      expect(payload.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      })
      expect(payload.output_config).toEqual({
        effort: "low",
      })
    }
  })

  test("maps Claude Opus maximum thinking budget to adaptive max effort", () => {
    const format = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    }
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 31_999,
      },
      output_config: { format },
      temperature: 0.7,
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
          max_thinking_budget: 32_000,
          reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({
      effort: "max",
      format,
    })
    expect(payload.temperature).toBe(0.7)
  })

  test("maps manual thinking budgets monotonically across supported efforts", () => {
    const cases = [
      [1, "low"],
      [8_000, "medium"],
      [16_000, "high"],
      [24_000, "xhigh"],
      [31_999, "max"],
    ] as const

    for (const [budgetTokens, expectedEffort] of cases) {
      const payload: AnthropicMessagesPayload = {
        model: "claude-opus-4.8",
        max_tokens: 32_000,
        messages: [{ role: "user", content: "hello" }],
        thinking: {
          type: "enabled",
          budget_tokens: budgetTokens,
        },
      }

      prepareMessagesApiPayload(payload, {
        capabilities: {
          supports: {
            adaptive_thinking: true,
            max_thinking_budget: 32_000,
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
        },
      } as never)

      expect(payload.output_config?.effort).toBe(expectedEffort)
    }
  })

  test("sets summarized display for non-Opus Claude versions at least 4.7", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4.7",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
      display: "summarized",
    })
  })

  test("preserves client thinking for Claude versions before 4.7", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
  })

  test("preserves client effort and temperature when thinking is active", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
      output_config: {
        effort: "low",
      },
      temperature: 0.7,
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
    expect(payload.output_config).toEqual({
      effort: "low",
    })
    expect(payload.temperature).toBe(0.7)
  })

  test("does not synthesize effort for manual budget thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
      temperature: 0.7,
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
    expect(payload.output_config).toBeUndefined()
    expect(payload.temperature).toBe(0.7)
  })

  test("preserves disabled thinking without setting effort", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: {
        type: "disabled",
        budget_tokens: 1024,
        display: "summarized",
      },
      temperature: 0.7,
    } as unknown as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "xhigh"],
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "disabled",
    })
    expect(payload.output_config).toBeUndefined()
    expect(payload.temperature).toBe(0.7)
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })

  test("normalizes enabled thinking before preserving forced tool choice", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.8",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "use the tool" }],
      thinking: {
        type: "enabled",
        budget_tokens: 31_999,
      },
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
          max_thinking_budget: 32_000,
          reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
        },
      },
    } as never)

    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(payload.output_config).toEqual({ effort: "max" })
    expect(payload.tool_choice).toEqual({
      type: "tool",
      name: "apply_patch",
    })
  })

  test("strips top-level cache_control sent by Zed (minimal-mode shape)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      cache_control: { type: "ephemeral" },
      system: [
        {
          type: "text",
          text: "You are the Zed coding agent ...",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello world!" }],
        },
      ],
    }

    prepareMessagesApiPayload(payload)

    expect(payload.cache_control).toBeUndefined()
    expect(payload.messages[0].content).toEqual([
      {
        type: "text",
        text: "Hello world!",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(
      (payload.system as unknown as Array<Record<string, unknown>>)[0]
        .cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("strips tool eager_input_streaming sent by Zed (write-mode shape)", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-haiku-4.5",
      max_tokens: 64000,
      cache_control: { type: "ephemeral" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello World" }],
        },
      ],
      tools: [
        {
          name: "edit_file",
          input_schema: { type: "object" },
          eager_input_streaming: true,
        },
        {
          name: "write_file",
          input_schema: { type: "object" },
          eager_input_streaming: true,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ] as unknown as AnthropicMessagesPayload["tools"],
    }

    prepareMessagesApiPayload(payload)

    for (const tool of payload.tools ?? []) {
      expect(tool).not.toHaveProperty("eager_input_streaming")
    }
    expect(payload.tools?.[1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
    expect(payload.cache_control).toBeUndefined()
  })
})
