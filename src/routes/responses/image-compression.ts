import { createHash } from "node:crypto"

import type { Metadata } from "sharp"

import type {
  ImageCompressionAdapter,
  ImageCompressionDiagnosticDetail,
  ImageCompressionInput,
  ImageCompressionOutput,
  ImageCompressionResult,
  ImageCompressionStatus,
} from "./utils"

type Sharp = typeof import("sharp").default

export interface SharpImageCompressionAdapterOptions {
  cacheBytes: number
  cacheEntries: number
  concurrency: number
  decodeMaxBytesEstimate?: number
  decodeMaxFrames?: number
  decodeMaxLongEdge?: number
  decodeMaxPixels?: number
  format: "jpeg" | "webp" | "auto"
  namespace: string
  timeoutMs: number
}

interface CacheEntry {
  output: ImageCompressionOutput
  size: number
}

interface NegativeCacheEntry {
  diagnostic?: string
  diagnosticDetail?: ImageCompressionDiagnosticDetail
  inputBytes?: number
  outputBytes?: number
  status: NegativeCacheStatus
}

type NegativeCacheStatus = "already_optimized" | "decode_limit" | "no_smaller"

const OPTIMIZER_VERSION = "responses-image-v1"
const DATA_URL_PATTERN =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/u
const OPTIMIZED_OUTPUT_RECORD_LIMIT = 4096
const PROFILE_RANK: Record<ImageCompressionInput["profile"]["name"], number> = {
  "latest-soft": 1,
  "history-soft": 2,
  "latest-hard": 3,
  "history-hard": 4,
  "latest-extreme": 5,
  "history-extreme": 6,
}

let sharpImportPromise: Promise<Sharp | null> | undefined
let sharpImportError: unknown
let globalSemaphore: CompressionSemaphore | undefined
let globalSemaphoreConcurrency = 0
const optimizedOutputRanks = new Map<string, number>()

