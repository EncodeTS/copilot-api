import type { Metadata } from "sharp"

import type {
  ImageCompressionAdapter,
  ImageCompressionDiagnosticDetail,
  ImageCompressionInput,
  ImageCompressionOutput,
  ImageCompressionResult,
  ImageCompressionStatus,
} from "./utils"
import {
  type BinaryImageCompressionResult,
  type ImageCompressionNamespace,
  type ImageCompressionRuntime,
  processImageCompressionRuntime,
} from "./image-compression-runtime"

type Sharp = typeof import("sharp").default

export interface SharpImageCompressionAdapterOptions {
  binaryCompressor?: (
    buffer: Buffer,
    input: ImageCompressionInput,
    signal: AbortSignal,
  ) => Promise<BinaryImageCompressionResult>
  cacheBytes: number
  cacheEntries: number
  concurrency: number
  decodeMaxBytesEstimate?: number
  decodeMaxFrames?: number
  decodeMaxLongEdge?: number
  decodeMaxPixels?: number
  format: "jpeg" | "webp" | "auto"
  maxPendingBytes?: number
  maxPendingEntries?: number
  namespace: ImageCompressionNamespace
  negativeCacheTtlMs?: number
  positiveCacheTtlMs?: number
  runtime?: ImageCompressionRuntime
  timeoutMs: number
}

const OPTIMIZER_VERSION = "responses-image-v1"
const DATA_URL_PATTERN =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/u
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_PENDING_ENTRIES = 64
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 30_000
const DEFAULT_POSITIVE_CACHE_TTL_MS = 10 * 60_000

let sharpImportPromise: Promise<Sharp | null> | undefined
let sharpImportError: unknown

export const createSharpImageCompressionAdapter = (
  options: SharpImageCompressionAdapterOptions,
): ImageCompressionAdapter => {
  const runtime = options.runtime ?? processImageCompressionRuntime
  const namespace = options.namespace
  runtime.configure({
    cacheBytes: options.cacheBytes,
    cacheEntries: options.cacheEntries,
    concurrency: options.concurrency,
    maxPendingBytes: options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
    maxPendingEntries: options.maxPendingEntries ?? DEFAULT_MAX_PENDING_ENTRIES,
    negativeCacheTtlMs:
      options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
    positiveCacheTtlMs:
      options.positiveCacheTtlMs ?? DEFAULT_POSITIVE_CACHE_TTL_MS,
  })

  return {
    async compress(input) {
      const startedAt = Date.now()
      const parsed = parseDataUrl(input.dataUrl)
      if (!parsed) {
        return createCompressionResult("invalid_data_url", startedAt, {
          inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
        })
      }
      const result = await runtime.run({
        contentBytes: parsed.decodedBytes,
        contentIdentity: parsed.base64Payload,
        format: options.format,
        inputBytes: Buffer.byteLength(input.dataUrl, "utf8"),
        mimeType: parsed.mimeType,
        namespace,
        optimizerVersion: OPTIMIZER_VERSION,
        policyKey: createCompressionPolicyKey(options),
        profile: input.profile,
        signal: input.signal,
        sourceDetail: input.detail,
        timeoutMs: options.timeoutMs,
        work: async (signal) => {
          const buffer = Buffer.from(
            parsed.base64Payload.replaceAll(/\s+/g, ""),
            "base64",
          )
          input.onBase64Decoded?.()
          if (options.binaryCompressor) {
            return await options.binaryCompressor(buffer, input, signal)
          }
          return await compressWithSharp(buffer, input, options, signal)
        },
      })
      if (!result.binaryOutput) {
        return result
      }
      const { binaryOutput, ...publicResult } = result
      const output = createDataUrlOutput(
        binaryOutput.mimeType,
        binaryOutput.buffer,
      )
      return {
        ...publicResult,
        elapsedMs: Math.max(result.elapsedMs ?? 0, Date.now() - startedAt),
        output,
        outputBytes: output.outputBytes,
      }
    },
  }
}

