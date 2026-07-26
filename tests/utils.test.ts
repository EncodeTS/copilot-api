import type { Context } from "hono"

import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { getRootSessionId, getUUID } from "../src/lib/utils"

const jsonStyleUserId = JSON.stringify({
  device_id: "3f4a1b7c8d9e0f1234567890abcdef1234567890abcdef1234567890abcdef12",
  account_uuid: "",
  session_id: "2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752",
})

const legacyStyleUserId =
  "user_8b7e2c1d4f6a9b3c0d1e2f3456789abcdeffedcba9876543210fedcba1234567_account__session_7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b"

const getLegacyUUID = (content: string): string => {
  const hash32 = createHash("sha256").update(content).digest("hex").slice(0, 32)
  return `${hash32.slice(0, 8)}-${hash32.slice(8, 12)}-${hash32.slice(12, 16)}-${hash32.slice(16, 20)}-${hash32.slice(20)}`
}

test("getUUID returns a deterministic standards-compliant UUIDv4", () => {
  const uuid = getUUID("hello world")

  expect(uuid).toBe("b94d27b9-934d-4e08-a52e-52d7da7dabfa")
  expect(uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(getUUID("hello world")).toBe(uuid)
  expect(getUUID("hello world!")).not.toBe(uuid)
})

test("prints randomUUID and deterministic UUID for comparison", () => {
  const input = "hello world"
  const random = randomUUID()
  const legacy = getLegacyUUID(input)
  const derived = getUUID(input)
  const derivedAgain = getUUID(input)

  console.info(`randomUUID(): ${random}`)
  console.info(`legacy getUUID(${JSON.stringify(input)}): ${legacy}`)
  console.info(`getUUID(${JSON.stringify(input)}): ${derived}`)
  console.info(`getUUID(${JSON.stringify(input)}) again: ${derivedAgain}`)

  expect(random).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(derived).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(legacy).toBe("b94d27b9-934d-3e08-a52e-52d7da7dabfa")
  expect(derived).toBe("b94d27b9-934d-4e08-a52e-52d7da7dabfa")
  expect(derivedAgain).toBe(derived)
  expect(legacy).not.toBe(derived)
  expect(random).not.toBe(derived)
})

test("generateRequestIdFromPayload ignores raw media fields when deriving stable IDs", async () => {
  const { state } = await import("../src/lib/state")
  const { generateRequestIdFromPayload } = await import("../src/lib/utils")
  const originalMachineId = state.macMachineId

  state.macMachineId = "machine-1"
  try {
    const first = generateRequestIdFromPayload(
      {
        messages: [
          {
            content: [
              { text: "compare this screenshot", type: "text" },
              {
                source: {
                  data: "first-secret-base64",
                  media_type: "image/png",
                  type: "base64",
                },
                type: "image",
              },
              {
                image_url: {
                  url: "data:image/png;base64,AAAA",
                },
                type: "image_url",
              },
              {
                file_id: "file_first_secret",
                type: "input_file",
              },
            ],
            role: "user",
          },
        ],
      },
      "session-1",
    )
    const second = generateRequestIdFromPayload(
      {
        messages: [
          {
            content: [
              { text: "compare this screenshot", type: "text" },
              {
                source: {
                  data: "second-secret-base64",
                  media_type: "image/png",
                  type: "base64",
                },
                type: "image",
              },
              {
                image_url: {
                  url: "data:image/png;base64,BBBB",
                },
                type: "image_url",
              },
              {
                file_id: "file_second_secret",
                type: "input_file",
              },
            ],
            role: "user",
          },
        ],
      },
      "session-1",
    )

    expect(second).toBe(first)
  } finally {
    state.macMachineId = originalMachineId
  }
})

test("getRootSessionId supports JSON-like user_id metadata", () => {
  const anthropicPayload = {
    model: "claude-3-5-sonnet",
    messages: [],
    max_tokens: 0,
    metadata: {
      user_id: jsonStyleUserId,
    },
  } as AnthropicMessagesPayload
  const context = {
    req: {
      header: (_name: string) => undefined,
    },
  } as unknown as Context

  expect(getRootSessionId(anthropicPayload, context)).toBe(
    getUUID("2c4e1cf0-7a67-4d2e-9a4b-1d16d3f44752"),
  )
})

test("getRootSessionId keeps legacy parsing before JSON fallback", () => {
  const anthropicPayload = {
    model: "claude-3-5-sonnet",
    messages: [],
    max_tokens: 0,
    metadata: {
      user_id: legacyStyleUserId,
    },
  } as AnthropicMessagesPayload
  const context = {
    req: {
      header: (_name: string) => undefined,
    },
  } as unknown as Context

  expect(getRootSessionId(anthropicPayload, context)).toBe(
    getUUID("7d0e2f61-4b5c-4a9d-8f11-2c3d4e5f6a7b"),
  )
})

test("splitting request identity extraction preserves the generated ID", async () => {
  const { state } = await import("../src/lib/state")
  const {
    extractRequestIdentityContent,
    generateRequestIdFromContent,
    generateRequestIdFromPayload,
  } = await import("../src/lib/utils")
  const originalMachineId = state.macMachineId

  state.macMachineId = "machine-1"
  try {
    // Ticket 06 replaced a whole-payload deep copy with the extracted identity
    // string. The two must stay observationally identical for every shape that
    // reaches a request ID, including the ones that fall back to a random UUID.
    const payloads: Array<{
      messages: AnthropicMessagesPayload["messages"] | string | undefined
    }> = [
      { messages: [{ content: "hello", role: "user" }] },
      {
        messages: [
          { content: "hello", role: "user" },
          { content: "hi", role: "assistant" },
          { content: [{ text: "second turn", type: "text" }], role: "user" },
        ],
      },
      {
        messages: [
          {
            content: [
              { content: "result", tool_use_id: "t1", type: "tool_result" },
            ],
            role: "user",
          },
        ],
      },
      { messages: [{ content: "", role: "user" }] },
      { messages: [{ content: "only assistant", role: "assistant" }] },
      { messages: [] },
      { messages: undefined },
    ]

    for (const payload of payloads) {
      const typed = payload as Parameters<
        typeof generateRequestIdFromPayload
      >[0]
      const viaContent = generateRequestIdFromContent(
        extractRequestIdentityContent(typed),
        "session-1",
      )
      const viaPayload = generateRequestIdFromPayload(typed, "session-1")
      const identityContent = extractRequestIdentityContent(typed)

      if (identityContent) {
        expect(viaContent).toBe(viaPayload)
      } else {
        // Both sides fall back to a fresh random UUID, so only the fallback
        // decision itself can be asserted.
        expect(viaContent).not.toBe(viaPayload)
      }
    }
  } finally {
    state.macMachineId = originalMachineId
  }
})

test("request identity content is stable across unrelated payload mutation", async () => {
  const { extractRequestIdentityContent } = await import("../src/lib/utils")

  const payload = {
    max_tokens: 16,
    messages: [{ content: "pin this", role: "user" as const }],
    model: "alias",
  }
  const pinned = extractRequestIdentityContent(payload)

  // preparePlan pins identity and then rewrites `model`; the pinned value must
  // not move with it, which is what the discarded deep copy used to guarantee.
  payload.model = "resolved-endpoint-model"

  expect(extractRequestIdentityContent(payload)).toBe(pinned)
  expect(pinned).toBe("pin this")
})