export const createSharpImageCompressionAdapter = (
  options: SharpImageCompressionAdapterOptions,
): ImageCompressionAdapter => {
  const cache = new LruCache(options.cacheEntries, options.cacheBytes)
  const negativeCache = new NegativeLruCache(
    Math.max(options.cacheEntries * 4, 512),
  )
  const semaphore = getGlobalSemaphore(options.concurrency)
  const inFlight = new Map<string, Promise<ImageCompressionResult>>()

  return {
    async compress(input) {
      const startedAt = Date.now()
      const parsed = parseDataUrl(input.dataUrl)
      if (!parsed) {
        return createCompressionResult("invalid_data_url", startedAt, {
          inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
        })
      }

      if (
        isAlreadyOptimizedForProfile(options.namespace, input, parsed.buffer)
      ) {
        return createCompressionResult("already_optimized", startedAt, {
          inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
        })
      }

      const key = createCacheKey(options.namespace, input, parsed.buffer)
      const cached = cache.get(key)
      if (cached) {
        return createCompressionResult("compressed", startedAt, {
          cacheHit: "positive",
          inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
          output: cached,
          outputBytes: cached.outputBytes,
        })
      }

      const negativeCached = negativeCache.get(key)
      if (negativeCached) {
        return createCompressionResult(negativeCached.status, startedAt, {
          cacheHit: "negative",
          diagnostic: negativeCached.diagnostic,
          diagnosticDetail: negativeCached.diagnosticDetail,
          inputBytes: negativeCached.inputBytes,
          outputBytes: negativeCached.outputBytes,
        })
      }

      const running = inFlight.get(key)
      if (running) {
        return await running
      }

      const createTimeoutResult = (): ImageCompressionResult =>
        createCompressionResult("timeout", startedAt, {
          diagnostic: "compression_timeout",
          diagnosticDetail: {
            message: `Compression exceeded ${options.timeoutMs}ms timeout.`,
            stage: "timeout",
          },
        })
      const abortController = new AbortController()
      const operation = semaphore
        .run(async () => {
          const result = await compressWithSharp(
            parsed.buffer,
            input,
            options,
            startedAt,
          )
          if (result.output) {
            if (result.output.outputBytes < Buffer.byteLength(input.dataUrl)) {
              registerOptimizedOutput(options.namespace, input, result.output)
              cache.set(key, result.output)
              return result
            }

            const noSmallerResult = createCompressionResult(
              "no_smaller",
              startedAt,
              {
                inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
                diagnostic: "no_smaller_output",
                outputBytes: result.output.outputBytes,
              },
            )
            negativeCache.set(key, {
              diagnostic: noSmallerResult.diagnostic,
              diagnosticDetail: noSmallerResult.diagnosticDetail,
              inputBytes: noSmallerResult.inputBytes,
              outputBytes: noSmallerResult.outputBytes,
              status: "no_smaller",
            })
            return noSmallerResult
          }

          if (isNegativeCacheableStatus(result.status)) {
            negativeCache.set(key, {
              diagnostic: result.diagnostic,
              diagnosticDetail: result.diagnosticDetail,
              inputBytes: result.inputBytes,
              outputBytes: result.outputBytes,
              status: result.status,
            })
          }
          return result
        }, abortController.signal)
        .catch((error: unknown) => {
          if (isAbortError(error)) {
            return createTimeoutResult()
          }
          throw error
        })
      const promise = withTimeout(operation, options.timeoutMs, () =>
        abortController.abort(),
      ).then((result) => result ?? createTimeoutResult())
      const clearInFlight = () => {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
      void operation.then(clearInFlight, clearInFlight)

      inFlight.set(key, promise)
      return await promise
    },
  }
}

const compressWithSharp = async (
  buffer: Buffer,
  input: ImageCompressionInput,
  options: SharpImageCompressionAdapterOptions,
  startedAt: number,
): Promise<ImageCompressionResult> => {
  const inputBytes = Buffer.byteLength(input.dataUrl, "utf8")
  const sharp = await loadSharp()
  if (!sharp) {
    return createCompressionResult("adapter_error", startedAt, {
      diagnostic: "sharp_import_failed",
      diagnosticDetail: createErrorDiagnosticDetail(sharpImportError, "import"),
      inputBytes,
    })
  }

  let metadata: Metadata
  try {
    const base = sharp(buffer, {
      limitInputPixels: options.decodeMaxPixels ?? 67_108_864,
    })
    metadata = await base.metadata()
  } catch (error) {
    return createSharpFailureResult(error, "metadata", startedAt, inputBytes)
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) {
    return createCompressionResult("decode_limit", startedAt, {
      diagnostic: "missing_image_dimensions",
      diagnosticDetail: {
        message: `metadata width=${width} height=${height}`,
        stage: "metadata",
      },
      inputBytes,
    })
  }
  if (!isMetadataWithinSafetyLimits(metadata, options)) {
    return createCompressionResult("decode_limit", startedAt, {
      diagnostic: "decode_safety_limit",
      diagnosticDetail: {
        message: createDecodeSafetyLimitMessage(metadata, options),
        stage: "metadata",
      },
      inputBytes,
    })
  }

  const resizeOptions =
    Math.max(width, height) > input.profile.maxLongEdge ?
      {
        fit: "inside" as const,
        height: input.profile.maxLongEdge,
        width: input.profile.maxLongEdge,
        withoutEnlargement: true,
      }
    : undefined

  try {
    const pipeline = sharp(buffer, {
      limitInputPixels: options.decodeMaxPixels ?? 67_108_864,
    }).rotate()

    if (metadata.hasAlpha) {
      pipeline.flatten({ background: "#fff" })
    }

    if (resizeOptions) {
      pipeline.resize(resizeOptions)
    }

    const jpegPromise = async (): Promise<Buffer> =>
      await pipeline
        .clone()
        .jpeg({
          chromaSubsampling: "4:4:4",
          mozjpeg: true,
          quality: input.profile.jpegQuality,
        })
        .toBuffer()

    const webpPromise = async (): Promise<Buffer> =>
      await pipeline
        .clone()
        .webp({
          effort: 4,
          preset: "text",
          quality: input.profile.jpegQuality,
          smartSubsample: true,
        })
        .toBuffer()

    if (options.format === "webp") {
      const output = createDataUrlOutput("image/webp", await webpPromise())
      return createCompressionResult("compressed", startedAt, {
        inputBytes,
        output,
        outputBytes: output.outputBytes,
      })
    }

    if (options.format === "auto") {
      const [jpeg, webp] = await Promise.all([jpegPromise(), webpPromise()])
      const output =
        webp.byteLength < jpeg.byteLength ?
          createDataUrlOutput("image/webp", webp)
        : createDataUrlOutput("image/jpeg", jpeg)
      return createCompressionResult("compressed", startedAt, {
        inputBytes,
        output,
        outputBytes: output.outputBytes,
      })
    }

    const output = createDataUrlOutput("image/jpeg", await jpegPromise())
    return createCompressionResult("compressed", startedAt, {
      inputBytes,
      output,
      outputBytes: output.outputBytes,
    })
  } catch (error) {
    return createSharpFailureResult(error, "encode", startedAt, inputBytes)
  }
}

const createSharpFailureResult = (
  error: unknown,
  stage: string,
  startedAt: number,
  inputBytes: number,
): ImageCompressionResult => {
  const diagnostic = classifySharpFailure(error, stage)
  return createCompressionResult(diagnostic.status, startedAt, {
    diagnostic: diagnostic.diagnostic,
    diagnosticDetail: createErrorDiagnosticDetail(error, stage),
    inputBytes,
  })
}

const classifySharpFailure = (
  error: unknown,
  stage: string,
): { diagnostic: string; status: ImageCompressionStatus } => {
  const text = getErrorSearchText(error)
  if (
    text.includes("pixel")
    && (text.includes("limit") || text.includes("exceed"))
  ) {
    return { diagnostic: "pixel_limit_exceeded", status: "decode_limit" }
  }

  if (
    stage === "metadata"
    && (text.includes("unsupported")
      || text.includes("unknown")
      || text.includes("corrupt")
      || text.includes("invalid")
      || text.includes("decode"))
  ) {
    return { diagnostic: "metadata_decode_failed", status: "decode_limit" }
  }

  if (stage === "metadata") {
    return { diagnostic: "metadata_failed", status: "adapter_error" }
  }

  if (
    text.includes("unsupported")
    || text.includes("unknown")
    || text.includes("corrupt")
    || text.includes("invalid")
  ) {
    return { diagnostic: "encode_input_decode_failed", status: "decode_limit" }
  }

  return { diagnostic: "encode_failed", status: "adapter_error" }
}

const createErrorDiagnosticDetail = (
  error: unknown,
  stage: string,
): ImageCompressionDiagnosticDetail => {
  const detail: ImageCompressionDiagnosticDetail = { stage }
  if (error instanceof Error) {
    detail.name = truncateDiagnosticText(error.name, 80)
    detail.message = truncateDiagnosticText(
      redactDiagnosticText(error.message),
      600,
    )
    detail.stack = truncateDiagnosticText(
      redactDiagnosticText(error.stack),
      1600,
    )
    const errorWithCode = error as Error & { code?: unknown }
    if (typeof errorWithCode.code === "string") {
      detail.code = truncateDiagnosticText(errorWithCode.code, 80)
    }
    return detail
  }

  detail.message = truncateDiagnosticText(
    redactDiagnosticText(String(error)),
    600,
  )
  return detail
}

const getErrorSearchText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${error.stack ?? ""}`.toLowerCase()
  }
  return String(error).toLowerCase()
}

const redactDiagnosticText = (value: string | undefined): string | undefined =>
  value
    ?.replaceAll(
      /data:[^,\s]+;base64,[A-Za-z0-9+/=_-]+/giu,
      "[redacted-data-url]",
    )
    .replaceAll(/[A-Za-z0-9+/=_-]{256,}/gu, "[redacted-long-token]")

const truncateDiagnosticText = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  if (!value) {
    return undefined
  }
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}...<truncated>`
}

