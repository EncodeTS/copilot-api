import { describe, expect, test } from "bun:test"

import type { ResponseOutputItem } from "~/services/copilot/create-responses"

import {
  decodeWebSearchHistoryCarrier,
  encodeWebSearchHistoryCarrier,
  getWebSearchHistoryCarrierLogFields,
  validateWebSearchHistoryCarrierPayload,
  WebSearchHistoryCarrierValidationError,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
  WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH,
  WEB_SEARCH_HISTORY_MAX_DECODED_BYTES,
  WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS,
  WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS,
  WEB_SEARCH_HISTORY_MAX_TOTAL_NODES,
  WEB_SEARCH_HISTORY_CARRIER_PREFIX,
  type WebSearchHistoryCarrierPayload,
} from "~/routes/messages/web-search/history-carrier"
import { createWebSearchToolContract } from "~/routes/messages/web-search/tool-contract"

const source = {
  destination: "responses",
  adapter: "copilot-responses",
  provider: "copilot",
  model: "gpt-5.6-sol",
} as const
const responsesContext = {
  destination: "responses",
  canonicalTarget: {
    adapter: source.adapter,
    provider: source.provider,
    model: source.model,
  },
} as const
const toolContract = createWebSearchToolContract([
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 3,
  },
  {
    name: "inspect_runtime",
    description: "Read the runtime version.",
    input_schema: { type: "object", properties: {} },
  },
])

const completeHistory = {
  source,
  output_items: [
    {
      id: "reasoning_fixture",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Searched primary sources." }],
      encrypted_content: "opaque-openai-reasoning-fixture",
      status: "completed",
    },
    {
      id: "search_fixture",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        queries: ["first query", "second query"],
        sources: [{ type: "url", url: "https://example.test/source" }],
      },
    },
    {
      id: "message_fixture",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "One claim and a repeated claim.",
          annotations: [
            {
              type: "url_citation",
              start_index: 0,
              end_index: 9,
              title: "Primary source",
              url: "https://example.test/source",
            },
            {
              type: "url_citation",
              start_index: 16,
              end_index: 30,
              title: "Primary source",
              url: "https://example.test/source",
            },
          ],
        },
      ],
    },
  ],
  continuation: { kind: "complete" },
} satisfies WebSearchHistoryCarrierPayload

const makePayloadWithNodeCount = (
  targetNodeCount: number,
): WebSearchHistoryCarrierPayload => {
  const fixedNodesOutsideExtension = 12
  const chunkCount = 10
  let primitiveNodes =
    targetNodeCount - fixedNodesOutsideExtension - 1 - chunkCount
  const chunks: Array<Array<number>> = []
  for (let index = 0; index < chunkCount; index += 1) {
    const size = Math.min(
      WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH,
      primitiveNodes,
    )
    chunks.push(Array<number>(size).fill(0))
    primitiveNodes -= size
  }
  if (primitiveNodes !== 0) {
    throw new Error("Fixture cannot represent requested node count")
  }
  return {
    source,
    output_items: [
      {
        id: `search_node_boundary_${targetNodeCount}`,
        type: "web_search_call",
        provider_extension: chunks,
      },
    ],
    continuation: { kind: "complete" },
  }
}

const countJsonNodes = (root: unknown): number => {
  const stack: Array<unknown> = [root]
  let count = 0
  while (stack.length > 0) {
    const value = stack.pop()
    count += 1
    if (typeof value !== "object" || value === null) continue
    if (Array.isArray(value)) {
      for (const child of value) stack.push(child)
    } else {
      for (const child of Object.values(value)) stack.push(child)
    }
  }
  return count
}

