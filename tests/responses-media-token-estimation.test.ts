import { afterEach, expect, mock, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"
import type { Model } from "../src/services/copilot/get-models"
import {
  estimateResponsesInputTokens,
  estimateResponsesInputTokensDetailed,
  ResponsesTokenEstimateLimitError,
  responsesTokenEstimateDependencies,
} from "../src/routes/messages/prepared-messages/token-estimation"
import { makePng } from "./media-facts-fixtures"

const model = {
  id: "gpt-5.6-sol",
  capabilities: {
    family: "gpt-5.6",
    limits: { max_prompt_tokens: 372_000 },
    object: "model_capabilities",
    supports: { vision: true },
    tokenizer: "o200k_base",
    type: "chat",
  },
  model_picker_enabled: true,
  name: "GPT-5.6 Sol",
  object: "model",
  vendor: "OpenAI",
  version: "5.6",
  supported_endpoints: ["/responses"],
} satisfies Model

const originalDependencies = { ...responsesTokenEstimateDependencies }

afterEach(() => {
  Object.assign(responsesTokenEstimateDependencies, originalDependencies)
})

const imageDataUrl = (width: number, height: number): string => {
  return `data:image/png;base64,${makePng(width, height).toString("base64")}`
}

test("Responses count batches only semantic text and never tokenizes media carriers", async () => {
  const privateCarrier = Buffer.from("private-media-carrier").toString("base64")
  const dataUrl = `data:image/png;base64,${privateCarrier}`
  const fileId = "file_private_media"
  const remoteUrl = "https://private.example.test/media.png?secret=yes"
  const batches: Array<Array<string>> = []
  responsesTokenEstimateDependencies.countTexts = mock(
    (texts: Array<string>) => {
      batches.push([...texts])
      return Promise.resolve(texts.map((text) => (text.length > 0 ? 1 : 0)))
    },
  )
  const payload = {
    instructions: "visible instructions",
    input: [
      {
        role: "user",
        type: "message",
        content: [
          { type: "input_text", text: "visible input text" },
          { type: "input_image", detail: "high", image_url: dataUrl },
          { type: "input_image", detail: "low", file_id: fileId },
          {
            type: "input_file",
            filename: "bounded-visible.pdf",
            file_url: remoteUrl,
          },
        ],
      },
    ],
    metadata: { trace_name: "bounded metadata" },
    model: model.id,
    text: {
      format: {
        type: "json_schema",
        name: "visible_schema",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
        },
      },
    },
    tools: [
      {
        type: "function",
        name: "visible_tool",
        description: "visible tool description",
        strict: true,
        parameters: { type: "object", properties: {} },
      },
    ],
  } satisfies ResponsesPayload
  const snapshot = structuredClone(payload)

  const estimate = await estimateResponsesInputTokens(payload, model)

  expect(estimate).toBeGreaterThan(0)
  expect(batches).toHaveLength(1)
  const tokenizerInput = batches[0].join("\n")
  expect(tokenizerInput).toContain("visible instructions")
  expect(tokenizerInput).toContain("visible input text")
  expect(tokenizerInput).toContain("bounded-visible.pdf")
  expect(tokenizerInput).toContain("visible_schema")
  expect(tokenizerInput).toContain("visible_tool")
  expect(tokenizerInput).toContain("bounded metadata")
  expect(tokenizerInput).not.toContain(privateCarrier)
  expect(tokenizerInput).not.toContain(dataUrl)
  expect(tokenizerInput).not.toContain(fileId)
  expect(tokenizerInput).not.toContain(remoteUrl)
  expect(payload).toEqual(snapshot)
})

test("Responses count gives unknown and malformed media a bounded non-zero estimate", async () => {
  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])

  const malformed = await estimateResponsesInputTokensDetailed(
    {
      model: model.id,
      input: [
        {
          role: "user",
          type: "message",
          content: [{ type: "input_image", detail: "auto" }],
        },
        {
          role: "user",
          type: "message",
          content: [
            {
              type: "future_media",
              blob: "private-unknown-carrier-must-stay-opaque",
            },
          ],
        },
      ],
    },
    model,
  )

  expect(malformed.breakdown.media.unknownItems).toBe(2)
  expect(malformed.breakdown.media.tokens).toBeGreaterThan(0)
  expect(malformed.breakdown.media.tokens).toBeLessThanOrEqual(8_192)
  expect(malformed.inputTokens).toBeGreaterThan(0)
})

