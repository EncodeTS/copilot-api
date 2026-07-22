import { isBase64WhitespaceCode } from "~/lib/media-facts/base64"
import {
  MEDIA_IMAGE_PROBE_MAX_BYTES,
  type ImageFacts,
  type ImageFormat,
  type MediaFactWarning,
} from "~/lib/media-facts/types"

type ParsedImageFacts = Omit<ImageFacts, "probedBytes">

interface ImageHeaderProbe {
  image?: ParsedImageFacts
  status: "invalid" | "ok" | "truncated"
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const PROBE_SEGMENT_BYTES = 4 * 1024

class SegmentedProbeBytes {
  private readonly segments: Array<Uint8Array> = []
  private accumulator = 0
  private bitCount = 0
  private encodedOffset = 0
  private ended = false
  private loadedLength = 0
  private readonly encoded: string
  private readonly limit: number

  constructor(encoded: string, limit: number) {
    this.encoded = encoded
    this.limit = limit
  }

  get byteLength(): number {
    return this.limit
  }

  get bytesRead(): number {
    return this.loadedLength
  }

  at(index: number): number {
    if (index < 0 || index >= this.limit) return 0
    this.ensure(index + 1)
    if (index >= this.loadedLength) return 0
    return this.segments[Math.floor(index / PROBE_SEGMENT_BYTES)][
      index % PROBE_SEGMENT_BYTES
    ]
  }

  ascii(start: number, end: number): string {
    this.ensure(end)
    let value = ""
    for (
      let index = start;
      index < end && index < this.loadedLength;
      index += 1
    ) {
      value += String.fromCharCode(this.at(index))
    }
    return value
  }

  readUInt16BE(offset: number): number {
    return (this.at(offset) << 8) | this.at(offset + 1)
  }

  readUInt16LE(offset: number): number {
    return this.at(offset) | (this.at(offset + 1) << 8)
  }

  readUInt32BE(offset: number): number {
    return (
      this.at(offset) * 0x1_00_00_00
      + (this.at(offset + 1) << 16)
      + (this.at(offset + 2) << 8)
      + this.at(offset + 3)
    )
  }

  readUInt32LE(offset: number): number {
    return (
      this.at(offset)
      + (this.at(offset + 1) << 8)
      + (this.at(offset + 2) << 16)
      + this.at(offset + 3) * 0x1_00_00_00
    )
  }

  startsWith(expected: ReadonlyArray<number>): boolean {
    this.ensure(expected.length)
    return (
      this.loadedLength >= expected.length
      && expected.every((value, index) => this.at(index) === value)
    )
  }

  private append(value: number): void {
    const segmentIndex = Math.floor(this.loadedLength / PROBE_SEGMENT_BYTES)
    const segmentOffset = this.loadedLength % PROBE_SEGMENT_BYTES
    let segment = this.segments[segmentIndex]
    if (!segment) {
      segment = new Uint8Array(PROBE_SEGMENT_BYTES)
      this.segments.push(segment)
    }
    segment[segmentOffset] = value
    this.loadedLength += 1
  }

  private ensure(target: number): void {
    const boundedTarget = Math.min(target, this.limit)
    while (
      this.loadedLength < boundedTarget
      && !this.ended
      && this.encodedOffset < this.encoded.length
    ) {
      const code = this.encoded.charCodeAt(this.encodedOffset)
      this.encodedOffset += 1
      if (isBase64WhitespaceCode(code)) continue
      if (code === 0x3d) {
        this.ended = true
        break
      }
      this.accumulator = (this.accumulator << 6) | base64Value(code)
      this.bitCount += 6
      if (this.bitCount < 8) continue
      this.bitCount -= 8
      this.append((this.accumulator >> this.bitCount) & 0xff)
      this.accumulator &= (1 << this.bitCount) - 1
    }
  }
}

const base64Value = (code: number): number => {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52
  return code === 0x2b ? 62 : 63
}

const decodeBase64Prefix = (
  value: string,
  decodedBytes: number,
): SegmentedProbeBytes => {
  const byteLimit = Math.min(decodedBytes, MEDIA_IMAGE_PROBE_MAX_BYTES)
  return new SegmentedProbeBytes(value, byteLimit)
}

const isProbeTruncated = (
  buffer: SegmentedProbeBytes,
  decodedBytes: number,
): boolean => buffer.byteLength < decodedBytes

const partialImage = ({
  format,
  frameCount,
  height,
  width,
}: {
  format: ImageFormat
  frameCount: number
  height: number
  width: number
}): ParsedImageFacts => ({
  format,
  frameCount,
  frameCountExact: false,
  height,
  width,
})

const probePng = (
  buffer: SegmentedProbeBytes,
  decodedBytes: number,
): ImageHeaderProbe => {
  if (buffer.byteLength < 24) {
    return {
      status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
    }
  }
  const ihdrLength = buffer.readUInt32BE(8)
  if (ihdrLength !== 13 || buffer.ascii(12, 16) !== "IHDR") {
    return { status: "invalid" }
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0) return { status: "invalid" }

  let frameCount = 1
  let offset = 8
  while (offset + 8 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.ascii(offset + 4, offset + 8)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > decodedBytes) return { status: "invalid" }

    if (type === "acTL") {
      if (length < 8) return { status: "invalid" }
      if (offset + 16 > buffer.byteLength) {
        return {
          image: partialImage({
            format: "png",
            frameCount,
            height,
            width,
          }),
          status:
            isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
        }
      }
      frameCount = buffer.readUInt32BE(offset + 8)
      if (frameCount === 0) return { status: "invalid" }
    }

    // APNG requires acTL before IDAT. The chunk type is enough to know whether
    // the image is static; the potentially large compressed body is irrelevant.
    if (type === "IDAT" || type === "IEND") {
      return {
        image: {
          format: "png",
          frameCount,
          frameCountExact: true,
          height,
          width,
        },
        status: "ok",
      }
    }

    if (chunkEnd > buffer.byteLength) {
      return {
        image: partialImage({
          format: "png",
          frameCount,
          height,
          width,
        }),
        status: "truncated",
      }
    }
    offset = chunkEnd
  }