const createDecodeSafetyLimitMessage = (
  metadata: Metadata,
  options: SharpImageCompressionAdapterOptions,
): string => {
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const pages = metadata.pages ?? 1
  const channels = metadata.channels ?? (metadata.hasAlpha ? 4 : 3)
  const decodedBytesEstimate = width * height * channels * pages
  return [
    `width=${width}`,
    `height=${height}`,
    `pages=${pages}`,
    `channels=${channels}`,
    `decodedBytesEstimate=${decodedBytesEstimate}`,
    `maxPixels=${options.decodeMaxPixels ?? 67_108_864}`,
    `maxLongEdge=${options.decodeMaxLongEdge ?? "unset"}`,
    `maxFrames=${options.decodeMaxFrames ?? "unset"}`,
    `maxBytesEstimate=${options.decodeMaxBytesEstimate ?? "unset"}`,
  ].join(" ")
}

const createCompressionResult = (
  status: ImageCompressionStatus,
  startedAt: number,
  options: {
    cacheHit?: ImageCompressionResult["cacheHit"]
    diagnostic?: string
    diagnosticDetail?: ImageCompressionDiagnosticDetail
    inputBytes?: number
    output?: ImageCompressionOutput
    outputBytes?: number
  } = {},
): ImageCompressionResult => ({
  ...options,
  elapsedMs: Math.max(0, Date.now() - startedAt),
  status,
})