test("Responses image estimates are monotonic for count, dimensions, and low-to-high detail", async () => {
  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])
  const estimate = (images: Array<{ detail: "low" | "high"; url: string }>) =>
    estimateResponsesInputTokens(
      {
        model: model.id,
        input: [
          {
            role: "user",
            type: "message",
            content: images.map(({ detail, url }) => ({
              detail,
              image_url: url,
              type: "input_image" as const,
            })),
          },
        ],
      },
      model,
    )

  const smallLow = await estimate([
    { detail: "low", url: imageDataUrl(64, 64) },
  ])
  const smallHigh = await estimate([
    { detail: "high", url: imageDataUrl(64, 64) },
  ])
  const largeHigh = await estimate([
    { detail: "high", url: imageDataUrl(1_024, 1_024) },
  ])
  const twoLargeHigh = await estimate([
    { detail: "high", url: imageDataUrl(1_024, 1_024) },
    { detail: "high", url: imageDataUrl(1_024, 1_024) },
  ])

  expect(smallHigh).toBeGreaterThan(smallLow)
  expect(largeHigh).toBeGreaterThanOrEqual(smallHigh)
  expect(twoLargeHigh).toBeGreaterThan(largeHigh)
})

test("GPT-5.6 auto, original, and omitted detail use the official 32px patch profile", async () => {
  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])
  const estimate = (detail?: "auto" | "original") =>
    estimateResponsesInputTokensDetailed(
      {
        model: model.id,
        input: [
          {
            role: "user",
            type: "message",
            content: [
              {
                type: "input_image",
                ...(detail ? { detail } : {}),
                image_url: imageDataUrl(1_024, 1_024),
              },
            ],
          },
        ],
      },
      model,
    )

  const auto = await estimate("auto")
  const original = await estimate("original")
  const omitted = await estimate()

  expect(auto.breakdown.media.tokens).toBe(1_024)
  expect(original.breakdown.media.tokens).toBe(1_024)
  expect(omitted.breakdown.media.tokens).toBe(1_024)
})

test("Responses file detail uses a versioned bounded profile with a conservative PDF floor", async () => {
  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])
  const estimate = (detail?: "auto" | "high" | "low") =>
    estimateResponsesInputTokensDetailed(
      {
        model: model.id,
        input: [
          {
            role: "user",
            type: "message",
            content: [
              {
                type: "input_file",
                ...(detail ? { detail } : {}),
                file_data: "data:application/pdf;base64,AQID",
              },
            ],
          },
        ],
      },
      model,
    )

  const low = await estimate("low")
  const auto = await estimate("auto")
  const high = await estimate("high")
  const omitted = await estimate()

  expect(low.breakdown.media.tokens).toBeGreaterThanOrEqual(2_048)
  expect(auto.breakdown.media.tokens).toBeGreaterThanOrEqual(
    low.breakdown.media.tokens,
  )
  expect(high.breakdown.media.tokens).toBeGreaterThanOrEqual(
    auto.breakdown.media.tokens,
  )
  expect(omitted.breakdown.media.tokens).toBeGreaterThanOrEqual(
    high.breakdown.media.tokens,
  )
  expect(low.breakdown.profile.fileVersion).toBe(
    "2026-07-21/responses-file-detail/v1",
  )
})

test("Responses count fails closed when 1500 media carriers truncate MediaFacts", () => {
  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])
  const content = Array.from({ length: 1_500 }, (_, index) => ({
    type: "input_image" as const,
    detail: "low" as const,
    file_id: `file_${index}`,
  }))

  expect(
    estimateResponsesInputTokens(
      {
        model: model.id,
        input: [{ role: "user", type: "message", content }],
      },
      model,
    ),
  ).rejects.toBeInstanceOf(ResponsesTokenEstimateLimitError)
})

