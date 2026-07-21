import { Buffer } from "node:buffer"

import { inspectBase64, parseDataUrl } from "~/lib/media-facts/base64"
import { probeImageMetadata } from "~/lib/media-facts/image-metadata"
import type {
  FileDetail,
  ImageDetail,
  CollectMediaFactsOptions,
  MediaFact,
  MediaFactDescriptor,
  MediaFactWarning,
  MediaPathSegment,
} from "~/lib/media-facts/types"

const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u
const MAX_MIME_LENGTH = 127
const SAFE_MIME_TYPES = new Map<string, string>([
  ["application/pdf", "application/pdf"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/mpeg", "audio/mpeg"],
  ["audio/wav", "audio/wav"],
  ["image/gif", "image/gif"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/webp", "image/webp"],
])

type ImageProbeOptions = Pick<
  CollectMediaFactsOptions,
  "onBase64Decode" | "probeImageHeaders"
>

const createImageProbe = (
  descriptor: MediaFactDescriptor,
  encoded: string,
  decodedBytes: number | undefined,
  mimeType: string | undefined,
  options?: ImageProbeOptions,
) => {
  if (
    descriptor.mediaKind !== "image"
    || decodedBytes === undefined
    || options?.probeImageHeaders === false
  ) {
    return undefined
  }
  options?.onBase64Decode?.()
  return probeImageMetadata(encoded, decodedBytes, mimeType)
}

const contentFreeFact = (
  descriptor: MediaFactDescriptor,
): Pick<
  MediaFact,
  "carrier" | "contentFree" | "detail" | "mediaKind" | "path" | "protocol"
> => ({
  carrier: descriptor.carrier,
  contentFree: true,
  ...(descriptor.detail ? { detail: descriptor.detail } : {}),
  mediaKind: descriptor.mediaKind,
  path: descriptor.path,
  protocol: descriptor.protocol,
})

const canonicalizeMimeType = (
  value: string | undefined,
): { mimeType?: string; warnings: Array<MediaFactWarning> } => {
  if (value === undefined || value.trim().length === 0) {
    return { warnings: ["unknown_mime_type"] }
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length > MAX_MIME_LENGTH || !MIME_PATTERN.test(normalized)) {
    return { warnings: ["invalid_mime_type"] }
  }
  const canonical = SAFE_MIME_TYPES.get(normalized)
  if (!canonical) return { warnings: ["unsupported_mime_type"] }
  return {
    mimeType: canonical,
    warnings: [],
  }
}

export const getResponsesImageDetail = (
  detail: unknown,
): ImageDetail | undefined =>
  (
    detail === "original"
    || detail === "auto"
    || detail === "high"
    || detail === "low"
  ) ?
    detail
  : undefined

export const getChatImageDetail = (detail: unknown): FileDetail | undefined =>
  detail === "auto" || detail === "high" || detail === "low" ?
    detail
  : undefined

export const getResponsesFileDetail = (
  detail: unknown,
): FileDetail | undefined =>
  detail === "auto" || detail === "high" || detail === "low" ?
    detail
  : undefined

export const getAudioMimeType = (format: unknown): string | undefined => {
  if (typeof format !== "string") return undefined
  const known: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
  }
  return known[format.trim().toLowerCase()]
}

export const createRemoteUrlFact = (
  descriptor: MediaFactDescriptor,
  value: string,
): MediaFact => {
  let validRemoteUrl = false
  try {
    const url = new URL(value)
    validRemoteUrl = url.protocol === "http:" || url.protocol === "https:"
  } catch {
    validRemoteUrl = false
  }
  return {
    ...contentFreeFact(descriptor),
    encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
    referenceKind: validRemoteUrl ? "remote-url" : "unknown",
    warnings: [
      validRemoteUrl ? "unknown_mime_type" : "invalid_media_reference",
    ],
  }
}

export const createDataUrlFact = (
  descriptor: MediaFactDescriptor,
  value: string,
  options?: ImageProbeOptions,
): MediaFact | null => {
  const parsed = parseDataUrl(value)
  if (!parsed) return null
  const mime = canonicalizeMimeType(parsed.mimeType)
  if (parsed.kind === "invalid") {
    return {
      ...contentFreeFact(descriptor),
      encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
      ...(mime.mimeType ? { mimeType: mime.mimeType } : {}),
      referenceKind: "data-url",
      warnings: [parsed.warning, ...mime.warnings],
    }
  }

  const base64 = inspectBase64(parsed.payload)
  const imageProbe = createImageProbe(
    descriptor,
    parsed.payload,
    base64.facts.decodedBytes,
    mime.mimeType,
    options,
  )
  return {
    ...contentFreeFact(descriptor),
    base64: base64.facts,
    encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
    ...(imageProbe?.image ? { image: imageProbe.image } : {}),
    ...(mime.mimeType ? { mimeType: mime.mimeType } : {}),
    referenceKind: "data-url",
    warnings: [
      ...base64.warnings,
      ...(imageProbe?.warnings ?? []),
      ...mime.warnings,
    ],
  }
}

export const createUrlOrDataFact = (
  descriptor: MediaFactDescriptor,
  value: string,
  options?: ImageProbeOptions,
): MediaFact =>
  createDataUrlFact(descriptor, value, options)
  ?? createRemoteUrlFact(descriptor, value)

export const createFileIdFact = (
  descriptor: MediaFactDescriptor,
  value: string,
): MediaFact => {
  const valid = value.trim().length > 0
  return {
    ...contentFreeFact(descriptor),
    encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
    referenceKind: valid ? "file-id" : "unknown",
    warnings: [valid ? "unknown_mime_type" : "invalid_media_value"],
  }
}

export const createAudioIdFact = (
  path: Array<MediaPathSegment>,
  value: string,
): MediaFact => {
  const valid = value.trim().length > 0
  return {
    carrier: "chat.message.audio.id",
    contentFree: true,
    encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
    mediaKind: "audio",
    path,
    protocol: "chat",
    referenceKind: valid ? "audio-id" : "unknown",
    warnings: [valid ? "unknown_mime_type" : "invalid_media_value"],
  }
}

export const createInvalidValueFact = (
  descriptor: MediaFactDescriptor,
): MediaFact => ({
  ...contentFreeFact(descriptor),
  encodedUtf8Bytes: 0,
  referenceKind: "unknown",
  warnings: ["invalid_media_value"],
})

export const createRawBase64Fact = (
  descriptor: MediaFactDescriptor,
  value: string,
  declaredMimeType?: string,
  options?: ImageProbeOptions,
): MediaFact => {
  const base64 = inspectBase64(value)
  const mime = canonicalizeMimeType(declaredMimeType)
  const imageProbe = createImageProbe(
    descriptor,
    value,
    base64.facts.decodedBytes,
    mime.mimeType,
    options,
  )
  return {
    ...contentFreeFact(descriptor),
    base64: base64.facts,
    encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
    ...(imageProbe?.image ? { image: imageProbe.image } : {}),
    ...(mime.mimeType ? { mimeType: mime.mimeType } : {}),
    referenceKind: "base64",
    warnings: [
      ...base64.warnings,
      ...(imageProbe?.warnings ?? []),
      ...mime.warnings,
    ],
  }
}