const isNegativeCacheableStatus = (
  status: ImageCompressionStatus,
): status is NegativeCacheStatus =>
  status === "already_optimized"
  || status === "decode_limit"
  || status === "no_smaller"

const isMetadataWithinSafetyLimits = (
  metadata: Metadata,
  options: SharpImageCompressionAdapterOptions,
): boolean => {
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const maxLongEdge = options.decodeMaxLongEdge
  if (
    typeof maxLongEdge === "number"
    && maxLongEdge > 0
    && Math.max(width, height) > maxLongEdge
  ) {
    return false
  }

  const pages = metadata.pages ?? 1
  const maxFrames = options.decodeMaxFrames
  if (typeof maxFrames === "number" && maxFrames > 0 && pages > maxFrames) {
    return false
  }

  const channels = metadata.channels ?? (metadata.hasAlpha ? 4 : 3)
  const decodedBytesEstimate = width * height * channels * pages
  const maxBytesEstimate = options.decodeMaxBytesEstimate
  if (
    typeof maxBytesEstimate === "number"
    && maxBytesEstimate > 0
    && decodedBytesEstimate > maxBytesEstimate
  ) {
    return false
  }

  return true
}

const createDataUrlOutput = (
  mimeType: "image/jpeg" | "image/webp",
  buffer: Buffer,
): ImageCompressionOutput => {
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`
  return {
    dataUrl,
    outputBytes: Buffer.byteLength(dataUrl, "utf8"),
  }
}

const parseDataUrl = (
  value: string,
): { buffer: Buffer; mimeType: string } | null => {
  const match = DATA_URL_PATTERN.exec(value)
  if (!match) {
    return null
  }

  return {
    buffer: Buffer.from(match[2].replaceAll(/\s+/g, ""), "base64"),
    mimeType: match[1],
  }
}

const loadSharp = async (): Promise<Sharp | null> => {
  sharpImportPromise ??= import("sharp")
    .then((module) => module.default)
    .catch((error: unknown) => {
      sharpImportError = error
      return null
    })
  return await sharpImportPromise
}

const getGlobalSemaphore = (concurrency: number): CompressionSemaphore => {
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency))
  if (
    !globalSemaphore
    || globalSemaphoreConcurrency !== normalizedConcurrency
  ) {
    globalSemaphore = new CompressionSemaphore(normalizedConcurrency)
    globalSemaphoreConcurrency = normalizedConcurrency
  }
  return globalSemaphore
}

const isAlreadyOptimizedForProfile = (
  namespace: string,
  input: ImageCompressionInput,
  buffer: Buffer,
): boolean => {
  const previousRank = optimizedOutputRanks.get(
    createMediaIdentityKey(namespace, buffer),
  )
  return (
    previousRank !== undefined
    && previousRank >= getProfileRank(input.profile.name)
  )
}

const registerOptimizedOutput = (
  namespace: string,
  input: ImageCompressionInput,
  output: ImageCompressionOutput,
): void => {
  const parsed = parseDataUrl(output.dataUrl)
  if (!parsed) {
    return
  }

  const key = createMediaIdentityKey(namespace, parsed.buffer)
  optimizedOutputRanks.delete(key)
  optimizedOutputRanks.set(key, getProfileRank(input.profile.name))

  while (optimizedOutputRanks.size > OPTIMIZED_OUTPUT_RECORD_LIMIT) {
    const firstKey = optimizedOutputRanks.keys().next().value
    if (!firstKey) {
      return
    }
    optimizedOutputRanks.delete(firstKey)
  }
}

const getProfileRank = (
  profileName: ImageCompressionInput["profile"]["name"],
): number => PROFILE_RANK[profileName]

const createCacheKey = (
  namespace: string,
  input: ImageCompressionInput,
  buffer: Buffer,
): string => {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(input.mimeType)
    .update("\0")
    .update(createBinaryHash(buffer))
    .update("\0")
    .update(JSON.stringify(input.profile))
    .update("\0")
    .update(OPTIMIZER_VERSION)
    .digest("hex")
}

const createMediaIdentityKey = (namespace: string, buffer: Buffer): string =>
  createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(createBinaryHash(buffer))
    .update("\0")
    .update(OPTIMIZER_VERSION)
    .digest("hex")

const createBinaryHash = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex")

class LruCache {
  private entries = new Map<string, CacheEntry>()
  private readonly maxBytes: number
  private readonly maxEntries: number
  private totalBytes = 0

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get(key: string): ImageCompressionOutput | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.output
  }

  set(key: string, output: ImageCompressionOutput): void {
    const size = output.outputBytes
    if (this.maxEntries <= 0 || this.maxBytes <= 0 || size > this.maxBytes) {
      return
    }

    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.size
      this.entries.delete(key)
    }

    this.entries.set(key, { output, size })
    this.totalBytes += size
    this.evict()
  }

  private evict(): void {
    while (
      this.entries.size > this.maxEntries
      || this.totalBytes > this.maxBytes
    ) {
      const firstKey = this.entries.keys().next().value
      if (!firstKey) {
        return
      }
      const first = this.entries.get(firstKey)
      if (first) {
        this.totalBytes -= first.size
      }
      this.entries.delete(firstKey)
    }
  }
}

class NegativeLruCache {
  private entries = new Map<string, NegativeCacheEntry>()
  private readonly maxEntries: number

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries
  }

  get(key: string): NegativeCacheEntry | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: NegativeCacheEntry): void {
    if (this.maxEntries <= 0) {
      return
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    this.evict()
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value
      if (!firstKey) {
        return
      }
      this.entries.delete(firstKey)
    }
  }
}

interface SemaphoreWaiter {
  abort?: () => void
  reject: (error: Error) => void
  resolve: () => void
  signal?: AbortSignal
}

export class CompressionSemaphore {
  private active = 0
  private readonly limit: number
  private readonly queue: Array<SemaphoreWaiter> = []

  constructor(limit: number) {
    this.limit = limit
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw createAbortError()
    }

    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        reject,
        resolve,
        signal,
      }
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) {
            this.queue.splice(index, 1)
          }
          reject(createAbortError())
        }
        signal.addEventListener("abort", waiter.abort, { once: true })
      }
      this.queue.push(waiter)
    })
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const waiter = this.queue.shift()
    if (!waiter) {
      return
    }

    if (waiter.abort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.abort)
    }
    waiter.resolve()
  }
}

const createAbortError = (): Error => {
  const error = new Error("Semaphore acquisition aborted")
  error.name = "AbortError"
  return error
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null)
          onTimeout?.()
        }, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