test("Responses media breakdown is versioned, content-free, and remains internal to the numeric seam", async () => {
  responsesTokenEstimateDependencies.countTexts = (texts) =>
    Promise.resolve(texts.map(() => 1))

  const result = await estimateResponsesInputTokensDetailed(
    {
      model: "copilot-private-alias",
      input: [
        {
          role: "user",
          type: "message",
          content: [
            {
              type: "input_image",
              detail: "auto",
              file_id: "file_private",
            },
          ],
        },
      ],
    },
    { ...model, id: "copilot-private-alias" },
  )

  expect(result.breakdown.profile.version).toMatch(/^2026-07-21\//)
  expect(result.breakdown.profile.mapping).toBe("copilot-unverified")
  expect(result.breakdown.media.facts).toBe(1)
  expect(JSON.stringify(result.breakdown)).not.toContain("file_private")
  expect(
    await estimateResponsesInputTokens(
      {
        model: "copilot-private-alias",
        input: [
          {
            role: "user",
            type: "message",
            content: [
              {
                type: "input_image",
                detail: "auto",
                file_id: "file_private",
              },
            ],
          },
        ],
      },
      { ...model, id: "copilot-private-alias" },
    ),
  ).toBe(result.inputTokens)
})

test("Responses semantic traversal covers typed history while opaque carriers stay out of the worker", async () => {
  const captured: Array<string> = []
  responsesTokenEstimateDependencies.countTexts = (texts) => {
    captured.push(...texts)
    return Promise.resolve(texts.map(() => 1))
  }
  const privateValues = [
    "opaque-reasoning-private",
    "opaque-compaction-private",
    "data:image/png;base64,PRIVATE_TOOL_IMAGE",
    "data:image/png;base64,PRIVATE_SCREENSHOT",
    "PRIVATE_GENERATED_IMAGE",
    "data:image/png;base64,PRIVATE_CODE_IMAGE",
  ]

  const result = await estimateResponsesInputTokensDetailed(
    {
      model: model.id,
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "visible_function",
          arguments: '{"visible_argument":true}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "output_text", text: "visible function output" },
            {
              type: "input_image",
              detail: "low",
              image_url: privateValues[2],
            },
          ],
        },
        {
          type: "tool_search_call",
          call_id: "search_1",
          arguments: "visible search arguments",
        },
        {
          type: "tool_search_call",
          call_id: "search_2",
          arguments: { visible_query: "schema search value" },
        },
        {
          type: "tool_search_output",
          call_id: "search_1",
          tools: [
            {
              type: "function",
              name: "visible_discovered_tool",
              strict: true,
              parameters: null,
            },
          ],
        },
        {
          type: "reasoning",
          encrypted_content: privateValues[0],
          summary: [{ type: "summary_text", text: "visible summary" }],
        },
        {
          id: "compaction_1",
          type: "compaction",
          encrypted_content: privateValues[1],
        },
        { type: "compaction_trigger" },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "visible_additional_tool",
              strict: true,
              parameters: { type: "object" },
            },
          ],
        },
        {
          type: "computer_call_output",
          call_id: "computer_1",
          output: {
            type: "computer_screenshot",
            image_url: privateValues[3],
          },
        },
        {
          id: "generated_1",
          type: "image_generation_call",
          result: privateValues[4],
          status: "completed",
        },
        {
          id: "code_1",
          type: "code_interpreter_call",
          code: "visible_code()",
          container_id: "container_1",
          outputs: [
            { type: "logs", logs: "visible logs" },
            { type: "image", url: privateValues[5] },
          ],
          status: "completed",
        },
        { type: "future_history_media", opaque: "PRIVATE_FUTURE" },
      ],
    },
    model,
  )

  const tokenizerInput = captured.join("\n")
  for (const visible of [
    "visible_function",
    "visible_argument",
    "visible function output",
    "visible search arguments",
    "schema search value",
    "visible_discovered_tool",
    "visible summary",
    "visible_additional_tool",
    "visible_code()",
    "visible logs",
  ]) {
    expect(tokenizerInput).toContain(visible)
  }
  for (const privateValue of privateValues) {
    expect(tokenizerInput).not.toContain(privateValue)
  }
  expect(tokenizerInput).not.toContain("PRIVATE_FUTURE")
  expect(result.breakdown.media.facts).toBe(4)
  expect(result.breakdown.media.unknownItems).toBeGreaterThanOrEqual(1)
})

