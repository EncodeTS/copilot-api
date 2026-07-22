import { describe, expect, test } from "bun:test"

import {
  admitResponsesWirePayload,
  createResponsesWireArtifact,
  prepareResponsesWirePayload,
  serializeImmutableResponsesPayload,
  serializeResponsesPayload,
  serializeResponsesWirePayload,
} from "../src/services/copilot/responses-wire-artifact"
import { optimizeInputImagesForPayloadBudget } from "../src/routes/responses/utils"

describe("Responses wire artifact", () => {
  test("keeps exact UTF-8 HTTP and websocket bytes behind a safe summary", () => {
    const payload = prepareResponsesWirePayload({
      input: "你好",
      model: "gpt-test",
    })
    const payloadSerialization = serializeResponsesPayload(payload)
    const serialization = serializeResponsesWirePayload(
      payloadSerialization,
      "user",
    )
    const artifact = createResponsesWireArtifact(
      payloadSerialization,
      "user",
      "websocket",
      serialization,
    )

    expect(artifact.httpBody).toBe(
      '{"input":"你好","model":"gpt-test","include":["reasoning.encrypted_content"]}',
    )
    expect(artifact.websocketFrame).toBe(
      '{"input":"你好","model":"gpt-test","include":["reasoning.encrypted_content"],"type":"response.create","initiator":"user"}',
    )
    expect(artifact.summary).toEqual({
      httpBodyBytes: Buffer.byteLength(artifact.httpBody, "utf8"),
      initiator: "user",
      transport: "websocket",
      websocketFrameDeltaBytes:
        Buffer.byteLength(artifact.websocketFrame!, "utf8")
        - Buffer.byteLength(artifact.httpBody, "utf8"),
      websocketFrameBytes: Buffer.byteLength(artifact.websocketFrame!, "utf8"),
    })
    expect(Object.keys(artifact)).toEqual(["summary"])
    expect(JSON.stringify(artifact)).not.toContain("你好")
    expect(JSON.stringify(artifact)).not.toContain(
      "reasoning.encrypted_content",
    )
  })

  test("freezes every admitted payload node without freezing the caller input", () => {
    const source = {
      input: [
        {
          content: [{ text: "original", type: "input_text" as const }],
          role: "user" as const,
          type: "message" as const,
        },
      ],
      model: "gpt-test",
    }
    const artifact = admitResponsesWirePayload(
      prepareResponsesWirePayload(source),
      "user",
      "http",
    )
    const admittedInput = artifact.payload.input

    expect(Object.isFrozen(artifact.payload)).toBe(true)
    expect(Object.isFrozen(admittedInput)).toBe(true)
    expect(
      Object.isFrozen(Array.isArray(admittedInput) ? admittedInput[0] : null),
    ).toBe(true)
    expect(() => {
      artifact.payload.instructions = "late mutation"
    }).toThrow(TypeError)

    source.input[0].content[0].text = "caller mutation"
    expect(artifact.httpBody).toContain("original")
    expect(artifact.httpBody).not.toContain("caller mutation")
  })

  test("derives the immutable payload from the opaque serialization", () => {
    const source = prepareResponsesWirePayload({
      input: "serialized truth",
      model: "gpt-test",
    })
    const payloadSerialization = serializeResponsesPayload(source)

    source.input = "stale live object"
    const wireSerialization = serializeResponsesWirePayload(
      payloadSerialization,
      "user",
    )
    const artifact = createResponsesWireArtifact(
      payloadSerialization,
      "user",
      "websocket",
      wireSerialization,
    )

    expect(artifact.payload.input).toBe("serialized truth")
    expect(artifact.httpBody).toContain("serialized truth")
    expect(artifact.httpBody).not.toContain("stale live object")
  })

  test("rejects a reflected serialization brand with forged byte metadata", () => {
    const legitimate = serializeResponsesPayload(
      prepareResponsesWirePayload({ input: "legitimate", model: "gpt-test" }),
    )
    const forgedBody = JSON.stringify({
      input: "x".repeat(1_024),
      model: "gpt-test",
    })
    const forged = {
      payloadBytes: 1,
      serializedPayload: forgedBody,
      sourcePayload: { input: "forged", model: "gpt-test" },
    } as typeof legitimate
    for (const symbol of Object.getOwnPropertySymbols(legitimate)) {
      Object.defineProperty(forged, symbol, {
        value: Reflect.get(legitimate, symbol),
      })
    }

    expect(() => createResponsesWireArtifact(forged, "user", "http")).toThrow(
      "Invalid Responses payload serialization",
    )
  })

  test("measures a signed websocket delta after exact envelope rewrites", () => {
    const payload = prepareResponsesWirePayload({
      background: "removed background".repeat(8),
      initiator: "spoofed",
      input: 'quote=" slash=\\ 你好',
      model: "gpt-test",
      service_tier: "removed",
      stream: true,
      type: "spoofed",
    })
    const wire = serializeResponsesWirePayload(
      serializeResponsesPayload(payload),
      "agent",
    )
    const frame = JSON.parse(wire.websocketFrame) as Record<string, unknown>

    expect(wire.summary.websocketFrameDeltaBytes).toBeLessThan(0)
    expect(frame.type).toBe("response.create")
    expect(frame.initiator).toBe("agent")
    expect(frame.stream).toBeUndefined()
    expect(frame.background).toBeUndefined()
    expect(frame.service_tier).toBeUndefined()
    expect(frame.input).toBe('quote=" slash=\\ 你好')
  })

  test("admits tool normalization at the exact cap and rejects cap plus one", async () => {
    const noneTool = (name: string) => ({
      name,
      parameters: { type: "None" },
      strict: false,
      type: "function" as const,
    })
    const source = {
      include: ["reasoning.encrypted_content" as const],
      input: [
        {
          call_id: "synthetic-search",
          tools: [noneTool("searched")],
          type: "tool_search_output" as const,
        },
        {
          role: "developer" as const,
          tools: [
            {
              name: "additional",
              tools: [noneTool("additional-nested")],
              type: "namespace" as const,
            },
          ],
          type: "additional_tools" as const,
        },
      ],
      instructions: "",
      model: "gpt-test",
      tools: [
        noneTool("top-level"),
        {
          name: "namespace",
          tools: [noneTool("top-level-nested")],
          type: "namespace" as const,
        },
      ],
    }
    const originalBytes = Buffer.byteLength(JSON.stringify(source), "utf8")
    const prepared = prepareResponsesWirePayload(source)
    const preparedSerialization = serializeImmutableResponsesPayload(prepared)

    expect(preparedSerialization.payloadBytes - originalBytes).toBe(4 * 18)
    expect(
      preparedSerialization.serializedPayload.match(
        /"parameters":\{"properties":\{\},"type":"object"\}/gu,
      ),
    ).toHaveLength(4)

    const exact = await optimizeInputImagesForPayloadBudget(prepared, {
      budgetBytes: preparedSerialization.payloadBytes,
      enabled: false,
      initialPayloadSerialization: preparedSerialization,
      sendHardLimitBytes: preparedSerialization.payloadBytes,
    })
    const capPlusOnePayload = { ...prepared, instructions: "x" }
    const capPlusOne = await optimizeInputImagesForPayloadBudget(
      capPlusOnePayload,
      {
        budgetBytes: preparedSerialization.payloadBytes,
        enabled: false,
        sendHardLimitBytes: preparedSerialization.payloadBytes,
      },
    )

    expect(exact.sendAllowed).toBe(true)
    expect(capPlusOne.finalPayloadBytes).toBe(
      preparedSerialization.payloadBytes + 1,
    )
    expect(capPlusOne.sendAllowed).toBe(false)
  })

  test("guards mixed invalid tool graphs before structured clone", () => {
    const oversizedTools: Array<unknown> = [
      null,
      ...Array.from({ length: 10_001 }, (_, index) => ({
        name: `tool-${index}`,
        parameters: { type: "None" },
        type: "function",
      })),
    ]
    const payloads = [
      {
        model: "gpt-test",
        tools: oversizedTools,
      },
      {
        model: "gpt-test",
        tools: [
          {
            name: "namespace",
            tools: oversizedTools,
            type: "namespace",
          },
        ],
      },
      {
        input: [
          {
            call_id: "synthetic-search",
            tools: oversizedTools,
            type: "tool_search_output",
          },
        ],
        model: "gpt-test",
      },
      {
        input: [
          {
            role: "developer",
            tools: oversizedTools,
            type: "additional_tools",
          },
        ],
        model: "gpt-test",
      },
    ] as unknown as Array<Parameters<typeof prepareResponsesWirePayload>[0]>

    for (const payload of payloads) {
      Object.assign(payload, { uncloneable: () => undefined })
      expect(() => prepareResponsesWirePayload(payload)).toThrow(
        "Responses tool graph exceeds 10000 entries",
      )
    }
  })

  test("normalizes valid tools after invalid entries in every tool carrier", () => {
    const noneTool = (name: string) => ({
      name,
      parameters: { type: "None" },
      strict: false,
      type: "function" as const,
    })
    const payload = {
      input: [
        {
          call_id: "synthetic-search",
          tools: [null, noneTool("searched")],
          type: "tool_search_output",
        },
        {
          role: "developer",
          tools: [
            null,
            {
              name: "additional",
              tools: [null, noneTool("additional-nested")],
              type: "namespace",
            },
          ],
          type: "additional_tools",
        },
      ],
      model: "gpt-test",
      tools: [
        null,
        noneTool("top"),
        {
          name: "top-namespace",
          tools: [null, noneTool("top-nested")],
          type: "namespace",
        },
      ],
    } as unknown as Parameters<typeof prepareResponsesWirePayload>[0]

    const prepared = prepareResponsesWirePayload(payload)
    expect(
      JSON.stringify(prepared).match(
        /"parameters":\{"properties":\{\},"type":"object"\}/gu,
      ),
    ).toHaveLength(4)
    expect(JSON.stringify(prepared).match(/null/gu)).toHaveLength(5)
  })
})
