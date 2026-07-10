import { describe, expect, test } from "bun:test"

import type {
  ImageCompressionInput,
  ImageCompressionResult,
} from "~/routes/responses/utils"

import {
  CompressionSemaphore,
  createSharpImageCompressionAdapter,
} from "~/routes/responses/image-compression"

const toDataUrl = (mimeType: string, buffer: Buffer): string =>
  `data:${mimeType};base64,${buffer.toString("base64")}`

const expectStructuredResult = (
  result: Awaited<
    ReturnType<
      ReturnType<typeof createSharpImageCompressionAdapter>["compress"]
    >
  >,
): ImageCompressionResult => {
  expect(result).not.toBeNull()
  if (!result || !("status" in result)) {
    throw new Error("Expected structured compression result")
  }
  return result
}

describe("Responses image compression adapter", () => {
  test("removes aborted work from the compression queue", async () => {
    const semaphore = new CompressionSemaphore(1)
    let finishFirst: (() => void) | undefined
    const first = semaphore.run(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    await Promise.resolve()

    let abortedTaskRan = false
    const controller = new AbortController()
    const aborted = semaphore.run(() => {
      abortedTaskRan = true
      return Promise.resolve()
    }, controller.signal)
    controller.abort()

    let abortError: unknown
    try {
      await aborted
    } catch (error) {
      abortError = error
    }
    expect(abortError).toMatchObject({ name: "AbortError" })
    expect(abortedTaskRan).toBe(false)

    let nextTaskRan = false
    const next = semaphore.run(() => {
      nextTaskRan = true
      return Promise.resolve()
    })
    finishFirst?.()
    await first
    await next
    expect(nextTaskRan).toBe(true)
  })

  test("keeps timed-out active work deduplicated until it settles", async () => {
    const sharp = (await import("sharp")).default
    const pixels = Buffer.alloc(1800 * 1200 * 3)
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = index % 251
      pixels[index + 1] = (index / 3) % 241
      pixels[index + 2] = (index / 7) % 239
    }
    const png = await sharp(pixels, {
      raw: {
        channels: 3,
        height: 1200,
        width: 1800,
      },
    })
      .png()
      .toBuffer()
    const input = {
      dataUrl: toDataUrl("image/png", png),
      decodedBytes: png.byteLength,
      group: "history_user",
      mimeType: "image/png",
      profile: {
        detail: "keep-original",
        jpegQuality: 82,
        maxLongEdge: 900,
        name: "history-soft",
      },
    } satisfies ImageCompressionInput
    const adapter = createSharpImageCompressionAdapter({
      cacheBytes: 16 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 1,
      format: "jpeg",
      namespace: "test-timeout-dedup",
      timeoutMs: 1,
    })

    const first = expectStructuredResult(await adapter.compress(input))
    const second = expectStructuredResult(await adapter.compress(input))
    expect(first.status).toBe("timeout")
    expect(second).toBe(first)

    let cached: ImageCompressionResult | null = null
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(20)
      const candidate = expectStructuredResult(await adapter.compress(input))
      if (candidate.cacheHit === "positive") {
        cached = candidate
        break
      }
    }

    expect(cached?.status).toBe("compressed")
    expect(cached?.cacheHit).toBe("positive")
  })

  test("compresses PNG input to a smaller JPEG data URL", async () => {
    const sharp = (await import("sharp")).default
    const pixels = Buffer.alloc(1200 * 900 * 3)
    for (let index = 0; index < pixels.length; index += 3) {
      pixels[index] = index % 251
      pixels[index + 1] = (index / 3) % 241
      pixels[index + 2] = (index / 7) % 239
    }
    const png = await sharp(pixels, {
      raw: {
        channels: 3,
        height: 900,
        width: 1200,
      },
    })
      .png()
      .toBuffer()
    const inputDataUrl = toDataUrl("image/png", png)
    const adapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      format: "jpeg",
      namespace: "test",
      timeoutMs: 5000,
    })

    const result = expectStructuredResult(
      await adapter.compress({
        dataUrl: inputDataUrl,
        decodedBytes: png.byteLength,
        group: "history_user",
        mimeType: "image/png",
        profile: {
          detail: "keep-original",
          jpegQuality: 82,
          maxLongEdge: 600,
          name: "history-soft",
        },
      } satisfies ImageCompressionInput),
    )

    expect(result.status).toBe("compressed")
    expect(result.output?.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(
      true,
    )
    expect(result.output?.outputBytes).toBeLessThan(inputDataUrl.length)

    const cached = expectStructuredResult(
      await adapter.compress({
        dataUrl: inputDataUrl,
        decodedBytes: png.byteLength,
        group: "history_user",
        mimeType: "image/png",
        profile: {
          detail: "keep-original",
          jpegQuality: 82,
          maxLongEdge: 600,
          name: "history-soft",
        },
      } satisfies ImageCompressionInput),
    )
    expect(cached.status).toBe("compressed")
    expect(cached.cacheHit).toBe("positive")
  })

  test("skips compression when metadata exceeds local decode safety limits", async () => {
    const sharp = (await import("sharp")).default
    const png = await sharp({
      create: {
        background: "#ffffff",
        channels: 3,
        height: 32,
        width: 32,
      },
    })
      .png()
      .toBuffer()
    const inputDataUrl = toDataUrl("image/png", png)
    const input = {
      dataUrl: inputDataUrl,
      decodedBytes: png.byteLength,
      group: "history_user",
      mimeType: "image/png",
      profile: {
        detail: "keep-original",
        jpegQuality: 82,
        maxLongEdge: 16,
        name: "history-soft",
      },
    } satisfies ImageCompressionInput

    const longEdgeGuardedAdapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      decodeMaxLongEdge: 16,
      format: "jpeg",
      namespace: "test-long-edge-guard",
      timeoutMs: 5000,
    })
    const memoryGuardedAdapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      decodeMaxBytesEstimate: 1,
      format: "jpeg",
      namespace: "test-memory-guard",
      timeoutMs: 5000,
    })

    expect(
      expectStructuredResult(await longEdgeGuardedAdapter.compress(input))
        .status,
    ).toBe("decode_limit")
    const memoryGuardedResult = expectStructuredResult(
      await memoryGuardedAdapter.compress(input),
    )
    expect(memoryGuardedResult.status).toBe("decode_limit")
    expect(memoryGuardedResult.diagnostic).toBe("decode_safety_limit")

    const negativeCached = expectStructuredResult(
      await memoryGuardedAdapter.compress(input),
    )
    expect(negativeCached.status).toBe("decode_limit")
    expect(negativeCached.cacheHit).toBe("negative")
    expect(negativeCached.diagnostic).toBe("decode_safety_limit")
  })

  test("reports image decode failures with sanitized diagnostics", async () => {
    const invalidImageUrl = toDataUrl("image/png", Buffer.from("not an image"))
    const adapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      format: "jpeg",
      namespace: "test-decode-failure",
      timeoutMs: 5000,
    })

    const result = expectStructuredResult(
      await adapter.compress({
        dataUrl: invalidImageUrl,
        decodedBytes: 12,
        group: "history_user",
        mimeType: "image/png",
        profile: {
          detail: "keep-original",
          jpegQuality: 82,
          maxLongEdge: 600,
          name: "history-soft",
        },
      } satisfies ImageCompressionInput),
    )

    expect(result.status).toBe("decode_limit")
    expect(result.diagnostic).toBe("metadata_decode_failed")
    expect(result.diagnosticDetail?.stage).toBe("metadata")
    expect(result.diagnosticDetail?.message).not.toContain("base64")
  })

  test("skips same-or-weaker recompression for images already optimized by the proxy", async () => {
    const sharp = (await import("sharp")).default
    const pixels = Buffer.alloc(600 * 400 * 3, 180)
    const png = await sharp(pixels, {
      raw: {
        channels: 3,
        height: 400,
        width: 600,
      },
    })
      .png()
      .toBuffer()
    const adapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      format: "jpeg",
      namespace: "test-recompression",
      timeoutMs: 5000,
    })
    const first = await adapter.compress({
      dataUrl: toDataUrl("image/png", png),
      decodedBytes: png.byteLength,
      group: "history_user",
      mimeType: "image/png",
      profile: {
        detail: "keep-original",
        jpegQuality: 82,
        maxLongEdge: 300,
        name: "history-soft",
      },
    } satisfies ImageCompressionInput)

    const firstResult = expectStructuredResult(first)
    expect(firstResult.status).toBe("compressed")
    expect(
      expectStructuredResult(
        await adapter.compress({
          dataUrl: firstResult.output?.dataUrl ?? "",
          decodedBytes: firstResult.output?.outputBytes ?? 0,
          group: "latest_user_group",
          mimeType: "image/jpeg",
          profile: {
            detail: "keep-original",
            jpegQuality: 90,
            maxLongEdge: 2576,
            name: "latest-soft",
          },
        } satisfies ImageCompressionInput),
      ).status,
    ).toBe("already_optimized")
  })

  test("caches no-smaller compression attempts as negative cache hits", async () => {
    const sharp = (await import("sharp")).default
    const jpeg = await sharp({
      create: {
        background: "#ffffff",
        channels: 3,
        height: 8,
        width: 8,
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    const inputDataUrl = toDataUrl("image/jpeg", jpeg)
    const adapter = createSharpImageCompressionAdapter({
      cacheBytes: 8 * 1024 * 1024,
      cacheEntries: 8,
      concurrency: 2,
      format: "jpeg",
      namespace: "test-negative-cache",
      timeoutMs: 5000,
    })
    const input = {
      dataUrl: inputDataUrl,
      decodedBytes: jpeg.byteLength,
      group: "history_user",
      mimeType: "image/jpeg",
      profile: {
        detail: "keep-original",
        jpegQuality: 95,
        maxLongEdge: 2576,
        name: "history-soft",
      },
    } satisfies ImageCompressionInput

    const first = expectStructuredResult(await adapter.compress(input))
    expect(first.status).toBe("no_smaller")
    expect(first.cacheHit).toBeUndefined()

    const second = expectStructuredResult(await adapter.compress(input))
    expect(second.status).toBe("no_smaller")
    expect(second.cacheHit).toBe("negative")
  })
})
