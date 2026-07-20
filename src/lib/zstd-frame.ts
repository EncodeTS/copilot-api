import {
  RequestBodyTooLargeError,
  validateByteLimit,
} from "~/lib/request-body-policy"

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MAGIC_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50
const MAX_BLOCK_BYTES = 128 * 1024
const EMPTY_CONTENT_CHECKSUM = 0x51d8e999n

// Frame fields and block sizes follow the canonical Zstandard format:
// https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md

export class InvalidZstdFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidZstdFrameError"
  }
}

export class UnsafeZstdFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeZstdFrameError"
  }
}

export interface ZstdFrameAdmission {
  decodedBytes: number
  windowBytes: number
  zeroOutputProven: boolean
}

export const admitSingleZstdFrame = (
  input: Uint8Array,
  maxDecodedBytes: number,
): ZstdFrameAdmission => {
  validateByteLimit(maxDecodedBytes, "maxDecodedBytes")
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  requireBytes(input, 0, 4)
  const magic = view.getUint32(0, true)
  if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC) {
    throw new UnsafeZstdFrameError(
      "Skippable or concatenated Zstandard frames are not accepted.",
    )
  }
  if (magic !== ZSTD_MAGIC) {
    throw new InvalidZstdFrameError("Invalid Zstandard frame magic.")
  }

  let offset = 4
  requireBytes(input, offset, 1)
  const descriptor = input[offset] ?? 0
  offset += 1
  if ((descriptor & 0x08) !== 0) {
    throw new InvalidZstdFrameError(
      "Reserved Zstandard frame-header bit is set.",
    )
  }

  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryIdFlag = descriptor & 0x03
  let windowBytes: bigint

  if (singleSegment) {
    windowBytes = 0n
  } else {
    requireBytes(input, offset, 1)
    const windowDescriptor = input[offset] ?? 0
    offset += 1
    const exponent = windowDescriptor >>> 3
    const mantissa = windowDescriptor & 0x07
    const windowBase = 1n << BigInt(10 + exponent)
    windowBytes = windowBase + (windowBase / 8n) * BigInt(mantissa)
  }

  const dictionaryIdBytes = [0, 1, 2, 4][dictionaryIdFlag] ?? 0
  const dictionaryId = readLittleEndian(input, offset, dictionaryIdBytes)
  offset += dictionaryIdBytes
  if (dictionaryId !== 0n) {
    throw new UnsafeZstdFrameError(
      "Dictionary-compressed Zstandard request bodies are not accepted.",
    )
  }

  const decodedLimit = BigInt(maxDecodedBytes)
  if (windowBytes > decodedLimit) {
    throw new RequestBodyTooLargeError("decoded")
  }

  const contentSizeBytes =
    contentSizeFlag === 0 ?
      singleSegment ? 1
      : 0
    : ([0, 2, 4, 8][contentSizeFlag] ?? 0)
  if (contentSizeBytes === 0) {
    throw new UnsafeZstdFrameError(
      "Zstandard frame content size is required for bounded decoding.",
    )
  }
  let decodedBytes = readLittleEndian(input, offset, contentSizeBytes)
  offset += contentSizeBytes
  if (contentSizeBytes === 2) {
    decodedBytes += 256n
  }
  if (singleSegment) {
    windowBytes = decodedBytes
  }

  if (windowBytes > decodedLimit || decodedBytes > decodedLimit) {
    throw new RequestBodyTooLargeError("decoded")
  }

  const blockMaximum =
    windowBytes < BigInt(MAX_BLOCK_BYTES) ? windowBytes : (
      BigInt(MAX_BLOCK_BYTES)
    )
  let lastBlock = false
  let zeroOutputProven = decodedBytes === 0n
  while (!lastBlock) {
    requireBytes(input, offset, 3)
    const blockHeader =
      (input[offset] ?? 0)
      | ((input[offset + 1] ?? 0) << 8)
      | ((input[offset + 2] ?? 0) << 16)
    offset += 3
    lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) {
      throw new InvalidZstdFrameError("Reserved Zstandard block type.")
    }
    if (decodedBytes === 0n && (blockType === 2 || blockSize > 0)) {
      zeroOutputProven = false
    }
    if (BigInt(blockSize) > blockMaximum) {
      throw new InvalidZstdFrameError(
        "Zstandard block exceeds the admitted frame window.",
      )
    }
    const encodedBlockBytes = blockType === 1 ? 1 : blockSize
    requireBytes(input, offset, encodedBlockBytes)
    offset += encodedBlockBytes
  }

  if (checksum) {
    const checksumValue = readLittleEndian(input, offset, 4)
    if (decodedBytes === 0n && checksumValue !== EMPTY_CONTENT_CHECKSUM) {
      throw new InvalidZstdFrameError(
        "Invalid checksum for an empty Zstandard frame.",
      )
    }
    offset += 4
  }
  if (offset !== input.byteLength) {
    throw new UnsafeZstdFrameError(
      "Skippable or concatenated Zstandard frames are not accepted.",
    )
  }
  if (decodedBytes === 0n && !zeroOutputProven) {
    throw new UnsafeZstdFrameError(
      "FCS-zero Zstandard frame cannot be proven to produce empty output.",
    )
  }

  return {
    decodedBytes: Number(decodedBytes),
    windowBytes: Number(windowBytes),
    zeroOutputProven,
  }
}

const readLittleEndian = (
  input: Uint8Array,
  offset: number,
  byteLength: number,
): bigint => {
  requireBytes(input, offset, byteLength)
  let result = 0n
  for (let index = 0; index < byteLength; index += 1) {
    result |= BigInt(input[offset + index] ?? 0) << BigInt(index * 8)
  }
  return result
}

const requireBytes = (
  input: Uint8Array,
  offset: number,
  byteLength: number,
): void => {
  if (offset < 0 || byteLength < 0 || offset + byteLength > input.byteLength) {
    throw new InvalidZstdFrameError("Truncated Zstandard frame.")
  }
}