test("Responses profiles cover original/scaled images and bounded file estimates", async () => {
  responsesTokenEstimateDependencies.countTexts = (texts) =>
    Promise.resolve(texts.map(() => 0))
  const detailed = (payload: ResponsesPayload, selectedModel = model) =>
    estimateResponsesInputTokensDetailed(payload, selectedModel)
  const imagePayload = (detail: "high" | "original"): ResponsesPayload => ({
    model: model.id,
    input: [
      {
        role: "user",
        type: "message",
        content: [
          {
            type: "input_image",
            detail,
            image_url: imageDataUrl(4_096, 2_048),
          },
        ],
      },
    ],
  })
  const originalImage = imagePayload("original")
  const highImage = imagePayload("high")
  const files = {
    model: model.id,
    input: [
      {
        role: "user",
        type: "message",
        content: [
          {
            type: "input_file",
            filename: "known.pdf",
            file_data: "data:application/pdf;base64,AQID",
          },
          { type: "input_file", file_id: "file_unknown" },
        ],
      },
    ],
  } satisfies ResponsesPayload

  const original = await detailed(originalImage)
  const high = await detailed(highImage)
  const conservative = await detailed(originalImage, {
    ...model,
    id: "private-alias",
    capabilities: { ...model.capabilities, family: "private-family" },
  })
  const fileEstimate = await detailed(files)

  expect(original.breakdown.media.tokens).toBeGreaterThan(0)
  expect(high.breakdown.media.tokens).toBeGreaterThan(0)
  expect(conservative.breakdown.profile.name).toBe("responses-conservative")
  expect(fileEstimate.breakdown.media.fileItems).toBe(2)
  expect(fileEstimate.breakdown.media.tokens).toBeGreaterThan(0)
  expect(fileEstimate.breakdown.media.tokens).toBeLessThanOrEqual(65_536)
})

test("Responses traversal preserves depth/cycle limits and validates worker results", () => {
  const cyclic: Record<string, unknown> = { type: "object" }
  cyclic.self = cyclic
  expect(
    estimateResponsesInputTokens(
      { model: model.id, tools: [{ type: "function", schema: cyclic }] },
      model,
    ),
  ).rejects.toBeInstanceOf(ResponsesTokenEstimateLimitError)

  let nested: Record<string, unknown> = { type: "string" }
  for (let depth = 0; depth < 130; depth += 1) nested = { nested }
  expect(
    estimateResponsesInputTokens(
      {
        model: model.id,
        text: {
          format: {
            type: "json_schema",
            name: "deep",
            strict: true,
            schema: nested,
          },
        },
      },
      model,
    ),
  ).rejects.toBeInstanceOf(ResponsesTokenEstimateLimitError)

  responsesTokenEstimateDependencies.countTexts = () => Promise.resolve([])
  expect(
    estimateResponsesInputTokens({ model: model.id, input: "visible" }, model),
  ).rejects.toBeInstanceOf(TypeError)
})

test("Responses count bounds metadata and falls back to the supported tokenizer", async () => {
  let encoding = ""
  let texts: Array<string> = []
  responsesTokenEstimateDependencies.countTexts = (
    batch: Array<string>,
    selectedEncoding: string,
  ) => {
    encoding = selectedEncoding
    texts = batch
    return Promise.resolve(batch.map(() => 1))
  }
  const longKey = "k".repeat(100)
  const longValue = "v".repeat(1_000)
  const metadata: Record<string, string> = { [longKey]: longValue }
  for (let index = 0; index < 20; index += 1) {
    metadata[`key_${index}`] = `value_${index}`
  }

  await estimateResponsesInputTokens(
    {
      model: model.id,
      input: "",
      metadata,
    },
    {
      ...model,
      capabilities: { ...model.capabilities, tokenizer: "unknown_encoding" },
    },
  )

  expect(encoding).toBe("o200k_base")
  expect(texts).toContain("k".repeat(64))
  expect(texts).toContain("v".repeat(512))
  expect(texts).not.toContain("key_19")
})
