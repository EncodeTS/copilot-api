import { describe, expect, test } from "bun:test"

import type {
  ImageCompressionInput,
  ImageCompressionResult,
} from "~/routes/responses/utils"

import {
  createImageCompressionRuntime,
  type ImageCompressionRuntimeSnapshot,
} from "~/routes/responses/image-compression-runtime"
import {
  createSharpImageCompressionAdapter,
  type SharpImageCompressionAdapterOptions,
} from "~/routes/responses/image-compression"

const namespace = (account: string, model = "gpt-test") => ({
  account,
  model,
  origin: "https://api.githubcopilot.com",
  tenant: "individual",
})

const profile = {
  detail: "keep-original" as const,
  jpegQuality: 82,
  maxLongEdge: 600,
  name: "history-soft" as const,
}

const inputFor = (
  payload: string,
  signal?: AbortSignal,
): ImageCompressionInput => ({
  dataUrl: `data:image/png;base64,${Buffer.from(payload).toString("base64")}`,
  decodedBytes: Buffer.byteLength(payload),
  group: "history_user",
  mimeType: "image/png",
  profile,
  signal,
})

const baseOptions = (account: string): SharpImageCompressionAdapterOptions => ({
  cacheBytes: 1024,
  cacheEntries: 8,
  concurrency: 1,
  format: "jpeg",
  maxPendingBytes: 128,
  maxPendingEntries: 3,
  namespace: namespace(account),
  negativeCacheTtlMs: 50,
  positiveCacheTtlMs: 100,
  timeoutMs: 1000,
})

const expectResult = (
  result: Awaited<
    ReturnType<
      ReturnType<typeof createSharpImageCompressionAdapter>["compress"]
    >
  >,
): ImageCompressionResult => {
  expect(result).not.toBeNull()
  if (!result || !("status" in result)) {
    throw new Error("Expected structured image compression result")
  }
  return result
}

