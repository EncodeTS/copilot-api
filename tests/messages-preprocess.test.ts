import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  prepareMessagesApiPayload,
  stripToolReferenceTurnBoundary,
} from "../src/routes/messages/preprocess"

describe("stripToolReferenceTurnBoundary", () => {
  test("removes Tool loaded text when the message has tool_reference", () => {
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
              content: [
                {
                  type: "tool_reference",
                  tool_name: "AskUserQuestion",
                },
              ],
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            {
              type: "tool_reference",
              tool_name: "AskUserQuestion",
            },
          ],
        },
      ],
    })
  })

  test("keeps Tool loaded text when the message has no tool_reference", () => {
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
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Tool loaded.",
            },
          ],
        },
      ],
    }

    stripToolReferenceTurnBoundary(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo",
        },
        {
          type: "text",
          text: "Tool loaded.",
        },
      ],
    })
  })
})

describe("prepareMessagesApiPayload", () => {
  describe("preprocessing", () => {
    test("strips cache_control scope and filters thinking blocks", () => {
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
      expect(payload.thinking).toEqual({ type: "adaptive" })
      expect(payload.output_config).toEqual({ effort: "high" })
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
  }) // end preprocessing
})

describe("prepareMessagesApiPayload thinking and effort", () => {
  test("deletes temperature when adaptive thinking is injected", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      temperature: 0.7,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.temperature).toBeUndefined()
  })

  test("preserves client effort when provided", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "low" },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.output_config).toEqual({ effort: "low" })
  })

  test("defaults effort to high when client does not provide it", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.output_config).toEqual({ effort: "high" })
  })

  test("preserves output_config.format when injecting effort", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    }
    const payload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user" as const, content: "hello" }],
      output_config: {
        effort: "low" as const,
        format: { type: "json_schema", schema },
      },
    } as AnthropicMessagesPayload

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const config = payload.output_config as Record<string, unknown>
    expect(config.effort).toBe("low")
    expect(config.format).toEqual({ type: "json_schema", schema })
  })

  test("preserves client thinking when already set to adaptive with display", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "adaptive", display: "omitted" },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({ type: "adaptive", display: "omitted" })
  })

  test("preserves client thinking when set to enabled with budget_tokens", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 4096,
      temperature: 1,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled", budget_tokens: 2048 },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
    expect(payload.temperature).toBeUndefined()
    expect(payload.output_config).toEqual({ effort: "high" })
  })

  test("preserves client thinking when set to disabled", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      temperature: 0.5,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toEqual({ type: "disabled" })
    expect(payload.temperature).toBe(0.5)
    expect(payload.output_config).toBeUndefined()
  })
})
