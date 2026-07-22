import { expect, test } from "bun:test"

import {
  CHAT_MEDIA_TOKEN_PROFILE,
  estimateChatMediaTokens,
  estimateMediaFactTokens,
} from "~/lib/media-token-estimation"
import type { MediaFact } from "~/lib/media-facts"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { imageDataUrl, makePng } from "./media-facts-fixtures"

const UNKNOWN_MEDIA_TOKENS = 32_768

test("Chat media profile counts canonical media without using carrier text", () => {
  const payload = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl(makePng(56, 84), "image/png"),
            },
          },
          {
            type: "image_url",
            image_url: { url: "https://private.example.test/image.png" },
          },
          {
            type: "file",
            file: {
              file_data: "data:application/pdf;base64,QUJD",
              filename: "three-bytes.pdf",
            },
          },
          {
            type: "file",
            file: { file_id: "file_private", filename: "stored.pdf" },
          },
          {
            type: "input_audio",
            input_audio: { data: "QUJD", format: "wav" },
          },
        ],
      },
      {
        role: "assistant",
        content: "done",
        audio: { id: "audio_private" },
      },
    ],
    model: "gpt-5",
  } satisfies ChatCompletionsPayload

  expect(estimateChatMediaTokens(payload)).toEqual({
    input: 7 + UNKNOWN_MEDIA_TOKENS * 3,
    output: UNKNOWN_MEDIA_TOKENS,
    profile: CHAT_MEDIA_TOKEN_PROFILE,
  })
})

test("Chat media profile uses bounded fallbacks for malformed and oversized media", () => {
  const malformed = estimateChatMediaTokens({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { file_data: "invalid", file_id: "also-invalid" },
          },
          { type: "image_url", image_url: { url: 42 } },
        ],
      },
    ],
    model: "gpt-5",
  } as unknown as ChatCompletionsPayload)
  const oversized = estimateChatMediaTokens({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl(makePng(10_000, 10_000), "image/png"),
            },
          },
          {
            type: "file",
            file: {
              file_data: `data:application/pdf;base64,${Buffer.alloc(128 * 1024).toString("base64")}`,
            },
          },
        ],
      },
    ],
    model: "gpt-5",
  })

  expect(malformed.input).toBe(UNKNOWN_MEDIA_TOKENS * 2)
  expect(oversized.input).toBe(UNKNOWN_MEDIA_TOKENS * 2)
})

test("generic media facts fail conservatively when file size is unavailable", () => {
  const fact = {
    carrier: "chat.file.file_id",
    contentFree: true,
    encodedUtf8Bytes: 0,
    mediaKind: "file",
    path: ["messages", 0, "content", 0, "file", "file_id"],
    protocol: "chat",
    referenceKind: "file-id",
    warnings: [],
  } satisfies MediaFact

  expect(estimateMediaFactTokens(fact)).toBe(UNKNOWN_MEDIA_TOKENS)
})

test("malformed assistant audio receives bounded non-zero output estimates", () => {
  const estimate = estimateChatMediaTokens({
    messages: [
      { audio: "PRIVATE_AUDIO", content: "one", role: "assistant" },
      { audio: { id: 42 }, content: "two", role: "assistant" },
      { audio: null, content: "no carrier", role: "assistant" },
    ],
    model: "gpt-5",
  } as unknown as ChatCompletionsPayload)

  expect(estimate).toEqual({
    input: 0,
    output: UNKNOWN_MEDIA_TOKENS * 2,
    profile: CHAT_MEDIA_TOKEN_PROFILE,
  })
})