const compressWithSharp = async (
  buffer: Buffer,
  input: ImageCompressionInput,
  options: SharpImageCompressionAdapterOptions,
  signal: AbortSignal,
): Promise<BinaryImageCompressionResult> => {
  throwIfAborted(signal)
  const sharp = await loadSharp()
  if (!sharp) {
    return {
      diagnostic: "sharp_import_failed",
      diagnosticDetail: createErrorDiagnosticDetail(sharpImportError, "import"),
      status: "adapter_error",
    }
  }

  let metadata: Metadata
  try {
    const base = sharp(buffer, {
      limitInputPixels: options.decodeMaxPixels ?? 67_108_864,
    })
    metadata = await base.metadata()
    throwIfAborted(signal)
  } catch (error) {
    return createSharpFailureResult(error, "metadata")
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) {
    return {
      diagnostic: "missing_image_dimensions",
      diagnosticDetail: {
        message: `metadata width=${width} height=${height}`,
        stage: "metadata",
      },
      status: "decode_limit",
    }
  }
  if (!isMetadataWithinSafetyLimits(metadata, options)) {
    return {
      diagnostic: "decode_safety_limit",
      diagnosticDetail: {
        message: createDecodeSafetyLimitMessage(metadata, options),
        stage: "metadata",
      },
      status: "decode_limit",
    }
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
      const output = await webpPromise()
      throwIfAborted(signal)
      return { buffer: output, mimeType: "image/webp" }
    }

    if (options.format === "auto") {
      const [jpeg, webp] = await Promise.all([jpegPromise(), webpPromise()])
      throwIfAborted(signal)
      return webp.byteLength < jpeg.byteLength ?
          { buffer: webp, mimeType: "image/webp" }
        : { buffer: jpeg, mimeType: "image/jpeg" }
    }

    const output = await jpegPromise()
    throwIfAborted(signal)
    return { buffer: output, mimeType: "image/jpeg" }
  } catch (error) {
    return createSharpFailureResult(error, "encode")
  }
}

const createSharpFailureResult = (
  error: unknown,
  stage: string,
): BinaryImageCompressionResult => {
  if (isAbortError(error)) {
    return { diagnostic: "compression_aborted", status: "aborted" }
  }
  const diagnostic = classifySharpFailure(error, stage)
  return {
    diagnostic: diagnostic.diagnostic,
    diagnosticDetail: createErrorDiagnosticDetail(error, stage),
    status: diagnostic.status,
  }
}

const classifySharpFailure = (
  error: unknown,
  stage: string,
): {
  diagnostic: string
  status: Exclude<ImageCompressionStatus, "compressed">
} => {
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
    detail.message = truncateDiagnosticText(error.message, 600)
    detail.stack = truncateDiagnosticText(error.stack, 1600)
    const errorWithCode = error as Error & { code?: unknown }
    if (typeof errorWithCode.code === "string") {
      detail.code = truncateDiagnosticText(errorWithCode.code, 80)
    }
    return detail
  }

  detail.message = truncateDiagnosticText(String(error), 600)
  return detail
}

const getErrorSearchText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${error.stack ?? ""}`.toLowerCase()
  }
  return String(error).toLowerCase()
}

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
): { base64Payload: string; decodedBytes: number; mimeType: string } | null => {
  const match = DATA_URL_PATTERN.exec(value)
  if (!match) {
    return null
  }

  const base64Payload = match[2]
  return {
    base64Payload,
    decodedBytes: calculateDecodedBase64Bytes(base64Payload),
    mimeType: match[1],
  }
}

const calculateDecodedBase64Bytes = (value: string): number => {
  let encodedCharacters = 0
  let paddingCharacters = 0
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index]
    if (character === "\r" || character === "\n") continue
    if (encodedCharacters < 2 && character === "=") paddingCharacters += 1
    encodedCharacters += 1
  }
  return Math.max(
    0,
    Math.floor((encodedCharacters * 3) / 4) - paddingCharacters,
  )
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

const createCompressionPolicyKey = (
  options: SharpImageCompressionAdapterOptions,
): string =>
  JSON.stringify({
    decodeMaxBytesEstimate: options.decodeMaxBytesEstimate,
    decodeMaxFrames: options.decodeMaxFrames,
    decodeMaxLongEdge: options.decodeMaxLongEdge,
    decodeMaxPixels: options.decodeMaxPixels,
  })

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw createAbortError()
}

const createAbortError = (): Error => {
  const error = new Error("Image compression aborted")
  error.name = "AbortError"
  return error
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"