describe("process-wide image compression runtime", () => {
  test("shares one weighted cache while isolating account and model namespaces", async () => {
    let now = 0
    let calls = 0
    const runtime = createImageCompressionRuntime({ now: () => now })
    const compressor = (buffer: Buffer) => {
      calls += 1
      return Promise.resolve({
        buffer: Buffer.from(buffer[0] === 97 ? "a" : "b"),
        mimeType: "image/jpeg" as const,
      })
    }
    const accountA = createSharpImageCompressionAdapter({
      ...baseOptions("account-a"),
      binaryCompressor: compressor,
      runtime,
    })
    const accountB = createSharpImageCompressionAdapter({
      ...baseOptions("account-b"),
      binaryCompressor: compressor,
      runtime,
    })
    const modelB = createSharpImageCompressionAdapter({
      ...baseOptions("account-a"),
      binaryCompressor: compressor,
      namespace: namespace("account-a", "gpt-other"),
      runtime,
    })

    const repeatedInput = "a".repeat(100)
    await accountA.compress(inputFor(repeatedInput))
    expect(
      expectResult(await accountA.compress(inputFor(repeatedInput))).cacheHit,
    ).toBe("positive")
    expect(
      expectResult(await accountB.compress(inputFor(repeatedInput))).cacheHit,
    ).toBeUndefined()
    expect(
      expectResult(await modelB.compress(inputFor(repeatedInput))).cacheHit,
    ).toBeUndefined()
    expect(calls).toBe(3)

    now = 101
    expect(
      expectResult(await accountA.compress(inputFor(repeatedInput))).cacheHit,
    ).toBeUndefined()
    expect(calls).toBe(4)

    const snapshot: ImageCompressionRuntimeSnapshot = runtime.snapshot()
    expect(snapshot.cacheWeightBytes).toBeLessThanOrEqual(1024)
    expect(snapshot.cacheEntries).toBeLessThanOrEqual(8)
    expect(JSON.stringify(snapshot)).not.toContain("account-a")
    expect(JSON.stringify(snapshot)).not.toContain("same")
  })

  test("evicts positive and negative entries immediately when global limits shrink", async () => {
    const runtime = createImageCompressionRuntime()
    const positive = createSharpImageCompressionAdapter({
      ...baseOptions("evict"),
      binaryCompressor: (buffer) =>
        Promise.resolve({
          buffer: Buffer.from(buffer),
          mimeType: "image/jpeg",
        }),
      cacheBytes: 256,
      runtime,
    })
    await positive.compress(inputFor("one"))
    await positive.compress(inputFor("two"))

    const negative = createSharpImageCompressionAdapter({
      ...baseOptions("negative"),
      binaryCompressor: () =>
        Promise.resolve({
          diagnostic: "synthetic_decode_limit",
          status: "decode_limit" as const,
        }),
      cacheBytes: 256,
      runtime,
    })
    await negative.compress(inputFor("bad"))
    expect(
      expectResult(await negative.compress(inputFor("bad"))).cacheHit,
    ).toBe("negative")
    expect(runtime.snapshot().cacheEntries).toBeGreaterThan(0)

    createSharpImageCompressionAdapter({
      ...baseOptions("reconfigured"),
      binaryCompressor: (buffer) =>
        Promise.resolve({ buffer, mimeType: "image/jpeg" }),
      cacheBytes: 0,
      runtime,
    })
    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 0,
      cacheWeightBytes: 0,
      negativeCacheEntries: 0,
      positiveCacheEntries: 0,
    })
  })

  test("expires negative entries and evicts least-recently-used entries under one global cap", async () => {
    let now = 0
    let calls = 0
    const runtime = createImageCompressionRuntime({ now: () => now })
    const negative = createSharpImageCompressionAdapter({
      ...baseOptions("negative-ttl"),
      binaryCompressor: () => {
        calls += 1
        return Promise.resolve({
          diagnostic: "decode_limit",
          status: "decode_limit" as const,
        })
      },
      runtime,
    })
    await negative.compress(inputFor("negative-ttl"))
    expect(
      expectResult(await negative.compress(inputFor("negative-ttl"))).cacheHit,
    ).toBe("negative")
    now = 51
    expect(
      expectResult(await negative.compress(inputFor("negative-ttl"))).cacheHit,
    ).toBeUndefined()
    expect(calls).toBe(2)

    const smallCacheRuntime = createImageCompressionRuntime()
    const positive = createSharpImageCompressionAdapter({
      ...baseOptions("lru"),
      binaryCompressor: (buffer) => {
        calls += 1
        return Promise.resolve({
          buffer: Buffer.from([buffer[0] ?? 0]),
          mimeType: "image/jpeg" as const,
        })
      },
      cacheBytes: 1024,
      cacheEntries: 2,
      runtime: smallCacheRuntime,
    })
    const firstInput = inputFor(`a${"x".repeat(99)}`)
    const secondInput = inputFor(`b${"x".repeat(99)}`)
    await positive.compress(firstInput)
    await positive.compress(secondInput)
    const callsBeforeRevisit = calls
    expect(
      expectResult(await positive.compress(firstInput)).cacheHit,
    ).toBeUndefined()
    expect(calls).toBe(callsBeforeRevisit + 1)
    expect(smallCacheRuntime.snapshot().cacheEntries).toBeLessThanOrEqual(2)
    expect(smallCacheRuntime.snapshot().cacheWeightBytes).toBeLessThanOrEqual(
      1024,
    )
  })

  test("shortens existing positive and negative TTLs when configuration is reduced", async () => {
    let now = 0
    const runtime = createImageCompressionRuntime({ now: () => now })
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("ttl-shrink"),
      binaryCompressor: (buffer) =>
        buffer[0] === 98 ?
          Promise.resolve({
            diagnostic: "decode_limit",
            status: "decode_limit",
          })
        : Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
      negativeCacheTtlMs: 100,
      positiveCacheTtlMs: 100,
      runtime,
    })
    await adapter.compress(inputFor(`a${"x".repeat(99)}`))
    await adapter.compress(inputFor(`b${"x".repeat(99)}`))
    expect(runtime.snapshot().positiveCacheEntries).toBeGreaterThan(0)
    expect(runtime.snapshot().negativeCacheEntries).toBe(1)

    now = 60
    createSharpImageCompressionAdapter({
      ...baseOptions("ttl-shrink"),
      binaryCompressor: () =>
        Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
      negativeCacheTtlMs: 50,
      positiveCacheTtlMs: 50,
      runtime,
    })

    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 0,
      negativeCacheEntries: 0,
      optimizedOutputEntries: 0,
      positiveCacheEntries: 0,
    })
  })

  test("charges real UTF-8 key and metadata bytes to physical cache weight", async () => {
    const runtime = createImageCompressionRuntime()
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("real-weight"),
      binaryCompressor: () =>
        Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
      cacheBytes: 128,
      runtime,
    })

    await adapter.compress(inputFor("x".repeat(100)))
    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 0,
      cacheWeightBytes: 0,
    })
  })

  test("keeps arbitrary adapter namespaces under one physical weight and entry ceiling", async () => {
    const runtime = createImageCompressionRuntime()
    for (let index = 0; index < 32; index += 1) {
      const adapter = createSharpImageCompressionAdapter({
        ...baseOptions(`account-${index}`),
        binaryCompressor: () =>
          Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
        cacheBytes: 512,
        cacheEntries: 4,
        namespace: namespace(`account-${index}`, `model-${index}`),
        runtime,
      })
      await adapter.compress(inputFor(`image-${index}-${"x".repeat(100)}`))
    }

    expect(runtime.snapshot().cacheEntries).toBeLessThanOrEqual(4)
    expect(runtime.snapshot().cacheWeightBytes).toBeLessThanOrEqual(512)
  })

  test("treats zero cache bytes as a rollback switch without disabling compression", async () => {
    const runtime = createImageCompressionRuntime()
    let calls = 0
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("cache-disabled"),
      binaryCompressor: () => {
        calls += 1
        return Promise.resolve({
          buffer: Buffer.from([1]),
          mimeType: "image/jpeg" as const,
        })
      },
      cacheBytes: 0,
      runtime,
    })
    const input = inputFor("x".repeat(100))

    expect(expectResult(await adapter.compress(input)).cacheHit).toBeUndefined()
    expect(expectResult(await adapter.compress(input)).cacheHit).toBeUndefined()
    expect(calls).toBe(2)
    expect(runtime.snapshot()).toMatchObject({
      cacheEntries: 0,
      cacheWeightBytes: 0,
    })
  })

  test("coalesces many large requests across adapters and never exceeds work caps", async () => {
    const runtime = createImageCompressionRuntime()
    let calls = 0
    let release: (() => void) | undefined
    const work = new Promise<void>((resolve) => {
      release = resolve
    })
    const compressor = async (buffer: Buffer) => {
      calls += 1
      await work
      return { buffer: Buffer.from(buffer), mimeType: "image/jpeg" as const }
    }
    const adapters = Array.from({ length: 16 }, (_, index) =>
      createSharpImageCompressionAdapter({
        ...baseOptions(`adapter-${index}`),
        binaryCompressor: compressor,
        namespace: namespace("shared-account"),
        runtime,
      }),
    )
    const requests = adapters.map((adapter) =>
      adapter.compress(inputFor("x".repeat(96))),
    )
    await Promise.resolve()

    expect(runtime.snapshot()).toMatchObject({
      activeWork: 1,
      inFlightEntries: 1,
      queuedWork: 0,
    })
    expect(runtime.snapshot().inFlightBytes).toBeLessThanOrEqual(128)
    release?.()
    await Promise.all(requests)
    expect(calls).toBe(1)
  })

  test("decodes only admitted cache misses and reports physical decode counters", async () => {
    const runtime = createImageCompressionRuntime()
    let decodedBuffers = 0
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("decode-counters"),
      binaryCompressor: () =>
        Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
      runtime,
    })
    const input = {
      ...inputFor("x".repeat(100)),
      onBase64Decoded: () => {
        decodedBuffers += 1
      },
    }

    expect(expectResult(await adapter.compress(input)).cacheHit).toBeUndefined()
    expect(decodedBuffers).toBe(1)
    expect(expectResult(await adapter.compress(input)).cacheHit).toBe(
      "positive",
    )
    expect(decodedBuffers).toBe(1)

    const capacityAdapter = createSharpImageCompressionAdapter({
      ...baseOptions("decode-capacity"),
      binaryCompressor: () =>
        Promise.resolve({ buffer: Buffer.from([1]), mimeType: "image/jpeg" }),
      maxPendingBytes: 1,
      runtime,
    })
    expect(expectResult(await capacityAdapter.compress(input)).status).toBe(
      "capacity_limit",
    )
    expect(decodedBuffers).toBe(1)
  })

  test("bounds unique queued work by count and bytes", async () => {
    const runtime = createImageCompressionRuntime()
    let release: (() => void) | undefined
    const work = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("capacity"),
      binaryCompressor: async (buffer) => {
        await work
        return { buffer, mimeType: "image/jpeg" }
      },
      maxPendingBytes: 12,
      maxPendingEntries: 2,
      runtime,
    })
    const first = adapter.compress(inputFor("123456"))
    const second = adapter.compress(inputFor("abcdef"))
    const rejected = expectResult(await adapter.compress(inputFor("overflow")))

    expect(rejected.status).toBe("capacity_limit")
    expect(rejected.diagnostic).toBe("compression_capacity_limit")
    expect(runtime.snapshot()).toMatchObject({
      activeWork: 1,
      inFlightEntries: 2,
      queuedWork: 1,
    })
    expect(runtime.snapshot().inFlightBytes).toBeLessThanOrEqual(12)
    release?.()
    await Promise.all([first, second])
  })

  test("removes aborted queued work and keeps timed-out active work coalesced until settlement", async () => {
    const runtime = createImageCompressionRuntime()
    let release: (() => void) | undefined
    const work = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("abort-timeout"),
      binaryCompressor: async (buffer) => {
        calls += 1
        await work
        return { buffer, mimeType: "image/jpeg" }
      },
      maxPendingBytes: 64,
      timeoutMs: 5,
      runtime,
    })

    const active = adapter.compress(inputFor("active"))
    const controller = new AbortController()
    const queued = adapter.compress(inputFor("queued", controller.signal))
    await Promise.resolve()
    controller.abort()
    expect(expectResult(await queued).status).toBe("aborted")
    expect(runtime.snapshot().queuedWork).toBe(0)

    expect(expectResult(await active).status).toBe("timeout")
    const duplicate = expectResult(await adapter.compress(inputFor("active")))
    expect(duplicate.status).toBe("timeout")
    expect(calls).toBe(1)
    expect(runtime.snapshot().inFlightEntries).toBe(1)

    release?.()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (runtime.snapshot().inFlightEntries === 0) break
      await Bun.sleep(1)
    }
    expect(runtime.snapshot().inFlightEntries).toBe(0)
  })

  test("times out queued work without letting it run", async () => {
    const runtime = createImageCompressionRuntime()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const activeAdapter = createSharpImageCompressionAdapter({
      ...baseOptions("queue-timeout"),
      binaryCompressor: async (buffer) => {
        calls += 1
        await gate
        return { buffer, mimeType: "image/jpeg" }
      },
      runtime,
    })
    const queuedAdapter = createSharpImageCompressionAdapter({
      ...baseOptions("queue-timeout"),
      binaryCompressor: (buffer) => {
        calls += 1
        return Promise.resolve({ buffer, mimeType: "image/jpeg" as const })
      },
      runtime,
      timeoutMs: 5,
    })

    const active = activeAdapter.compress(inputFor("active-work"))
    const queued = queuedAdapter.compress(inputFor("queued-work"))
    expect(expectResult(await queued).status).toBe("timeout")
    expect(calls).toBe(1)
    expect(runtime.snapshot().queuedWork).toBe(0)
    release?.()
    await active
  })

  test("coalesces one physical operation while callers use independent timeouts", async () => {
    const runtime = createImageCompressionRuntime()
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const compressor = async () => {
      calls += 1
      await gate
      return { buffer: Buffer.from([1]), mimeType: "image/jpeg" as const }
    }
    const short = createSharpImageCompressionAdapter({
      ...baseOptions("independent-timeouts"),
      binaryCompressor: compressor,
      runtime,
      timeoutMs: 5,
    })
    const long = createSharpImageCompressionAdapter({
      ...baseOptions("independent-timeouts"),
      binaryCompressor: compressor,
      runtime,
      timeoutMs: 1000,
    })
    const input = inputFor("x".repeat(100))

    const shortResult = short.compress(input)
    const longResult = long.compress(input)
    expect(expectResult(await shortResult).status).toBe("timeout")
    expect(calls).toBe(1)
    release?.()
    expect(expectResult(await longResult).status).toBe("compressed")
    expect(calls).toBe(1)
  })

  test("does not reuse compact no-smaller negatives for CRLF-expanded wire input", async () => {
    const runtime = createImageCompressionRuntime()
    let calls = 0
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("crlf-negative"),
      binaryCompressor: () => {
        calls += 1
        return Promise.resolve({
          buffer: Buffer.alloc(30),
          mimeType: "image/jpeg" as const,
        })
      },
      runtime,
    })
    const binary = Buffer.alloc(30, 1)
    const compactBase64 = binary.toString("base64")
    const expandedBase64 = compactBase64.match(/.{1,4}/gu)?.join("\r\n") ?? ""
    const compact = {
      ...inputFor("unused"),
      dataUrl: `data:image/png;base64,${compactBase64}`,
      decodedBytes: binary.byteLength,
    }
    const expanded = {
      ...compact,
      dataUrl: `data:image/png;base64,${expandedBase64}`,
    }

    expect(expectResult(await adapter.compress(compact)).status).toBe(
      "no_smaller",
    )
    const expandedResult = expectResult(await adapter.compress(expanded))
    expect(expandedResult.status).toBe("compressed")
    expect(expandedResult.cacheHit).toBeUndefined()
    expect(calls).toBe(2)
  })

  test("skips recompression only for matching format, policy, detail, and componentwise profile", async () => {
    const runtime = createImageCompressionRuntime()
    let calls = 0
    const compressor = () => {
      calls += 1
      return Promise.resolve({
        buffer: Buffer.from([1]),
        mimeType: "image/jpeg" as const,
      })
    }
    const original = {
      ...inputFor("x".repeat(100)),
      profile: {
        ...profile,
        detail: "high" as const,
        jpegQuality: 80,
        maxLongEdge: 1000,
      },
    }
    const jpeg = createSharpImageCompressionAdapter({
      ...baseOptions("marker-profile"),
      binaryCompressor: compressor,
      format: "jpeg",
      runtime,
    })
    const first = expectResult(await jpeg.compress(original))
    const optimized = {
      ...original,
      dataUrl: first.output?.dataUrl ?? "",
      decodedBytes: 1,
      mimeType: "image/jpeg",
    }

    expect(
      expectResult(
        await jpeg.compress({
          ...optimized,
          profile: { ...optimized.profile, jpegQuality: 90, maxLongEdge: 1200 },
        }),
      ).status,
    ).toBe("already_optimized")
    expect(calls).toBe(1)

    expect(
      expectResult(
        await jpeg.compress({
          ...optimized,
          profile: { ...optimized.profile, jpegQuality: 90, maxLongEdge: 900 },
        }),
      ).status,
    ).not.toBe("already_optimized")
    expect(calls).toBe(2)

    const webp = createSharpImageCompressionAdapter({
      ...baseOptions("marker-profile"),
      binaryCompressor: compressor,
      format: "webp",
      runtime,
    })
    expect(expectResult(await webp.compress(optimized)).status).not.toBe(
      "already_optimized",
    )
    expect(calls).toBe(3)

    const differentPolicy = createSharpImageCompressionAdapter({
      ...baseOptions("marker-profile"),
      binaryCompressor: compressor,
      decodeMaxPixels: 1234,
      format: "jpeg",
      runtime,
    })
    expect(
      expectResult(await differentPolicy.compress(optimized)).status,
    ).not.toBe("already_optimized")
    expect(calls).toBe(4)

    expect(
      expectResult(
        await jpeg.compress({
          ...optimized,
          profile: { ...optimized.profile, detail: "low" },
        }),
      ).status,
    ).not.toBe("already_optimized")
    expect(calls).toBe(5)
  })

  test("uses a second private verifier so primary-key collisions remain content safe", async () => {
    const runtime = createImageCompressionRuntime({
      derivePrimaryKey: () => "forced-collision",
    })
    let calls = 0
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("collision"),
      binaryCompressor: (buffer) => {
        calls += 1
        return Promise.resolve({
          buffer: Buffer.from(buffer[0] === 97 ? "A" : "B"),
          mimeType: "image/jpeg" as const,
        })
      },
      runtime,
    })

    const alphaInput = `a${"x".repeat(99)}`
    const betaInput = `b${"x".repeat(99)}`
    const alpha = expectResult(await adapter.compress(inputFor(alphaInput)))
    const beta = expectResult(await adapter.compress(inputFor(betaInput)))
    expect(alpha.output?.dataUrl).not.toBe(beta.output?.dataUrl)
    expect(calls).toBe(2)
    expect(
      expectResult(await adapter.compress(inputFor(alphaInput))).cacheHit,
    ).toBe("positive")
    expect(calls).toBe(2)
  })

  test("diagnostics and snapshots expose only bounded aggregate metadata", async () => {
    const runtime = createImageCompressionRuntime()
    const secret = "short-private-media"
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("private-account"),
      binaryCompressor: () =>
        Promise.resolve({
          diagnostic: `failed ${secret} data:image/png;base64,${Buffer.from(secret).toString("base64")}`,
          diagnosticDetail: {
            message: secret,
            stage: "test",
          },
          status: "decode_limit" as const,
        }),
      runtime,
    })

    const result = expectResult(await adapter.compress(inputFor(secret)))
    const serialized = JSON.stringify({ result, snapshot: runtime.snapshot() })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("private-account")
    expect(result.diagnosticDetail?.message?.length).toBeLessThanOrEqual(600)
  })

  test("converts unexpected worker failures into content-free adapter diagnostics", async () => {
    const runtime = createImageCompressionRuntime()
    const secret = "worker-private-content"
    const adapter = createSharpImageCompressionAdapter({
      ...baseOptions("worker-failure"),
      binaryCompressor: () => Promise.reject(new Error(secret)),
      runtime,
    })

    const result = expectResult(await adapter.compress(inputFor(secret)))
    expect(result).toMatchObject({
      diagnostic: "compression_work_failed",
      diagnosticDetail: { name: "Error", stage: "runtime" },
      status: "adapter_error",
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})
