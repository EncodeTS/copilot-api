import { describe, expect, test } from "bun:test"

import type { AnthropicTool } from "~/routes/messages/anthropic-types"
import {
  createWebSearchToolContract,
  isWebSearchToolContract,
  WebSearchToolContractError,
} from "~/routes/messages/web-search/tool-contract"

const tools = (): Array<AnthropicTool> => [
  {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 3,
    allowed_domains: ["example.test"],
  },
  {
    name: "inspect_runtime",
    description: "Read the runtime version.",
    input_schema: {
      type: "object",
      properties: { verbose: { type: "boolean" } },
      required: ["verbose"],
    },
  },
]

describe("Web Search continuation tool contract", () => {
  test("sorts object keys while preserving the exact tool array contract", () => {
    const reorderedKeys = JSON.parse(
      '{"0":{"max_uses":3,"name":"web_search","type":"web_search_20250305","allowed_domains":["example.test"]}}',
    ) as Record<string, AnthropicTool>
    const sameFirstTool = [reorderedKeys[0], tools()[1]] as Array<AnthropicTool>

    expect(createWebSearchToolContract(sameFirstTool)).toEqual(
      createWebSearchToolContract(tools()),
    )
    expect(createWebSearchToolContract([...tools()].reverse())).not.toEqual(
      createWebSearchToolContract(tools()),
    )
  })

  test("changes for server versions, limits, domains, descriptions, schemas, and members", () => {
    const baseline = createWebSearchToolContract(tools())
    const variants = [
      () => {
        const value = tools()
        ;(value[0] as { type: string }).type = "web_search_20260318"
        return value
      },
      () => {
        const value = tools()
        ;(value[0] as { max_uses: number }).max_uses = 4
        return value
      },
      () => {
        const value = tools()
        ;(value[0] as { allowed_domains: Array<string> }).allowed_domains.push(
          "changed.test",
        )
        return value
      },
      () => {
        const value = tools()
        ;(value[1] as { description: string }).description = "Changed"
        return value
      },
      () => {
        const value = tools()
        ;(value[1] as { input_schema: Record<string, unknown> }).input_schema =
          {
            type: "object",
            properties: { changed: { type: "string" } },
          }
        return value
      },
      () => [
        ...tools(),
        {
          name: "new_member",
          input_schema: { type: "object", properties: {} },
        } as AnthropicTool,
      ],
    ]

    for (const variant of variants) {
      expect(createWebSearchToolContract(variant())).not.toEqual(baseline)
    }
  })

  test("rejects non-JSON values and validates only canonical digests", () => {
    for (const invalid of [
      [{ name: "bad", input_schema: { value: undefined } }],
      [{ name: "bad", input_schema: { value: Number.NaN } }],
      [{ name: "bad", input_schema: { value: -0 } }],
      [Object.create(null)],
    ]) {
      expect(() =>
        createWebSearchToolContract(invalid as Array<AnthropicTool>),
      ).toThrow(WebSearchToolContractError)
    }

    const contract = createWebSearchToolContract(tools())
    expect(isWebSearchToolContract(contract)).toBe(true)
    expect(
      isWebSearchToolContract({ algorithm: "sha256", digest: "A".repeat(64) }),
    ).toBe(false)
    expect(isWebSearchToolContract({ ...contract, extra: true })).toBe(false)
  })
})