describe("Web Search history carrier contract", () => {
  test("round-trips the complete Responses transcript for the same provider and model", () => {
    const encoded = encodeWebSearchHistoryCarrier(completeHistory)

    expect(encoded).toStartWith(WEB_SEARCH_HISTORY_CARRIER_PREFIX)
    expect(decodeWebSearchHistoryCarrier(encoded, responsesContext)).toEqual({
      kind: "accepted",
      envelope: {
        schema: "copilot-api.web-search-history",
        version: 1,
        ...completeHistory,
      },
    })
  })

  test("rejects replay across provider and model scopes", () => {
    const encoded = encodeWebSearchHistoryCarrier(completeHistory)

    expect(
      decodeWebSearchHistoryCarrier(encoded, {
        ...responsesContext,
        canonicalTarget: {
          ...responsesContext.canonicalTarget,
          provider: "openai",
        },
      }),
    ).toEqual({ kind: "rejected", reason: "provider-mismatch" })
    expect(
      decodeWebSearchHistoryCarrier(encoded, {
        ...responsesContext,
        canonicalTarget: {
          ...responsesContext.canonicalTarget,
          model: "gpt-5.6-terra",
        },
      }),
    ).toEqual({ kind: "rejected", reason: "model-mismatch" })
  })

  test("scopes replay by destination, adapter, and alias-resolved canonical target", () => {
    const encoded = encodeWebSearchHistoryCarrier(completeHistory)
    const nativeTarget = {
      destination: "messages",
      canonicalTarget: {
        adapter: "anthropic-messages",
        provider: source.provider,
        model: source.model,
      },
    } as const
    const responsesTarget = responsesContext
    const requestedAlias = "search-model-alias"

    expect(decodeWebSearchHistoryCarrier(encoded, nativeTarget)).toEqual({
      kind: "rejected",
      reason: "destination-mismatch",
    })
    expect(
      decodeWebSearchHistoryCarrier(encoded, responsesTarget),
    ).toMatchObject({ kind: "accepted", envelope: { source } })
    expect(
      decodeWebSearchHistoryCarrier(encoded, {
        ...responsesTarget,
        canonicalTarget: {
          ...responsesTarget.canonicalTarget,
          adapter: "provider-responses",
        },
      }),
    ).toEqual({ kind: "rejected", reason: "adapter-mismatch" })
    expect(
      decodeWebSearchHistoryCarrier(encoded, {
        ...responsesTarget,
        canonicalTarget: {
          ...responsesTarget.canonicalTarget,
          model: requestedAlias,
        },
      }),
    ).toEqual({ kind: "rejected", reason: "model-mismatch" })

    const providerSource = {
      destination: "responses",
      adapter: "provider-responses",
      provider: "openai",
      model: "gpt-provider-fixture",
    } as const
    const providerCarrier = encodeWebSearchHistoryCarrier({
      ...completeHistory,
      source: providerSource,
    })
    expect(
      decodeWebSearchHistoryCarrier(providerCarrier, {
        destination: "responses",
        canonicalTarget: {
          adapter: providerSource.adapter,
          provider: providerSource.provider,
          model: providerSource.model,
        },
      }),
    ).toMatchObject({ kind: "accepted", envelope: { source: providerSource } })

    const selfClaimedNativeEnvelope = {
      schema: "copilot-api.web-search-history",
      version: 1,
      ...completeHistory,
      source: {
        destination: "messages",
        adapter: "anthropic-messages",
        provider: source.provider,
        model: source.model,
      },
    }
    const selfClaimedNativeCarrier =
      WEB_SEARCH_HISTORY_CARRIER_PREFIX
      + Buffer.from(JSON.stringify(selfClaimedNativeEnvelope), "utf8").toString(
        "base64url",
      )
    expect(
      decodeWebSearchHistoryCarrier(selfClaimedNativeCarrier, nativeTarget),
    ).toEqual({ kind: "rejected", reason: "destination-mismatch" })
  })

  test("keeps legacy history non-resumable and rejects malformed or unsupported carriers", () => {
    expect(decodeWebSearchHistoryCarrier(undefined, responsesContext)).toEqual({
      kind: "legacy",
      mode: "non-resumable",
    })
    expect(
      decodeWebSearchHistoryCarrier(
        "copilot-api-web-search-v2:e30",
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "unsupported-version" })
    expect(
      decodeWebSearchHistoryCarrier(
        `${WEB_SEARCH_HISTORY_CARRIER_PREFIX}%%%`,
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "malformed" })
    expect(
      decodeWebSearchHistoryCarrier(
        WEB_SEARCH_HISTORY_CARRIER_PREFIX
          + "A".repeat(WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS + 1),
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "too-large" })

    const wideObject = Object.fromEntries(
      Array.from(
        { length: WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH + 1 },
        (_, index) => [`field_${index}`, index],
      ),
    )
    expect(
      validateWebSearchHistoryCarrierPayload({
        ...completeHistory,
        output_items: [
          {
            id: "search_wide_object",
            type: "web_search_call",
            provider_extension: wideObject,
          },
        ],
      }),
    ).toEqual({ valid: false, reason: "too-large" })
  })

  test("rejects invalid UTF-8 and non-canonical base64url aliases", () => {
    const carrier = encodeWebSearchHistoryCarrier(completeHistory)
    const encoded = carrier.slice(WEB_SEARCH_HISTORY_CARRIER_PREFIX.length)
    const invalidUtf8 = Buffer.from(encoded, "base64url")
    const queryOffset = invalidUtf8.indexOf("first query", 0, "utf8")
    expect(queryOffset).toBeGreaterThanOrEqual(0)
    invalidUtf8[queryOffset] = 0x80

    expect(
      decodeWebSearchHistoryCarrier(
        WEB_SEARCH_HISTORY_CARRIER_PREFIX + invalidUtf8.toString("base64url"),
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "malformed" })

    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    let canonicalCarrier = ""
    let canonicalBytes = Buffer.alloc(0)
    for (const padding of ["", "x", "xx"]) {
      const paddedHistory = structuredClone(completeHistory)
      Object.assign(paddedHistory.output_items[1], {
        fixture_padding: padding,
      })
      canonicalCarrier = encodeWebSearchHistoryCarrier(paddedHistory)
      canonicalBytes = Buffer.from(
        canonicalCarrier.slice(WEB_SEARCH_HISTORY_CARRIER_PREFIX.length),
        "base64url",
      )
      if (canonicalBytes.length % 3 !== 0) break
    }
    const canonicalEncoded = canonicalCarrier.slice(
      WEB_SEARCH_HISTORY_CARRIER_PREFIX.length,
    )
    const lastIndex = alphabet.indexOf(canonicalEncoded.at(-1) ?? "")
    const remainder = canonicalBytes.length % 3
    expect(remainder).not.toBe(0)
    const dataMask = remainder === 1 ? 0b11_0000 : 0b11_1100
    const aliasLastIndex = (lastIndex & dataMask) | 1
    const alias = canonicalEncoded.slice(0, -1) + alphabet[aliasLastIndex]

    expect(Buffer.from(alias, "base64url")).toEqual(canonicalBytes)
    expect(
      decodeWebSearchHistoryCarrier(
        WEB_SEARCH_HISTORY_CARRIER_PREFIX + alias,
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "malformed" })
  })

  test("round-trips paused and client-tool waiting states without deleting pending server tools", () => {
    const continuations = [
      {
        kind: "pause_turn",
        pending_server_tool_use_ids: ["srvtoolu_search_fixture"],
      },
      {
        kind: "waiting_client_tools",
        pending_server_tool_use_ids: ["srvtoolu_search_fixture"],
        pending_client_tool_use_ids: ["toolu_client_fixture"],
      },
    ] as const

    for (const continuation of continuations) {
      const payload = {
        ...completeHistory,
        continuation,
        tool_contract: toolContract,
      }
      const encoded = encodeWebSearchHistoryCarrier(payload)

      expect(
        decodeWebSearchHistoryCarrier(encoded, responsesContext),
      ).toMatchObject({
        kind: "accepted",
        envelope: { continuation },
      })
    }
  })

  test("requires a valid tool fingerprint only for pending continuations", () => {
    const continuation = {
      kind: "pause_turn" as const,
      pending_server_tool_use_ids: ["srvtoolu_search_fixture"],
    }
    expect(
      validateWebSearchHistoryCarrierPayload({
        ...completeHistory,
        continuation,
      }),
    ).toEqual({ valid: false, reason: "invalid-tool-contract" })
    expect(
      validateWebSearchHistoryCarrierPayload({
        ...completeHistory,
        continuation,
        tool_contract: { algorithm: "sha256", digest: "A".repeat(64) },
      }),
    ).toEqual({ valid: false, reason: "invalid-tool-contract" })
    expect(
      validateWebSearchHistoryCarrierPayload({
        ...completeHistory,
        tool_contract: toolContract,
      }),
    ).toEqual({ valid: false, reason: "invalid-tool-contract" })
  })

  test("requires bounded unique continuation IDs within and across pending sets", () => {
    const invalidContinuations = [
      {
        kind: "pause_turn",
        pending_server_tool_use_ids: ["   "],
      },
      {
        kind: "pause_turn",
        pending_server_tool_use_ids: [" srvtoolu_padded "],
      },
      {
        kind: "pause_turn",
        pending_server_tool_use_ids: ["s".repeat(513)],
      },
      {
        kind: "pause_turn",
        pending_server_tool_use_ids: ["srvtoolu_same", "srvtoolu_same"],
      },
      {
        kind: "waiting_client_tools",
        pending_server_tool_use_ids: ["srvtoolu_waiting"],
        pending_client_tool_use_ids: ["toolu_same", "toolu_same"],
      },
      {
        kind: "waiting_client_tools",
        pending_server_tool_use_ids: ["shared_pending_id"],
        pending_client_tool_use_ids: ["shared_pending_id"],
      },
    ]

    for (const continuation of invalidContinuations) {
      expect(
        validateWebSearchHistoryCarrierPayload({
          ...completeHistory,
          continuation,
          tool_contract: toolContract,
        }),
      ).toEqual({ valid: false, reason: "invalid-continuation" })
    }
  })

  test("marks gateway history for native rejection without fabricating Anthropic opaque fields", () => {
    const carrier = encodeWebSearchHistoryCarrier(completeHistory)
    const syntheticServerToolInput = {
      query: "first query",
      [WEB_SEARCH_HISTORY_CARRIER_FIELD]: carrier,
    }

    expect(
      decodeWebSearchHistoryCarrier(
        syntheticServerToolInput[WEB_SEARCH_HISTORY_CARRIER_FIELD],
        {
          destination: "messages",
          canonicalTarget: {
            adapter: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-5",
          },
        },
      ),
    ).toEqual({ kind: "rejected", reason: "destination-mismatch" })
    expect(JSON.stringify(syntheticServerToolInput)).not.toContain(
      '"encrypted_content"',
    )
    expect(JSON.stringify(syntheticServerToolInput)).not.toContain(
      '"encrypted_index"',
    )
  })

  test("validates resumable history before writing a carrier", () => {
    const textOnlyHistory = {
      ...completeHistory,
      output_items: [completeHistory.output_items[2]],
    }

    expect(validateWebSearchHistoryCarrierPayload(completeHistory)).toEqual({
      valid: true,
    })
    expect(validateWebSearchHistoryCarrierPayload(textOnlyHistory)).toEqual({
      valid: false,
      reason: "missing-web-search-call",
    })
    expect(() => encodeWebSearchHistoryCarrier(textOnlyHistory)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )
  })

  test("keeps every encoder-accepted payload closed under decoder validation", () => {
    const wrongEnvelope = {
      ...completeHistory,
      schema: "wrong.web-search-history",
      version: 9,
    }
    const sparseItems = new Array<Record<string, unknown>>(2)
    sparseItems[1] = {
      id: "search_sparse",
      type: "web_search_call",
    }
    const sparseHistory = {
      ...completeHistory,
      output_items: sparseItems,
    }

    expect(validateWebSearchHistoryCarrierPayload(wrongEnvelope)).toEqual({
      valid: false,
      reason: "invalid-envelope",
    })
    expect(() => encodeWebSearchHistoryCarrier(wrongEnvelope)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )
    expect(validateWebSearchHistoryCarrierPayload(sparseHistory)).toEqual({
      valid: false,
      reason: "invalid-output-items",
    })
    expect(() => encodeWebSearchHistoryCarrier(sparseHistory as never)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )

    const encoded = encodeWebSearchHistoryCarrier(completeHistory)
    expect(decodeWebSearchHistoryCarrier(encoded, responsesContext).kind).toBe(
      "accepted",
    )
  })

  test("rejects enumerable accessors without invoking them", () => {
    let objectGetterReads = 0
    const accessorItem: Record<string, unknown> = {
      id: "search_accessor_object",
      type: "web_search_call",
    }
    Object.defineProperty(accessorItem, "provider_extension", {
      enumerable: true,
      get: () => {
        objectGetterReads += 1
        return { hidden: "stateful" }
      },
    })

    let arrayGetterReads = 0
    const accessorItems = new Array<Record<string, unknown>>(1)
    Object.defineProperty(accessorItems, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        arrayGetterReads += 1
        return { id: "search_accessor_array", type: "web_search_call" }
      },
    })

    for (const output_items of [[accessorItem], accessorItems]) {
      const history = { ...completeHistory, output_items }
      expect(validateWebSearchHistoryCarrierPayload(history)).toMatchObject({
        valid: false,
      })
      expect(() => encodeWebSearchHistoryCarrier(history)).toThrow(
        WebSearchHistoryCarrierValidationError,
      )
    }
    expect(objectGetterReads).toBe(0)
    expect(arrayGetterReads).toBe(0)
  })

  test("encodes one canonical snapshot despite proxy-like state changes", () => {
    let extensionReads = 0
    const targetItem = {
      id: "search_proxy_snapshot",
      type: "web_search_call",
      provider_extension: { stable: true },
    }
    const statefulItem = new Proxy(targetItem, {
      get: (target, property, receiver) => {
        if (property === "provider_extension") {
          extensionReads += 1
          return extensionReads <= 3 ?
              { stable: true }
            : "x".repeat(WEB_SEARCH_HISTORY_MAX_DECODED_BYTES)
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const history = {
      ...completeHistory,
      output_items: [statefulItem],
    }

    const encoded = encodeWebSearchHistoryCarrier(history)
    expect(extensionReads).toBe(0)
    expect(encoded.length).toBeLessThanOrEqual(
      WEB_SEARCH_HISTORY_CARRIER_PREFIX.length
        + WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS,
    )
    expect(
      decodeWebSearchHistoryCarrier(encoded, responsesContext),
    ).toMatchObject({
      kind: "accepted",
      envelope: {
        output_items: [
          {
            id: "search_proxy_snapshot",
            provider_extension: { stable: true },
            type: "web_search_call",
          },
        ],
      },
    })
  })

  test("rejects array holes hidden by extra keys and abnormal prototypes", () => {
    const holeWithExtraKey = new Array<Record<string, unknown>>(2)
    holeWithExtraKey[1] = {
      id: "search_hole_extra",
      type: "web_search_call",
    }
    Object.assign(holeWithExtraKey, {
      extra: { id: "extra_item", type: "web_search_call" },
    })

    const abnormalOutputItems = [
      { id: "search_abnormal", type: "web_search_call" },
    ]
    Object.setPrototypeOf(abnormalOutputItems, null)

    const nestedAbnormalArray = ["query"]
    Object.setPrototypeOf(nestedAbnormalArray, null)
    const nestedAbnormalHistory = {
      ...completeHistory,
      output_items: [
        {
          id: "search_nested_abnormal",
          type: "web_search_call",
          action: { queries: nestedAbnormalArray },
        },
      ],
    }
    const nonEnumerableExtra = [
      { id: "search_hidden_extra", type: "web_search_call" },
    ]
    Object.defineProperty(nonEnumerableExtra, "hidden", {
      enumerable: false,
      value: "not-json-visible",
    })
    const symbolExtra = [{ id: "search_symbol_extra", type: "web_search_call" }]
    Object.assign(symbolExtra, {
      [Symbol("not-json-visible")]: true,
    })

    for (const output_items of [
      holeWithExtraKey,
      abnormalOutputItems,
      nestedAbnormalHistory.output_items,
      nonEnumerableExtra,
      symbolExtra,
    ]) {
      expect(() =>
        validateWebSearchHistoryCarrierPayload({
          ...completeHistory,
          output_items,
        }),
      ).not.toThrow()
      expect(
        validateWebSearchHistoryCarrierPayload({
          ...completeHistory,
          output_items,
        }),
      ).toEqual({ valid: false, reason: "invalid-output-items" })
    }
  })

  test("applies the same validation to untrusted carrier reads", () => {
    const invalidEnvelope = {
      schema: "copilot-api.web-search-history",
      version: 1,
      source,
      output_items: [completeHistory.output_items[2]],
      continuation: { kind: "complete" },
    }
    const encoded =
      WEB_SEARCH_HISTORY_CARRIER_PREFIX
      + Buffer.from(JSON.stringify(invalidEnvelope), "utf8").toString(
        "base64url",
      )

    expect(decodeWebSearchHistoryCarrier(encoded, responsesContext)).toEqual({
      kind: "rejected",
      reason: "malformed",
    })
  })

  test("rejects undeclared envelope and continuation fields", () => {
    const invalidEnvelopes = [
      {
        schema: "copilot-api.web-search-history",
        version: 1,
        ...completeHistory,
        unexpected: "future-field-without-a-new-version",
      },
      {
        schema: "copilot-api.web-search-history",
        version: 1,
        ...completeHistory,
        continuation: {
          kind: "complete",
          pending_server_tool_use_ids: ["srvtoolu_unexpected"],
        },
      },
    ]

    for (const envelope of invalidEnvelopes) {
      const encoded =
        WEB_SEARCH_HISTORY_CARRIER_PREFIX
        + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")
      expect(decodeWebSearchHistoryCarrier(encoded, responsesContext)).toEqual({
        kind: "rejected",
        reason: "malformed",
      })
    }
  })

  test("rejects lossy JSON and bounded-history violations before encoding", () => {
    const lossyHistory = {
      ...completeHistory,
      output_items: [
        {
          id: "search_lossy",
          type: "web_search_call",
          provider_extension: undefined,
        },
      ],
    }
    const negativeZeroHistory = {
      ...completeHistory,
      output_items: [
        {
          id: "search_negative_zero",
          type: "web_search_call",
          provider_extension: -0,
        },
      ],
    }
    const tooManyItems = {
      ...completeHistory,
      output_items: Array.from(
        { length: WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS + 1 },
        (_, index) => ({
          id: `search_${index}`,
          type: "web_search_call",
        }),
      ),
    }
    const oversizedHistory: WebSearchHistoryCarrierPayload = {
      ...completeHistory,
      output_items: [
        {
          id: "search_oversized",
          type: "web_search_call",
          action: {
            type: "search",
            query: "x".repeat(WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS),
          },
        },
      ],
    }

    expect(validateWebSearchHistoryCarrierPayload(lossyHistory)).toEqual({
      valid: false,
      reason: "invalid-output-items",
    })
    expect(validateWebSearchHistoryCarrierPayload(negativeZeroHistory)).toEqual(
      { valid: false, reason: "invalid-output-items" },
    )
    expect(() => encodeWebSearchHistoryCarrier(negativeZeroHistory)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )
    expect(validateWebSearchHistoryCarrierPayload(tooManyItems)).toEqual({
      valid: false,
      reason: "too-large",
    })
    expect(validateWebSearchHistoryCarrierPayload(oversizedHistory)).toEqual({
      valid: false,
      reason: "too-large",
    })
    expect(() => encodeWebSearchHistoryCarrier(oversizedHistory)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )
  })

  test("rejects a 700k-element collection before scanning every child", () => {
    const wideHistory = {
      ...completeHistory,
      output_items: [
        {
          id: "search_wide_collection",
          type: "web_search_call",
          provider_extension: Array<number>(700_000).fill(0),
        },
      ],
    }
    const envelope = {
      schema: "copilot-api.web-search-history",
      version: 1,
      ...wideHistory,
    }
    const serialized = JSON.stringify(envelope)
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(
      WEB_SEARCH_HISTORY_MAX_DECODED_BYTES,
    )

    expect(validateWebSearchHistoryCarrierPayload(wideHistory)).toEqual({
      valid: false,
      reason: "too-large",
    })
    expect(
      decodeWebSearchHistoryCarrier(
        WEB_SEARCH_HISTORY_CARRIER_PREFIX
          + Buffer.from(serialized, "utf8").toString("base64url"),
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "too-large" })
  })

  test("rejects excessive total JSON nodes even when every collection is narrow", () => {
    const nodeHeavyHistory = {
      ...completeHistory,
      output_items: [
        {
          id: "search_node_budget",
          type: "web_search_call",
          provider_extension: Array.from({ length: 200 }, () =>
            Array<number>(600).fill(0),
          ),
        },
      ],
    }

    expect(validateWebSearchHistoryCarrierPayload(nodeHeavyHistory)).toEqual({
      valid: false,
      reason: "too-large",
    })
  })

  test("reserves total node budget before enqueuing wide deep children", () => {
    let descriptorReads = 0
    let nested: unknown = { leaf: true }
    for (let depth = 0; depth < 65; depth += 1) {
      const level = Array<unknown>(
        WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH,
      ).fill(0)
      level[0] = nested
      nested = new Proxy(level, {
        getOwnPropertyDescriptor: (target, property) => {
          if (property !== "length") descriptorReads += 1
          return Reflect.getOwnPropertyDescriptor(target, property)
        },
      })
    }
    const history = {
      ...completeHistory,
      output_items: [
        {
          id: "search_wide_deep_budget",
          type: "web_search_call",
          provider_extension: nested,
        },
      ],
    }

    expect(validateWebSearchHistoryCarrierPayload(history)).toEqual({
      valid: false,
      reason: "too-large",
    })
    expect(descriptorReads).toBeLessThanOrEqual(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES,
    )
  })

  test("reserves schema and version nodes only for payload-form writers", () => {
    const acceptedPayload = makePayloadWithNodeCount(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES - 2,
    )
    const rejectedPayload = makePayloadWithNodeCount(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES - 1,
    )
    expect(countJsonNodes(acceptedPayload)).toBe(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES - 2,
    )
    expect(countJsonNodes(rejectedPayload)).toBe(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES - 1,
    )

    const encoded = encodeWebSearchHistoryCarrier(acceptedPayload)
    const decoded = decodeWebSearchHistoryCarrier(encoded, responsesContext)
    expect(decoded.kind).toBe("accepted")
    if (decoded.kind !== "accepted") {
      throw new Error("Expected exact node-boundary carrier to decode")
    }
    expect(countJsonNodes(decoded.envelope)).toBe(
      WEB_SEARCH_HISTORY_MAX_TOTAL_NODES,
    )
    expect(validateWebSearchHistoryCarrierPayload(decoded.envelope)).toEqual({
      valid: true,
    })

    expect(validateWebSearchHistoryCarrierPayload(rejectedPayload)).toEqual({
      valid: false,
      reason: "too-large",
    })
    expect(() => encodeWebSearchHistoryCarrier(rejectedPayload)).toThrow(
      WebSearchHistoryCarrierValidationError,
    )
  })

  test("requires minimal item types and unique stable Web Search IDs", () => {
    const invalidOutputSets: Array<Array<Record<string, unknown>>> = [
      [{ id: "   ", type: "web_search_call" }],
      [{ id: " search_padded ", type: "web_search_call" }],
      [
        { id: "search_duplicate", type: "web_search_call" },
        { id: "search_duplicate", type: "web_search_call" },
      ],
    ]

    for (const output_items of invalidOutputSets) {
      expect(
        validateWebSearchHistoryCarrierPayload({
          ...completeHistory,
          output_items,
        }),
      ).toEqual({ valid: false, reason: "invalid-output-items" })
    }
  })

  test("preserves bounded output items as opaque JSON under a minimal v1 contract", () => {
    const opaque_items = [
      {
        id: "search_opaque",
        type: "web_search_call",
        action: { queries: [1] },
      },
      {
        id: "message_opaque",
        type: "message",
        content: [null],
      },
      {
        id: "function_opaque",
        type: "function_call",
        namespace: 42,
      },
      {
        id: "future_opaque",
        type: "future_provider_output",
        extension: { preserved: true },
      },
    ]
    const history = { ...completeHistory, output_items: opaque_items }

    expect(validateWebSearchHistoryCarrierPayload(history)).toEqual({
      valid: true,
    })
    const decoded = decodeWebSearchHistoryCarrier(
      encodeWebSearchHistoryCarrier(history as never),
      responsesContext,
    )
    expect(decoded).toMatchObject({
      kind: "accepted",
      envelope: { output_items: opaque_items },
    })
  })

  test("deep-freezes every accepted envelope and nested opaque item iteratively", () => {
    const decoded = decodeWebSearchHistoryCarrier(
      encodeWebSearchHistoryCarrier(completeHistory),
      responsesContext,
    )
    if (decoded.kind !== "accepted") {
      throw new Error("Expected an accepted carrier fixture")
    }
    const { envelope } = decoded
    const searchItem = envelope.output_items[1]
    const messageItem = envelope.output_items[2]
    const action = searchItem?.action as Record<string, unknown>
    const messageContent = messageItem?.content as ReadonlyArray<unknown>

    for (const value of [
      envelope,
      envelope.source,
      envelope.output_items,
      envelope.continuation,
      ...envelope.output_items,
      action,
      action.queries,
      action.sources,
      messageContent,
      messageContent[0],
    ]) {
      expect(Object.isFrozen(value)).toBeTrue()
    }
    expect(() =>
      Object.assign(envelope.output_items[0] ?? {}, { id: "mutated" }),
    ).toThrow()
  })

  test("accepts every currently modeled Responses output item through the shared DTO", () => {
    const output_items: Array<ResponseOutputItem> = [
      {
        id: "reasoning_known_dto",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Known DTO fixture" }],
        encrypted_content: "opaque-known-dto-reasoning",
        status: "completed",
      },
      {
        id: "search_known_dto",
        type: "web_search_call",
        action: { type: "search", query: "known DTO fixture" },
        status: "completed",
      },
      {
        id: "message_known_dto",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Known DTO output", annotations: [] },
        ],
      },
      {
        id: "function_item",
        type: "function_call",
        call_id: "function_call_fixture",
        name: "lookup_fixture",
        arguments: "{}",
        status: "completed",
      },
      {
        id: "tool_search_item",
        type: "tool_search_call",
        call_id: "tool_search_fixture",
        arguments: { query: "fixture" },
        status: "completed",
      },
      {
        id: "tool_search_output_item",
        type: "tool_search_output",
        call_id: "tool_search_fixture",
        tools: [],
        status: "completed",
      },
      {
        id: "compaction_fixture",
        type: "compaction",
        encrypted_content: "opaque-compaction-fixture",
      },
    ]
    const history = { ...completeHistory, output_items }

    expect(validateWebSearchHistoryCarrierPayload(history)).toEqual({
      valid: true,
    })
    expect(
      decodeWebSearchHistoryCarrier(
        encodeWebSearchHistoryCarrier(history),
        responsesContext,
      ).kind,
    ).toBe("accepted")
  })

  test("keeps malformed, version, and size rejection classes distinct", () => {
    const wrongVersionEnvelope = {
      schema: "copilot-api.web-search-history",
      version: 2,
      ...completeHistory,
    }
    const v1PrefixWithV2Envelope =
      WEB_SEARCH_HISTORY_CARRIER_PREFIX
      + Buffer.from(JSON.stringify(wrongVersionEnvelope), "utf8").toString(
        "base64url",
      )

    expect(
      decodeWebSearchHistoryCarrier(v1PrefixWithV2Envelope, responsesContext),
    ).toEqual({ kind: "rejected", reason: "malformed" })
    expect(
      decodeWebSearchHistoryCarrier(
        "copilot-api-web-search-v2:e30",
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "unsupported-version" })
    for (const malformedVersion of [
      "copilot-api-web-search-vX:e30",
      "copilot-api-web-search-v02:e30",
    ]) {
      expect(
        decodeWebSearchHistoryCarrier(malformedVersion, responsesContext),
      ).toEqual({ kind: "rejected", reason: "malformed" })
    }
    expect(
      decodeWebSearchHistoryCarrier(
        WEB_SEARCH_HISTORY_CARRIER_PREFIX
          + "A".repeat(WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS + 1),
        responsesContext,
      ),
    ).toEqual({ kind: "rejected", reason: "too-large" })

    let nested: Record<string, unknown> = { leaf: true }
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { nested }
    }
    expect(
      validateWebSearchHistoryCarrierPayload({
        ...completeHistory,
        output_items: [
          {
            id: "search_depth_limit",
            type: "web_search_call",
            provider_extension: nested,
          },
        ],
      }),
    ).toEqual({ valid: false, reason: "too-large" })
  })

  test("exposes only content-safe carrier diagnostics", () => {
    const decoded = decodeWebSearchHistoryCarrier(
      encodeWebSearchHistoryCarrier(completeHistory),
      responsesContext,
    )
    const fields = getWebSearchHistoryCarrierLogFields(decoded)
    const serialized = JSON.stringify(fields)

    expect(fields).toEqual({
      carrierStatus: "accepted",
      carrierVersion: 1,
      continuationKind: "complete",
      outputItemCount: 3,
    })
    for (const privateValue of [
      "opaque-openai-reasoning-fixture",
      "first query",
      "https://example.test/source",
      "reasoning_fixture",
      source.destination,
      source.adapter,
      source.provider,
      source.model,
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })
})