  return {
    image: partialImage({ format: "png", frameCount, height, width }),
    status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
  }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

const probeJpeg = (
  buffer: SegmentedProbeBytes,
  decodedBytes: number,
): ImageHeaderProbe => {
  let offset = 2
  while (offset < buffer.byteLength) {
    if (buffer.at(offset) !== 0xff) return { status: "invalid" }
    while (offset < buffer.byteLength && buffer.at(offset) === 0xff) offset += 1
    if (offset >= buffer.byteLength) break
    const marker = buffer.at(offset)
    offset += 1

    if (marker === 0xd9 || marker === 0xda) return { status: "invalid" }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > buffer.byteLength) break
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2) return { status: "invalid" }
    const segmentEnd = offset + segmentLength
    if (segmentEnd > decodedBytes) return { status: "invalid" }
    if (segmentEnd > buffer.byteLength) break

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return { status: "invalid" }
      const height = buffer.readUInt16BE(offset + 3)
      const width = buffer.readUInt16BE(offset + 5)
      if (width === 0 || height === 0) return { status: "invalid" }
      return {
        image: {
          format: "jpeg",
          frameCount: 1,
          frameCountExact: true,
          height,
          width,
        },
        status: "ok",
      }
    }
    offset = segmentEnd
  }

  return {
    status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
  }
}

const skipGifSubBlocks = (
  buffer: SegmentedProbeBytes,
  start: number,
): number | null => {
  let offset = start
  while (offset < buffer.byteLength) {
    const size = buffer.at(offset)
    offset += 1
    if (size === 0) return offset
    if (offset + size > buffer.byteLength) return null
    offset += size
  }
  return null
}

const probeGif = (
  buffer: SegmentedProbeBytes,
  decodedBytes: number,
): ImageHeaderProbe => {
  if (buffer.byteLength < 13) {
    return {
      status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
    }
  }
  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  if (width === 0 || height === 0) return { status: "invalid" }
  const globalColorTableBytes =
    buffer.at(10) & 0x80 ? 3 * 2 ** ((buffer.at(10) & 0x07) + 1) : 0
  let offset = 13 + globalColorTableBytes
  let frameCount = 0

  while (offset < buffer.byteLength) {
    const marker = buffer.at(offset)
    if (marker === 0x3b) {
      if (frameCount === 0) return { status: "invalid" }
      return {
        image: {
          format: "gif",
          frameCount,
          frameCountExact: true,
          height,
          width,
        },
        status: "ok",
      }
    }
    if (marker === 0x21) {
      if (offset + 2 > buffer.byteLength) break
      const next = skipGifSubBlocks(buffer, offset + 2)
      if (next === null) break
      offset = next
      continue
    }
    if (marker !== 0x2c) return { status: "invalid" }
    if (offset + 10 > buffer.byteLength) break

    frameCount += 1
    const localColorTableBytes =
      buffer.at(offset + 9) & 0x80 ?
        3 * 2 ** ((buffer.at(offset + 9) & 0x07) + 1)
      : 0
    offset += 10 + localColorTableBytes
    if (offset >= buffer.byteLength) break
    offset += 1
    const next = skipGifSubBlocks(buffer, offset)
    if (next === null) break
    offset = next
  }

  return {
    ...(frameCount > 0 ?
      {
        image: partialImage({
          format: "gif",
          frameCount,
          height,
          width,
        }),
      }
    : {}),
    status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
  }
}

const readUInt24LE = (buffer: SegmentedProbeBytes, offset: number): number =>
  buffer.at(offset)
  | (buffer.at(offset + 1) << 8)
  | (buffer.at(offset + 2) << 16)

