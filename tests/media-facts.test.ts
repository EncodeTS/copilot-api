import { describe, expect, test } from "bun:test"

import {
  collectMediaFacts,
  iterateAnthropicCanonicalContent,
  MEDIA_FACT_MAX_DEPTH,
  MEDIA_FACT_MAX_FACTS,
  MEDIA_FACT_MAX_NODES,
} from "~/lib/media-facts"
import type {
  AnthropicFileSource,
  AnthropicMessagesPayload,
  AnthropicUserContentBlock,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionsPayload,
  FilePart,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponseInputFile,
  ResponseInputImage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  imageDataUrl,
  makePng,
  responsesImagePayload,
} from "./media-facts-fixtures"

const anthropicPayload = (
  content: Array<AnthropicUserContentBlock>,
): AnthropicMessagesPayload => {
  const payload = {
    max_tokens: 128,
    messages: [{ content, role: "user" }],
    model: "claude-test",
  } satisfies AnthropicMessagesPayload
  return payload
}

const malformedAnthropicPayload = (content: Array<unknown>): unknown => ({
  max_tokens: 128,
  messages: [{ content, role: "user" }],
  model: "claude-test",
})

describe("collectMediaFacts", () => {
  test("iterates only canonical Anthropic user content paths", () => {
    const payload: unknown = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              source: {
                data: "AQID",
                media_type: "image/png",
                type: "base64",
              },
              type: "image",
            },
            {
              content: [
                {
                  input: {
                    source: { data: "opaque", type: "base64" },
                    type: "image",
                  },
                  type: "tool_use",
                },
                {
                  source: {
                    content: [
                      {
                        source: {
                          data: "BAUG",
                          media_type: "image/png",
                          type: "base64",
                        },
                        type: "image",
                      },
                    ],
                    type: "content",
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
        {
          content: [
            {
              source: {
                data: "assistant-pseudo-media",
                media_type: "image/png",
                type: "base64",
              },
              type: "image",
            },
          ],
          role: "assistant",
        },
      ],
      model: "claude-test",
    }

    const imagePaths = [...iterateAnthropicCanonicalContent(payload)]
      .filter(
        (event) =>
          event.kind === "block"
          && typeof event.value === "object"
          && event.value !== null
          && "type" in event.value
          && event.value.type === "image",
      )
      .map((event) => event.path)

    expect(imagePaths).toEqual([
      ["messages", 0, "content", 0],
      ["messages", 0, "content", 1, "content", 1, "source", "content", 0],
    ])
  })

  test("keeps tool_use input opaque and never probes image data", () => {
    const source = {
      get data(): never {
        throw new Error("iterator must not probe image data")
      },
      media_type: "image/png",
      type: "base64",
    }
    const payload: unknown = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              source: {
                content: [{ source, type: "image" }],
                type: "content",
              },
              type: "document",
            },
            {
              content: [
                {
                  input: { image: { source, type: "image" } },
                  type: "tool_use",
                },
              ],
              tool_use_id: "tool_1",
              type: "tool_result",
            },
          ],
          role: "user",
        },
      ],
      model: "claude-test",
    }

    const events = [...iterateAnthropicCanonicalContent(payload)]

    expect(events.filter((event) => event.kind === "block")).toHaveLength(4)
    expect(events.every((event) => !event.path.includes("input"))).toBe(true)
  })

  test("canonical iterator is independent of the media-fact count cap", () => {
    const content = Array.from(
      { length: MEDIA_FACT_MAX_FACTS + 1 },
      (_, index) => ({ text: String(index), type: "text" }),
    )
    const payload: unknown = {
      max_tokens: 128,
      messages: [{ content, role: "user" }],
      model: "claude-test",
    }

    const blockCount = [...iterateAnthropicCanonicalContent(payload)].filter(
      (event) => event.kind === "block",
    ).length

    expect(blockCount).toBe(MEDIA_FACT_MAX_FACTS + 1)
  })

  test("only recognizes media at official protocol request and history paths", () => {
    const mediaShape = {
      source: {
        data: makePng(2, 2).toString("base64"),
        media_type: "image/png",
        type: "base64",
      },
      type: "image",
    }
    const anthropicRequest = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              id: "tool_1",
              input: mediaShape,
              name: "inspect",
              type: "tool_use",
            },
          ],
          role: "assistant",
        },
      ],
      model: "claude-test",
      tools: [{ input_schema: { example: mediaShape }, name: "inspect" }],
    } satisfies AnthropicMessagesPayload
    const anthropic = collectMediaFacts(anthropicRequest, {
      protocol: "anthropic",
    })
    const adversarialResponses: unknown = {
      input: [
        {
          arguments: mediaShape,
          call_id: "call_1",
          content: [
            {
              detail: "auto",
              image_url: imageDataUrl(makePng(1, 1), "image/png"),
              type: "input_image",
            },
          ],
          role: "user",
          type: "tool_search_call",
        },
        {
          content: [
            {
              input_audio: { data: "AQID", format: "mp3" },
              type: "input_audio",
            },
          ],
          role: "user",
          type: "message",
        },
      ],
    }
    const responses = collectMediaFacts(adversarialResponses, {
      protocol: "responses",
    })

    expect(anthropic.facts).toEqual([])
    expect(responses.facts).toEqual([])
    expect(
      collectMediaFacts(mediaShape, { protocol: "anthropic" }).facts,
    ).toEqual([])
  })

  test("recognizes official Responses content and history carriers", () => {
    const png = makePng(6, 5)
    const dataUrl = imageDataUrl(png, "image/png")
    const originalImage = {
      detail: "original",
      image_url: dataUrl,
      type: "input_image",
    } satisfies ResponseInputImage
    const inlineFile = {
      detail: "high",
      file_data: "data:application/pdf;base64,AQID",
      type: "input_file",
    } satisfies ResponseInputFile
    const payload = {
      input: [
        {
          content: [
            originalImage,
            inlineFile,
            {
              detail: "low",
              file_url: "https://example.test/report.pdf",
              type: "input_file",
            },
            { detail: "auto", file_id: "file_input", type: "input_file" },
          ],
          role: "user",
          type: "message",
        },
        {
          call_id: "computer_1",
          output: { image_url: dataUrl, type: "computer_screenshot" },
          type: "computer_call_output",
        },
        {
          call_id: "computer_2",
          output: { file_id: "file_screenshot", type: "computer_screenshot" },
          type: "computer_call_output",
        },
        {
          id: "ig_1",
          result: png.toString("base64"),
          status: "completed",
          type: "image_generation_call",
        },
        {
          code: "plot()",
          container_id: "container_1",
          id: "ci_1",
          outputs: [
            { logs: "done", type: "logs" },
            { type: "image", url: dataUrl },
          ],
          status: "completed",
          type: "code_interpreter_call",
        },
        {
          call_id: "call_1",
          output: [
            { detail: "low", file_id: "file_tool", type: "input_image" },
          ],
          type: "function_call_output",
        },
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload
    const result = collectMediaFacts(payload, { protocol: "responses" })

    expect(
      result.facts.map(({ carrier, detail, referenceKind }) => ({
        carrier,
        detail,
        referenceKind,
      })),
    ).toEqual([
      {
        carrier: "responses.input_image.image_url",
        detail: "original",
        referenceKind: "data-url",
      },
      {
        carrier: "responses.input_file.file_data",
        detail: "high",
        referenceKind: "data-url",
      },
      {
        carrier: "responses.input_file.file_url",
        detail: "low",
        referenceKind: "remote-url",
      },
      {
        carrier: "responses.input_file.file_id",
        detail: "auto",
        referenceKind: "file-id",
      },
      {
        carrier: "responses.computer_call_output.output.image_url",
        detail: undefined,
        referenceKind: "data-url",
      },
      {
        carrier: "responses.computer_call_output.output.file_id",
        detail: undefined,
        referenceKind: "file-id",
      },
      {
        carrier: "responses.image_generation_call.result",
        detail: undefined,
        referenceKind: "base64",
      },
      {
        carrier: "responses.code_interpreter_call.outputs.image.url",
        detail: undefined,
        referenceKind: "data-url",
      },
      {
        carrier: "responses.input_image.file_id",
        detail: "low",
        referenceKind: "file-id",
      },
    ])
    expect(result.warnings).toEqual([])
  })

  test("recognizes official Chat carriers with exactly-one file variants", () => {
    const fileDataPart = {
      file: {
        file_data: "data:application/pdf;base64,AQID",
      },
      type: "file",
    } satisfies FilePart
    const fileIdPart = {
      file: { file_id: "file_chat" },
      type: "file",
    } satisfies FilePart
    const payload = {
      messages: [
        {
          content: [
            {
              image_url: {
                detail: "low",
                url: "https://example.test/猫.png",
              },
              type: "image_url",
            },
            fileDataPart,
            fileIdPart,
            {
              input_audio: { data: "AQID", format: "wav" },
              type: "input_audio",
            },
          ],
          role: "user",
        },
        {
          audio: { id: "audio_history_1" },
          content: null,
          role: "assistant",
        },
      ],
      model: "gpt-test",
    } satisfies ChatCompletionsPayload
    const result = collectMediaFacts(payload, { protocol: "chat" })

    expect(
      result.facts.map(({ carrier, detail, referenceKind }) => ({
        carrier,
        detail,
        referenceKind,
      })),
    ).toEqual([
      {
        carrier: "chat.image_url.url",
        detail: "low",
        referenceKind: "remote-url",
      },
      {
        carrier: "chat.file.file_data",
        detail: undefined,
        referenceKind: "data-url",
      },
      {
        carrier: "chat.file.file_id",
        detail: undefined,
        referenceKind: "file-id",
      },
      {
        carrier: "chat.input_audio.data",
        detail: undefined,
        referenceKind: "base64",
      },
      {
        carrier: "chat.message.audio.id",
        detail: undefined,
        referenceKind: "audio-id",
      },
    ])
    expect(result.facts[0].encodedUtf8Bytes).toBe(28)
  })

  test("rejects malformed Chat file carrier XOR at runtime", () => {
    const adversarialPayload: unknown = {
      messages: [
        {
          content: [
            {
              file: {
                file_data: "data:application/pdf;base64,AQID",
                file_id: "file_both",
              },
              type: "file",
            },
            { file: {}, type: "file" },
            { file: { file_id: 42 }, type: "file" },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    }
    const result = collectMediaFacts(adversarialPayload, { protocol: "chat" })

    expect(result.facts).toEqual([])
    expect(result.warnings).toEqual(["invalid_container"])
  })

  test("enforces Chat media ownership by message role", () => {
    const pseudoImage = {
      image_url: { url: "https://example.test/pseudo.png" },
      type: "image_url",
    }
    const adversarialPayload: unknown = {
      messages: [
        { audio: { id: "audio_user" }, content: "text", role: "user" },
        { content: [pseudoImage], role: "assistant" },
        { content: [pseudoImage], role: "system" },
        { content: [pseudoImage], role: "tool", tool_call_id: "call_1" },
      ],
      model: "gpt-test",
    }
    const result = collectMediaFacts(adversarialPayload, { protocol: "chat" })

    expect(result.facts).toEqual([])
  })

  test("ignores Anthropic assistant pseudo-media and tool results", () => {
    const adversarialPayload: unknown = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              source: {
                data: makePng(1, 1).toString("base64"),
                media_type: "image/png",
                type: "base64",
              },
              type: "image",
            },
            {
              content: [
                {
                  source: {
                    data: "AQID",
                    media_type: "application/pdf",
                    type: "base64",
                  },
                  type: "document",
                },
              ],
              tool_use_id: "tool_1",
              type: "tool_result",
            },
          ],
          role: "assistant",
        },
      ],
      model: "claude-test",
    }
    const result = collectMediaFacts(adversarialPayload, {
      protocol: "anthropic",
    })

    expect(result.facts).toEqual([])
  })

  test("recognizes Anthropic image/document carriers and nested tool results", () => {
    const png = makePng(4, 3).toString("base64")
    const fileDocumentSource = {
      file_id: "file_anthropic",
      type: "file",
    } satisfies AnthropicFileSource
    const fileImageSource = {
      file_id: "file_image",
      type: "file",
    } satisfies AnthropicFileSource
    const result = collectMediaFacts(
      anthropicPayload([
        {
          source: { data: png, media_type: "image/png", type: "base64" },
          type: "image",
        },
        {
          source: { type: "url", url: "https://example.test/report.pdf" },
          type: "document",
        },
        {
          source: fileDocumentSource,
          type: "document",
        },
        {
          source: fileImageSource,
          type: "image",
        },
        {
          content: [
            {
              source: {
                data: "AQID",
                media_type: "application/pdf",
                type: "base64",
              },
              type: "document",
            },
          ],
          tool_use_id: "tool_1",
          type: "tool_result",
        },
      ]),
      { protocol: "anthropic" },
    )

    expect(result.facts.map((fact) => fact.carrier)).toEqual([
      "anthropic.image.source.data",
      "anthropic.document.source.url",
      "anthropic.document.source.file_id",
      "anthropic.image.source.file_id",
      "anthropic.document.source.data",
    ])
    expect(result.facts[4].path).toEqual([
      "messages",
      0,
      "content",
      4,
      "content",
      0,
      "source",
      "data",
    ])
  })

  test("treats canonical Anthropic text/content documents as containers", () => {
    const png = makePng(4, 3).toString("base64")
    const result = collectMediaFacts(
      anthropicPayload([
        {
          source: {
            data: '{"type":"image","source":{"type":"base64"}}',
            media_type: "text/plain",
            type: "text",
          },
          type: "document",
        },
        {
          source: {
            content: [
              { text: "caption", type: "text" },
              {
                source: {
                  data: png,
                  media_type: "image/png",
                  type: "base64",
                },
                type: "image",
              },
            ],
            type: "content",
          },
          type: "document",
        },
      ]),
      { protocol: "anthropic" },
    )

    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].carrier).toBe("anthropic.image.source.data")
    expect(result.facts[0].path).toEqual([
      "messages",
      0,
      "content",
      1,
      "source",
      "content",
      1,
      "source",
      "data",
    ])
  })

  test("ignores unsupported Anthropic audio and file_id discriminators", () => {
    const result = collectMediaFacts(
      malformedAnthropicPayload([
        {
          source: {
            data: "AQ==",
            media_type: "audio/wav",
            type: "base64",
          },
          type: "audio",
        },
        {
          source: { file_id: "file_untyped", type: "file_id" },
          type: "document",
        },
        {
          source: { file_id: "file_image_untyped", type: "file_id" },
          type: "image",
        },
      ]),
      { protocol: "anthropic" },
    )

    expect(result.facts).toEqual([])
  })

  test("measures Base64 padding and whitespace without a full decode", () => {
    const result = collectMediaFacts(
      anthropicPayload([
        {
          source: {
            data: "\nAQ ID BA==\r",
            media_type: "application/pdf",
            type: "base64",
          },
          type: "document",
        },
      ]),
      { protocol: "anthropic" },
    )

    expect(result.facts[0].base64).toEqual({
      alphabetCharacters: 6,
      decodedBytes: 4,
      encodedCharacters: 8,
      encodedUtf8Bytes: 12,
      invalidCharacters: 0,
      paddingCharacters: 2,
      valid: true,
      whitespaceCharacters: 4,
    })
  })

  test("decoded-length arithmetic matches Buffer for padded and unpadded data", () => {
    for (let length = 0; length <= 256; length += 1) {
      const bytes = Buffer.alloc(length)
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 29 + length * 11) % 256
      }
      const padded = bytes.toString("base64")
      const unpadded = padded.replaceAll(/=+$/gu, "")
      const spaced = unpadded.replaceAll(/.{1,7}/gu, "$& \n")
      for (const encoded of [padded, unpadded, spaced]) {
        const result = collectMediaFacts(
          anthropicPayload([
            {
              source: {
                data: encoded,
                media_type: "application/pdf",
                type: "base64",
              },
              type: "document",
            },
          ]),
          { protocol: "anthropic" },
        )
        expect(result.facts[0].base64?.decodedBytes).toBe(
          Buffer.from(encoded, "base64").byteLength,
        )
      }
    }
  })

  test("reports malformed Base64 and media references with safe codes", () => {
    const result = collectMediaFacts(
      {
        input: [
          {
            content: [
              {
                detail: "auto",
                image_url: "data:image/png;base64,AQ*=",
                type: "input_image",
              },
              {
                detail: "auto",
                image_url: "data:image/png,not-base64",
                type: "input_image",
              },
              {
                detail: "auto",
                image_url: "not a URL",
                type: "input_image",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
      },
      { protocol: "responses" },
    )

    expect(result.facts.map((fact) => fact.warnings)).toEqual([
      ["invalid_base64_alphabet"],
      ["unsupported_data_url_encoding"],
      ["invalid_media_reference"],
    ])
  })

  test("distinguishes malformed Base64 padding from length", () => {
    const result = collectMediaFacts(
      anthropicPayload(
        ["AQ=I", "A"].map((data) => ({
          source: {
            data,
            media_type: "application/pdf",
            type: "base64",
          },
          type: "document",
        })),
      ),
      { protocol: "anthropic" },
    )

    expect(result.facts.map((fact) => fact.warnings)).toEqual([
      ["invalid_base64_padding"],
      ["invalid_base64_length"],
    ])
    expect(
      result.facts.every((fact) => fact.base64?.decodedBytes === undefined),
    ).toBe(true)
  })

  test("keeps malformed official carriers observable without retaining values", () => {
    const responses = collectMediaFacts(
      {
        input: [
          {
            content: [{ detail: "auto", type: "input_image" }],
            role: "user",
            type: "message",
          },
        ],
      },
      { protocol: "responses" },
    )
    const chat = collectMediaFacts(
      {
        messages: [
          {
            content: [{ input_audio: {}, type: "input_audio" }],
            role: "user",
          },
        ],
        model: "gpt-test",
      },
      { protocol: "chat" },
    )
    const anthropic = collectMediaFacts(
      malformedAnthropicPayload([{ source: {}, type: "image" }]),
      { protocol: "anthropic" },
    )

    for (const result of [responses, chat, anthropic]) {
      expect(result.facts).toHaveLength(1)
      expect(result.facts[0].referenceKind).toBe("unknown")
      expect(result.facts[0].warnings).toEqual(["invalid_media_value"])
      expect(result.facts[0].encodedUtf8Bytes).toBe(0)
    }
  })

  test("canonicalizes MIME and emits content-free serializable facts", () => {
    const privateUrl = "https://private.example.test/image.png?sig=private"
    const privateId = "file_private"
    const base64 = makePng(3, 2).toString("base64")
    const result = collectMediaFacts(
      {
        input: [
          {
            content: [
              { detail: "auto", image_url: privateUrl, type: "input_image" },
              { file_id: privateId, type: "input_file" },
              {
                detail: "auto",
                image_url: `data:IMAGE/PNG;base64,${base64}`,
                type: "input_image",
              },
              {
                detail: "auto",
                image_url: `data:image/png\r\nprivate;base64,${base64}`,
                type: "input_image",
              },
              {
                file_data: "data:application/x-secret-token;base64,AQID",
                type: "input_file",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
      },
      { protocol: "responses" },
    )
    const serialized = JSON.stringify(result)

    expect(result.facts[2].mimeType).toBe("image/png")
    expect(result.facts[3].mimeType).toBeUndefined()
    expect(result.facts[3].warnings).toContain("invalid_mime_type")
    expect(result.facts[4].mimeType).toBeUndefined()
    expect(result.facts[4].warnings).toContain("unsupported_mime_type")
    expect(result.facts.every((fact) => fact.contentFree)).toBe(true)
    expect(serialized).not.toContain(privateUrl)
    expect(serialized).not.toContain(privateId)
    expect(serialized).not.toContain(base64)
    expect(serialized).not.toContain("private;base64")
    expect(serialized).not.toContain("application/x-secret-token")
  })

  test("returns a deeply frozen snapshot with process-wide limits", () => {
    const first = collectMediaFacts(
      responsesImagePayload(makePng(2, 2), "image/png"),
      { protocol: "responses" },
    )

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.limits)).toBe(true)
    expect(Object.isFrozen(first.facts)).toBe(true)
    expect(Object.isFrozen(first.facts[0])).toBe(true)
    expect(Object.isFrozen(first.facts[0].path)).toBe(true)
    expect(() => {
      ;(first.limits as { maxNodes: number }).maxNodes = 1
    }).toThrow()

    const second = collectMediaFacts({ input: [] }, { protocol: "responses" })
    expect(second.limits.maxNodes).toBe(MEDIA_FACT_MAX_NODES)
  })

  test("applies fact and node caps with observable collection warnings", () => {
    const mediaBlocks = Array.from(
      { length: MEDIA_FACT_MAX_FACTS + 1 },
      (_, index) => ({
        detail: "auto",
        image_url: `https://example.test/${index}.png`,
        type: "input_image",
      }),
    )
    const factLimited = collectMediaFacts(
      {
        input: [
          {
            content: mediaBlocks,
            role: "user",
            type: "message",
          },
        ],
      },
      { protocol: "responses" },
    )
    const nodeLimited = collectMediaFacts(
      {
        input: Array.from(
          { length: Math.ceil(MEDIA_FACT_MAX_NODES / 2) + 1 },
          () => ({ content: [], role: "user", type: "message" }),
        ),
      },
      { protocol: "responses" },
    )

    expect(factLimited.facts).toHaveLength(MEDIA_FACT_MAX_FACTS)
    expect(factLimited.warnings).toEqual(["max_facts_exceeded"])
    expect(factLimited.stats.truncated).toBe(true)
    expect(nodeLimited.warnings).toEqual(["max_nodes_exceeded"])
    expect(nodeLimited.stats.nodesVisited).toBe(MEDIA_FACT_MAX_NODES)
    expect(factLimited.limits).toEqual({
      maxDepth: MEDIA_FACT_MAX_DEPTH,
      maxFacts: MEDIA_FACT_MAX_FACTS,
      maxNodes: MEDIA_FACT_MAX_NODES,
    })
  })

  test("reports cycles without recursively guessing nested protocol shapes", () => {
    const input: Array<unknown> = []
    const cyclicPayload: Record<string, unknown> = { input }
    input.push(cyclicPayload)
    const cyclic = collectMediaFacts(cyclicPayload, { protocol: "responses" })

    expect(cyclic.warnings).toEqual(["cycle_detected"])
    expect(cyclic.limits.maxDepth).toBe(MEDIA_FACT_MAX_DEPTH)
  })

  test("counts primitive array work and stops a million-entry payload early", () => {
    const content = new Array<unknown>(1_000_000).fill(null)
    content.fill("text", 500_000)
    const result = collectMediaFacts(
      { input: [{ content, role: "user", type: "message" }] },
      { protocol: "responses" },
    )

    expect(result.facts).toEqual([])
    expect(result.warnings).toEqual(["max_nodes_exceeded"])
    expect(result.stats.nodesVisited).toBe(MEDIA_FACT_MAX_NODES)
  })

  test("reports malformed Anthropic containers without fabricating media", () => {
    const result = collectMediaFacts(
      malformedAnthropicPayload([
        { source: { content: 42, type: "content" }, type: "document" },
        { source: { content: [null], type: "content" }, type: "document" },
        {
          source: { media_type: "text/plain", type: "text" },
          type: "document",
        },
      ]),
      { protocol: "anthropic" },
    )

    expect(result.facts).toEqual([])
    expect(result.warnings).toEqual(["invalid_container"])
  })

  test("rejects noncanonical Anthropic container MIME and nested traffic", () => {
    const adversarialPayload: unknown = {
      max_tokens: 128,
      messages: [
        {
          content: [
            {
              source: {
                data: "markdown",
                media_type: "text/markdown",
                type: "text",
              },
              type: "document",
            },
            {
              source: {
                content: [
                  {
                    source: {
                      data: "AQID",
                      media_type: "application/pdf",
                      type: "base64",
                    },
                    type: "document",
                  },
                  {
                    content: [],
                    tool_use_id: "tool_1",
                    type: "tool_result",
                  },
                ],
                type: "content",
              },
              type: "document",
            },
          ],
          role: "user",
        },
      ],
      model: "claude-test",
    }
    const result = collectMediaFacts(adversarialPayload, {
      protocol: "anthropic",
    })

    expect(result.facts).toEqual([])
    expect(result.warnings).toEqual(["invalid_container"])
  })

  test("counts shared media records once per serialized path", () => {
    const shared = {
      detail: "auto",
      image_url: "https://example.test/shared.png",
      type: "input_image",
    }
    const result = collectMediaFacts(
      {
        input: [{ content: [shared, shared], role: "user", type: "message" }],
      },
      { protocol: "responses" },
    )

    expect(result.facts.map((fact) => fact.path)).toEqual([
      ["input", 0, "content", 0, "image_url"],
      ["input", 0, "content", 1, "image_url"],
    ])
    expect(result.warnings).toEqual([])
  })
})
