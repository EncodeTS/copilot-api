import { describe, expect, test } from "bun:test"

import type {
  ResponseFunctionCallOutputItem,
  ResponseInputImage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  calculateResponsesPayloadBytes,
  imageBudgetLedgerDependencies,
  optimizeInputImagesForPayloadBudget,
  sanitizeAllInputImages,
  sanitizeOversizedInputImages,
} from "~/routes/responses/utils"

const imageDataUrl = (base64Length: number): string =>
  `data:image/png;base64,${"A".repeat(base64Length)}`

const tinyPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="

const makePayload = (imageUrl: string): ResponsesPayload =>
  ({
    input: [
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: imageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ],
    model: "gpt-test",
  }) as unknown as ResponsesPayload

describe("sanitizeOversizedInputImages", () => {
  test("replaces oversized input images with placeholder images", () => {
    const payload = makePayload(tinyPngDataUrl)

    const sanitized = sanitizeOversizedInputImages(payload, 67)

    expect(sanitized).toBe(1)
    const image = (
      payload.input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(image.type).toBe("input_image")
    expect(image.detail).toBe("low")
    expect(image.image_url?.startsWith("data:image/png;base64,")).toBe(true)
    expect(image.image_url).not.toBe(tinyPngDataUrl)
    expect(image.text).toBeUndefined()
  })

  test("keeps input images within the decoded byte limit", () => {
    const imageUrl = imageDataUrl(8)
    const payload = makePayload(imageUrl)

    const sanitized = sanitizeOversizedInputImages(payload, 22)

    expect(sanitized).toBe(0)
    expect(
      (
        payload.input as Array<{
          content: Array<{ detail?: string; image_url?: string; type: string }>
        }>
      )[0].content[1],
    ).toEqual({ detail: "low", image_url: imageUrl, type: "input_image" })
  })

  test("replaces all input images for a retry after payload rejection", () => {
    const firstImageUrl = imageDataUrl(1024)
    const secondImageUrl = imageDataUrl(1024)
    const payload = {
      input: [
        {
          content: [
            { text: "look", type: "input_text" },
            {
              detail: "low",
              image_url: firstImageUrl,
              type: "input_image",
            },
            {
              detail: "low",
              image_url: secondImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload

    const sanitized = sanitizeAllInputImages(payload)

    expect(sanitized).toBe(2)
    expect(JSON.stringify(payload)).not.toContain(firstImageUrl)
    expect(JSON.stringify(payload)).not.toContain(secondImageUrl)
    expect(JSON.stringify(payload)).toContain("data:image/png;base64")
  })

  test("calculates decoded image bytes without counting the data URL prefix", () => {
    const payload = makePayload(imageDataUrl(4))

    const sanitized = sanitizeOversizedInputImages(payload, 10)

    expect(sanitized).toBe(0)
  })

  test("uses exact base64 padding when enforcing the image byte limit", () => {
    const exactPayload = makePayload("data:image/png;base64,AQIDBA==")
    const oversizedPayload = structuredClone(exactPayload)

    expect(sanitizeOversizedInputImages(exactPayload, 4)).toBe(0)
    expect(sanitizeOversizedInputImages(oversizedPayload, 3)).toBe(1)
  })

  test("sanitizes images inside function call outputs", () => {
    const toolImageUrl = imageDataUrl(128)
    const toolOutputImage: ResponseInputImage = {
      detail: "high",
      image_url: toolImageUrl,
      type: "input_image",
    }
    const payload = {
      input: [
        {
          call_id: "call_123",
          output: [toolOutputImage],
          status: "completed",
          type: "function_call_output",
        } satisfies ResponseFunctionCallOutputItem,
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload

    const sanitized = sanitizeOversizedInputImages(payload, 64)

    expect(sanitized).toBe(1)
    expect(toolOutputImage.type).toBe("input_image")
    expect(toolOutputImage.detail).toBe("low")
    expect(
      toolOutputImage.image_url?.startsWith("data:image/png;base64,"),
    ).toBe(true)
    expect(toolOutputImage.image_url).not.toBe(toolImageUrl)
  })
})

describe("optimizeInputImagesForPayloadBudget", () => {
  test("uses one media traversal without decoding or cloning on the budget-only no-op path", async () => {
    const imageUrl = imageDataUrl(128)
    const payload = makePayload(imageUrl)
    const input = payload.input

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: 1024,
      maxPromptImageSize: 1024,
      sendHardLimitBytes: 2048,
    })

    expect(result.changed).toBe(false)
    expect(result.outboundPayload).toBe(payload)
    expect(JSON.stringify(result)).not.toContain(imageUrl)
    expect(payload.input).toBe(input)
    expect(result.budgetInstrumentation).toEqual({
      clones: 0,
      decodedBuffers: 0,
      ledgerMismatches: 0,
      serializations: 1,
      traversals: 1,
    })
  })

  test("keeps hard admission active when image optimization is disabled", async () => {
    const payload = {
      input: [
        {
          content: [{ image_url: imageDataUrl(4096), type: "input_image" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const initialPayloadBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      enabled: false,
      sendHardLimitBytes: initialPayloadBytes - 1,
    })

    expect(result.sendAllowed).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.outboundPayload).toBe(payload)
    expect(result.budgetInstrumentation).toMatchObject({
      clones: 0,
      decodedBuffers: 0,
      serializations: 1,
      traversals: 1,
    })
  })

  test("matches the legacy golden decision and bytes while cloning only on mutation", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(128)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const initialPayloadBytes = calculateResponsesPayloadBytes(payload)
    expect(initialPayloadBytes).toBe(4535)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: initialPayloadBytes - 1000,
      compressionEnabled: false,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: initialPayloadBytes - 1000,
    })

    expect({
      changed: result.changed,
      latestImageReplaced: result.latestImageReplaced,
      replacedCount: result.replacedCount,
      sendAllowed: result.sendAllowed,
      targetMet: result.targetMet,
    }).toEqual({
      changed: true,
      latestImageReplaced: false,
      replacedCount: 1,
      sendAllowed: true,
      targetMet: true,
    })
    expect(result.finalPayloadBytes).toBe(2034)
    expect(calculateResponsesPayloadBytes(payload)).toBe(4535)
    expect(result.finalPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.outboundPayload), "utf8"),
    )
    expect(result.budgetInstrumentation).toMatchObject({
      clones: 1,
      decodedBuffers: 0,
      serializations: 2,
      traversals: 1,
    })
  })

  test("falls back to final-byte truth when the incremental estimate mismatches", async () => {
    const sharedImage = {
      detail: "high",
      image_url: imageDataUrl(4096),
      type: "input_image",
    }
    const compressedImageUrl = `data:image/jpeg;base64,${"B".repeat(64)}`
    const payload = {
      input: [
        { content: [sharedImage], role: "user" },
        { content: [sharedImage], role: "user" },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const initialPayloadBytes = calculateResponsesPayloadBytes(payload)

    const estimateSerializedValueBytes =
      imageBudgetLedgerDependencies.estimateSerializedValueBytes
    imageBudgetLedgerDependencies.estimateSerializedValueBytes = (value) => {
      const bytes = estimateSerializedValueBytes(value)
      return JSON.stringify(value).includes(compressedImageUrl) ?
          bytes + 1
        : bytes
    }
    let result: Awaited<ReturnType<typeof optimizeInputImagesForPayloadBudget>>
    try {
      result = await optimizeInputImagesForPayloadBudget(payload, {
        budgetBytes: initialPayloadBytes - 100,
        compressionAdapter: {
          compress: () =>
            Promise.resolve({
              dataUrl: compressedImageUrl,
              outputBytes: Buffer.byteLength(compressedImageUrl, "utf8"),
            }),
        },
        compressionEnabled: true,
        maxPromptImageSize: 999999,
        sendHardLimitBytes: initialPayloadBytes,
      })
    } finally {
      imageBudgetLedgerDependencies.estimateSerializedValueBytes =
        estimateSerializedValueBytes
    }

    expect(result.changed).toBe(true)
    expect(result.budgetInstrumentation.ledgerMismatches).toBeGreaterThan(0)
    expect(result.budgetInstrumentation.traversals).toBeGreaterThan(1)
    expect(result.finalPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.outboundPayload), "utf8"),
    )
    expect(result.targetMet).toBe(true)
  })

  test("protects every shared-object alias when one path is the latest image", async () => {
    const sharedImage = {
      detail: "high",
      image_url: imageDataUrl(4096),
      type: "input_image",
    }
    const payload = {
      input: [
        { content: [sharedImage], role: "user" },
        { content: [sharedImage], role: "user" },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const original = JSON.stringify(payload)
    const hardLimit = calculateResponsesPayloadBytes(payload) - 1024

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: hardLimit,
      compressionEnabled: false,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: hardLimit,
    })

    expect(result.changed).toBe(false)
    expect(result.latestImageReplaced).toBe(false)
    expect(result.preservedLatestCount).toBe(2)
    expect(result.replacedCount).toBe(0)
    expect(result.sendAllowed).toBe(false)
    expect(JSON.stringify(payload)).toBe(original)
    expect(JSON.stringify(result.outboundPayload)).toBe(original)
    expect(
      JSON.stringify(result.outboundPayload).match(/Local proxy omitted/g),
    ).toBeNull()
  })

  test("replaces one allowed latest alias path without mutating the other wire path", async () => {
    const sharedImage = {
      detail: "high",
      image_url: imageDataUrl(4096),
      type: "input_image",
    }
    const payload = {
      input: [
        { content: [sharedImage], role: "user" },
        { content: [sharedImage], role: "user" },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const original = JSON.stringify(payload)
    const hardLimit = calculateResponsesPayloadBytes(payload) - 1000

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      allowReplacingLatestImages: true,
      budgetBytes: hardLimit,
      compressionEnabled: false,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: hardLimit,
    })
    const input = result.outboundPayload.input as Array<{
      content: Array<{ image_url?: string; text?: string; type: string }>
    }>
    const firstContent = input[0]?.content ?? []
    const secondContent = input[1]?.content ?? []

    expect(result.replacedCount).toBe(1)
    expect(result.latestImageReplaced).toBe(true)
    expect(result.preservedLatestCount).toBe(1)
    expect(result.sendAllowed).toBe(true)
    expect(firstContent).toHaveLength(2)
    expect(firstContent[0]?.image_url).not.toBe(sharedImage.image_url)
    expect(firstContent[1]?.text).toContain("Local proxy omitted")
    expect(secondContent).toHaveLength(1)
    expect(secondContent[0]?.image_url).toBe(sharedImage.image_url)
    expect(firstContent[0]).not.toBe(secondContent[0])
    expect(JSON.stringify(payload)).toBe(original)
    expect(
      JSON.stringify(result.outboundPayload).match(/Local proxy omitted/g),
    ).toHaveLength(1)
  })

  test("counts a compression adapter base64 decode in budget instrumentation", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const payload = {
      input: [
        {
          content: [
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        { content: [{ text: "latest", type: "input_text" }], role: "user" },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const initialPayloadBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: initialPayloadBytes - 100,
      compressionAdapter: {
        compress: (input) => {
          input.onBase64Decoded?.()
          return Promise.resolve({
            dataUrl: imageDataUrl(64),
            outputBytes: 86,
          })
        },
      },
      compressionEnabled: true,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: initialPayloadBytes,
    })

    expect(result.budgetInstrumentation.decodedBuffers).toBe(1)
  })

  test("leaves payload unchanged when it is under budget and image limits", async () => {
    const imageUrl = imageDataUrl(8)
    const payload = makePayload(imageUrl)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: calculateResponsesPayloadBytes(payload) + 100,
      maxPromptImageSize: 1024,
      sendHardLimitBytes: calculateResponsesPayloadBytes(payload) + 200,
    })

    expect(result.changed).toBe(false)
    expect(result.sendAllowed).toBe(true)
    expect(result.targetMet).toBe(true)
    expect(result.hardLimitMet).toBe(true)
    expect(JSON.stringify(payload)).toContain(imageUrl)
  })

  test("does not replace images for normal budget overflow when hard limit is still safe and compression is unavailable", async () => {
    const imageUrl = imageDataUrl(128)
    const payload = makePayload(imageUrl)
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes - 1,
      compressionEnabled: false,
      maxPromptImageSize: 1024,
      sendHardLimitBytes: originalBytes + 100,
    })

    expect(result.changed).toBe(false)
    expect(result.targetMet).toBe(false)
    expect(result.hardLimitMet).toBe(true)
    expect(result.nearLimit).toBe(true)
    expect(result.sendAllowed).toBe(true)
    expect(JSON.stringify(payload)).toContain(imageUrl)
  })

  test("replaces older images before latest images when payload is above the hard send limit", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(128)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const hardLimit = calculateResponsesPayloadBytes(payload) - 1000

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: hardLimit,
      compressionEnabled: false,
      maxPromptImageSize: 4096,
      sendHardLimitBytes: hardLimit,
    })

    expect(result.changed).toBe(true)
    expect(result.replacedCount).toBe(1)
    expect(result.latestImageReplaced).toBe(false)
    expect(result.sendAllowed).toBe(true)
    expect(JSON.stringify(result.outboundPayload)).not.toContain(oldImageUrl)
    expect(JSON.stringify(result.outboundPayload)).toContain(latestImageUrl)
    expect(JSON.stringify(result.outboundPayload)).toContain(
      "Local proxy omitted",
    )
  })

  test("preserves path order when multiple images in one content array are replaced", async () => {
    const firstOldImageUrl = imageDataUrl(4096)
    const secondOldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(64)
    const payload = {
      input: [
        {
          content: [
            {
              detail: "high",
              image_url: firstOldImageUrl,
              type: "input_image",
            },
            {
              detail: "high",
              image_url: secondOldImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              detail: "low",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const initialPayloadBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: initialPayloadBytes,
      compressionEnabled: false,
      maxPromptImageSize: 128,
      sendHardLimitBytes: initialPayloadBytes,
    })
    const serialized = JSON.stringify(result.outboundPayload)

    expect(result.replacedCount).toBe(2)
    expect(serialized).not.toContain(firstOldImageUrl)
    expect(serialized).not.toContain(secondOldImageUrl)
    expect(serialized).toContain(latestImageUrl)
    expect(serialized.match(/Local proxy omitted/g)).toHaveLength(2)
  })

  test("fails closed when only the latest image remains above the hard send limit", async () => {
    const latestImageUrl = imageDataUrl(2048)
    const payload = makePayload(latestImageUrl)
    const hardLimit = calculateResponsesPayloadBytes(payload) - 1024

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: hardLimit,
      compressionEnabled: false,
      maxPromptImageSize: 4096,
      sendHardLimitBytes: hardLimit,
    })

    expect(result.changed).toBe(false)
    expect(result.sendAllowed).toBe(false)
    expect(result.unresolvedReason).toBe("current_visual_working_set_required")
    expect(JSON.stringify(payload)).toContain(latestImageUrl)
  })

  test("replaces latest images only after exhausting latest compression when explicitly allowed", async () => {
    const latestImageUrl = imageDataUrl(4096)
    const payload = makePayload(latestImageUrl)
    const hardLimit = calculateResponsesPayloadBytes(payload) - 1024
    const calls: Array<string> = []

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      allowReplacingLatestImages: true,
      budgetBytes: hardLimit,
      compressionAdapter: {
        compress: (input) => {
          calls.push(`${input.group}:${input.profile.name}`)
          return Promise.resolve(null)
        },
      },
      compressionEnabled: true,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: hardLimit,
    })

    expect(calls).toEqual([
      "latest_user_group:latest-soft",
      "latest_user_group:latest-hard",
      "latest_user_group:latest-extreme",
    ])
    expect(result.changed).toBe(true)
    expect(result.compressionAttemptedCount).toBe(3)
    expect(result.compressionProfiles).toEqual([
      {
        attemptedCount: 1,
        compressedCount: 0,
        profile: "latest-soft",
        statusCounts: { adapter_error: 1 },
      },
      {
        attemptedCount: 1,
        compressedCount: 0,
        profile: "latest-hard",
        statusCounts: { adapter_error: 1 },
      },
      {
        attemptedCount: 1,
        compressedCount: 0,
        profile: "latest-extreme",
        statusCounts: { adapter_error: 1 },
      },
    ])
    expect(result.replacedCount).toBe(1)
    expect(result.latestImageReplaced).toBe(true)
    expect(result.sendAllowed).toBe(true)
    expect(JSON.stringify(result.outboundPayload)).not.toContain(latestImageUrl)
    expect(JSON.stringify(result.outboundPayload)).toContain(
      "Local proxy omitted",
    )
  })

  test("compresses older images before replacing payload budget overflow", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(1024)
    const compressedOldImageUrl = "data:image/jpeg;base64,AAAA"
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)
    const calls: Array<string> = []

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes - 2000,
      compressionAdapter: {
        compress: (input) => {
          calls.push(`${input.group}:${input.profile.name}`)
          return Promise.resolve(
            input.group === "history_user" ?
              {
                dataUrl: compressedOldImageUrl,
                outputBytes: compressedOldImageUrl.length,
              }
            : null,
          )
        },
      },
      compressionEnabled: true,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes + 100,
    })

    expect(result.compressedCount).toBe(1)
    expect(result.replacedCount).toBe(0)
    expect(result.targetMet).toBe(true)
    expect(JSON.stringify(result.outboundPayload)).not.toContain(oldImageUrl)
    expect(JSON.stringify(result.outboundPayload)).toContain(
      compressedOldImageUrl,
    )
    expect(JSON.stringify(result.outboundPayload)).toContain(latestImageUrl)
    expect(calls).toEqual(["history_user:history-soft"])
  })

  test("classifies history and current-turn tool image paths in the shared inventory", async () => {
    const toolOutput = (callId: string): ResponseFunctionCallOutputItem => ({
      call_id: callId,
      output: [
        {
          detail: "high",
          image_url: imageDataUrl(1024),
          type: "input_image",
        },
      ],
      status: "completed",
      type: "function_call_output",
    })
    const payload = {
      input: [
        toolOutput("history_tool"),
        {
          content: [
            {
              detail: "high",
              image_url: imageDataUrl(2048),
              type: "input_image",
            },
          ],
          role: "user",
        },
        toolOutput("current_tool"),
      ],
      model: "gpt-test",
    } satisfies ResponsesPayload
    const calls: Array<string> = []
    const original = JSON.stringify(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: 1,
      compressionAdapter: {
        compress: (input) => {
          calls.push(`${input.group}:${input.profile.name}`)
          return Promise.resolve(null)
        },
      },
      compressionEnabled: true,
      maxCompressionActions: 3,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: calculateResponsesPayloadBytes(payload),
    })

    expect(calls).toEqual([
      "history_tool_output:history-soft",
      "current_turn_tool_output:latest-soft",
      "latest_user_group:latest-soft",
    ])
    expect(result.changed).toBe(false)
    expect(result.budgetInstrumentation.clones).toBe(0)
    expect(JSON.stringify(payload)).toBe(original)
  })

  test("uses latest-soft compression when history-soft alone does not meet the budget", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(4096)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)
    const calls: Array<string> = []

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: 1600,
      compressionAdapter: {
        compress: (input) => {
          calls.push(`${input.group}:${input.profile.name}`)
          return Promise.resolve({
            dataUrl:
              input.group === "latest_user_group" ?
                "data:image/jpeg;base64,BBBB"
              : "data:image/jpeg;base64,AAAA",
            outputBytes: 32,
          })
        },
      },
      compressionEnabled: true,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes + 100,
    })

    expect(result.compressedCount).toBe(2)
    expect(result.replacedCount).toBe(0)
    expect(result.targetMet).toBe(true)
    expect(calls).toEqual([
      "history_user:history-soft",
      "latest_user_group:latest-soft",
    ])
  })

  test("ignores compression output that is not smaller", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(128)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes - 1000,
      compressionAdapter: {
        compress: () =>
          Promise.resolve({
            dataUrl: imageDataUrl(8192),
            outputBytes: 8192,
          }),
      },
      compressionEnabled: true,
      maxCompressionActions: 1,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes - 1000,
    })

    expect(result.compressedCount).toBe(0)
    expect(result.replacedCount).toBe(1)
    expect(result.compressionStatusCounts).toEqual({ no_smaller: 1 })
    expect(JSON.stringify(payload)).not.toContain(imageDataUrl(8192))
  })

  test("reports negative compression cache hits without treating them as compressed images", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(128)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes - 1000,
      compressionAdapter: {
        compress: () =>
          Promise.resolve({
            cacheHit: "negative",
            status: "no_smaller",
          }),
      },
      compressionEnabled: true,
      maxCompressionActions: 1,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes - 1000,
    })

    expect(result.compressedCount).toBe(0)
    expect(result.compressionNegativeCacheHitCount).toBe(1)
    expect(result.compressionStatusCounts).toEqual({ no_smaller: 1 })
    expect(result.replacedCount).toBe(1)
  })

  test("reports compression diagnostics with one safe sample per diagnostic", async () => {
    const oldImageUrl = imageDataUrl(4096)
    const latestImageUrl = imageDataUrl(128)
    const payload = {
      input: [
        {
          content: [
            { text: "old", type: "input_text" },
            { detail: "high", image_url: oldImageUrl, type: "input_image" },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: latestImageUrl,
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes - 1000,
      compressionAdapter: {
        compress: (input) =>
          Promise.resolve({
            diagnostic: "encode_failed",
            diagnosticDetail: {
              message: "heif encoder unavailable",
              name: "Error",
              stack: "Error: heif encoder unavailable\n    at encode",
              stage: "encode",
            },
            elapsedMs: 12,
            inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
            status: "adapter_error",
          }),
      },
      compressionEnabled: true,
      maxCompressionActions: 1,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes - 1000,
    })

    expect(result.compressionDiagnosticCounts).toEqual({ encode_failed: 1 })
    expect(result.compressionDiagnosticSamples).toEqual([
      {
        dataUrlBytes: Buffer.byteLength(oldImageUrl, "utf8"),
        decodedBytes: 3072,
        diagnostic: "encode_failed",
        elapsedMs: 12,
        group: "history_user",
        inputBytes: Buffer.byteLength(oldImageUrl, "utf8"),
        message: "heif encoder unavailable",
        mimeType: "image/png",
        name: "Error",
        outputBytes: undefined,
        profile: "history-soft",
        stack: "Error: heif encoder unavailable\n    at encode",
        stage: "encode",
        status: "adapter_error",
      },
    ])
    expect(result.compressionStatusCounts).toEqual({ adapter_error: 1 })
    expect(result.replacedCount).toBe(1)
  })

  test("limits compression attempts per request", async () => {
    const payload = {
      input: [
        {
          content: [
            { text: "old 1", type: "input_text" },
            {
              detail: "high",
              image_url: imageDataUrl(4096),
              type: "input_image",
            },
          ],
          role: "user",
        },
        {
          content: [
            { text: "old 2", type: "input_text" },
            {
              detail: "high",
              image_url: imageDataUrl(4096),
              type: "input_image",
            },
          ],
          role: "user",
        },
        {
          content: [
            { text: "latest", type: "input_text" },
            {
              detail: "high",
              image_url: imageDataUrl(4096),
              type: "input_image",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)
    let attempts = 0

    await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: 1,
      compressionAdapter: {
        compress: () => {
          attempts += 1
          return Promise.resolve(null)
        },
      },
      compressionEnabled: true,
      maxCompressionActions: 2,
      maxPromptImageSize: 999999,
      sendHardLimitBytes: originalBytes - 1000,
    })

    expect(attempts).toBe(2)
  })

  test("uses decoded bytes from compressed output when resolving image size limits", async () => {
    const latestImageUrl = "data:image/png;base64,AAAAAAAAAAAAAAAA"
    const compressedImageUrl = "data:image/jpeg;base64,AAAA"
    const payload = makePayload(latestImageUrl)
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: originalBytes,
      compressionAdapter: {
        compress: () =>
          Promise.resolve({
            dataUrl: compressedImageUrl,
            outputBytes: Buffer.byteLength(compressedImageUrl, "utf8"),
          }),
      },
      compressionEnabled: true,
      maxPromptImageSize: 8,
      sendHardLimitBytes: originalBytes + 100,
    })

    expect(result.sendAllowed).toBe(true)
    expect(result.oversizedResolvedCount).toBe(1)
    expect(JSON.stringify(result.outboundPayload)).toContain(compressedImageUrl)
  })

  test("reports unoptimizable file data separately from text and tool bytes", async () => {
    const fileData = `data:application/pdf;base64,${"A".repeat(128)}`
    const payload = {
      input: [
        {
          content: [
            { text: "read this", type: "input_text" },
            {
              file_data: fileData,
              filename: "large.pdf",
              type: "input_file",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-test",
    } as unknown as ResponsesPayload
    const originalBytes = calculateResponsesPayloadBytes(payload)

    const result = await optimizeInputImagesForPayloadBudget(payload, {
      budgetBytes: 1,
      compressionEnabled: true,
      sendHardLimitBytes: originalBytes - 1,
    })

    expect(result.sendAllowed).toBe(false)
    expect(result.unresolvedReason).toBe("unoptimizable_file_data")
    expect(result.inputFileDataBytes).toBe(Buffer.byteLength(fileData, "utf8"))
    expect(result.largestUnoptimizableKind).toBe("input_file.file_data")
    expect(result.textAndToolBytes).toBeLessThan(result.finalPayloadBytes)
  })
})