const probeWebp = (
  buffer: SegmentedProbeBytes,
  decodedBytes: number,
): ImageHeaderProbe => {
  if (buffer.byteLength < 12) {
    return {
      status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
    }
  }
  const declaredEnd = buffer.readUInt32LE(4) + 8
  if (declaredEnd < 12 || decodedBytes < declaredEnd)
    return { status: "invalid" }

  let animated = false
  let animationFrames = 0
  let dimensions: { height: number; width: number } | undefined
  let offset = 12
  while (offset + 8 <= buffer.byteLength && offset < declaredEnd) {
    const type = buffer.ascii(offset, offset + 4)
    const length = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const chunkEnd = dataOffset + length
    const paddedEnd = chunkEnd + (length % 2)
    if (paddedEnd > declaredEnd) return { status: "invalid" }
    const available = buffer.byteLength - dataOffset

    if (type === "VP8X") {
      if (length < 10) return { status: "invalid" }
      if (available < 10) break
      animated = (buffer.at(dataOffset) & 0x02) !== 0
      dimensions = {
        height: readUInt24LE(buffer, dataOffset + 7) + 1,
        width: readUInt24LE(buffer, dataOffset + 4) + 1,
      }
    } else if (type === "VP8 ") {
      if (length < 10) return { status: "invalid" }
      if (available < 10) break
      if (
        buffer.at(dataOffset + 3) !== 0x9d
        || buffer.at(dataOffset + 4) !== 0x01
        || buffer.at(dataOffset + 5) !== 0x2a
      ) {
        return { status: "invalid" }
      }
      const height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff
      const width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff
      if (width === 0 || height === 0) return { status: "invalid" }
      return {
        image: {
          format: "webp",
          frameCount: 1,
          frameCountExact: true,
          height,
          width,
        },
        status: "ok",
      }
    } else if (type === "VP8L") {
      if (length < 5) return { status: "invalid" }
      if (available < 5) break
      if (buffer.at(dataOffset) !== 0x2f) return { status: "invalid" }
      return {
        image: {
          format: "webp",
          frameCount: 1,
          frameCountExact: true,
          height:
            1
            + ((buffer.at(dataOffset + 2) >> 6)
              | (buffer.at(dataOffset + 3) << 2)
              | ((buffer.at(dataOffset + 4) & 0x0f) << 10)),
          width:
            1
            + (buffer.at(dataOffset + 1)
              | ((buffer.at(dataOffset + 2) & 0x3f) << 8)),
        },
        status: "ok",
      }
    } else if (type === "ANMF") {
      if (length < 16) return { status: "invalid" }
      if (available < 16) break
      animationFrames += 1
    }

    if (paddedEnd > buffer.byteLength) {
      return {
        ...(dimensions ?
          {
            image: partialImage({
              format: "webp",
              frameCount: animated ? animationFrames : 1,
              ...dimensions,
            }),
          }
        : {}),
        status: "truncated",
      }
    }
    offset = paddedEnd
  }

  if (!dimensions || dimensions.width === 0 || dimensions.height === 0) {
    return {
      status: isProbeTruncated(buffer, decodedBytes) ? "truncated" : "invalid",
    }
  }
  const complete = offset >= declaredEnd
  if (animated && complete && animationFrames === 0)
    return { status: "invalid" }
  const status =
    complete ? "ok"
    : isProbeTruncated(buffer, decodedBytes) ? "truncated"
    : "invalid"
  return {
    image: {
      format: "webp",
      frameCount: animated ? animationFrames : 1,
      frameCountExact: complete,
      ...dimensions,
    },
    status,
  }
}

const getExpectedImageFormat = (
  mimeType: string | undefined,
): ImageFormat | undefined => {
  if (mimeType === "image/png") return "png"
  if (mimeType === "image/jpeg") return "jpeg"
  if (mimeType === "image/gif") return "gif"
  if (mimeType === "image/webp") return "webp"
  return undefined
}

export const probeImageMetadata = (
  encoded: string,
  decodedBytes: number,
  mimeType: string | undefined,
): { image?: ImageFacts; warnings: Array<MediaFactWarning> } => {
  const buffer = decodeBase64Prefix(encoded, decodedBytes)
  const format =
    buffer.startsWith(PNG_SIGNATURE) ? "png"
    : buffer.at(0) === 0xff && buffer.at(1) === 0xd8 ? "jpeg"
    : buffer.ascii(0, 6) === "GIF87a" || buffer.ascii(0, 6) === "GIF89a" ? "gif"
    : buffer.ascii(0, 4) === "RIFF" && buffer.ascii(8, 12) === "WEBP" ? "webp"
    : undefined
  const expectedFormat = getExpectedImageFormat(mimeType)
  if (!format) {
    return {
      warnings: [
        expectedFormat ? "invalid_image_header" : "unknown_image_format",
      ],
    }
  }

  const result =
    format === "png" ? probePng(buffer, decodedBytes)
    : format === "jpeg" ? probeJpeg(buffer, decodedBytes)
    : format === "gif" ? probeGif(buffer, decodedBytes)
    : probeWebp(buffer, decodedBytes)
  const warnings: Array<MediaFactWarning> = []
  if (mimeType && expectedFormat !== format) {
    warnings.push("mime_format_mismatch")
  }
  if (result.status === "invalid") warnings.push("invalid_image_header")
  if (result.status === "truncated") warnings.push("image_probe_limit_reached")
  return {
    ...(result.image && result.status !== "invalid" ?
      {
        image: {
          ...result.image,
          probedBytes: buffer.bytesRead,
        },
      }
    : {}),
    warnings,
  }
}
