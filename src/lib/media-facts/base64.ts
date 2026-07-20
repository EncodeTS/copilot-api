import { Buffer } from "node:buffer"

import type { Base64Facts, MediaFactWarning } from "~/lib/media-facts/types"

export interface Base64Inspection {
  facts: Base64Facts
  warnings: Array<MediaFactWarning>
}

export type ParsedDataUrl =
  | {
      kind: "base64"
      mimeType?: string
      payload: string
    }
  | {
      kind: "invalid"
      mimeType?: string
      warning: "invalid_data_url" | "unsupported_data_url_encoding"
    }

export const isBase64AlphabetCode = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a)
  || (code >= 0x61 && code <= 0x7a)
  || (code >= 0x30 && code <= 0x39)
  || code === 0x2b
  || code === 0x2f

export const isBase64WhitespaceCode = (code: number): boolean =>
  code === 0x09
  || code === 0x0a
  || code === 0x0c
  || code === 0x0d
  || code === 0x20

export const inspectBase64 = (value: string): Base64Inspection => {
  let alphabetCharacters = 0
  let alphabetAfterPadding = false
  let invalidCharacters = 0
  let paddingCharacters = 0
  let sawPadding = false
  let whitespaceCharacters = 0

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isBase64AlphabetCode(code)) {
      if (sawPadding) alphabetAfterPadding = true
      alphabetCharacters += 1
      continue
    }
    if (code === 0x3d) {
      sawPadding = true
      paddingCharacters += 1
      continue
    }
    if (isBase64WhitespaceCode(code)) {
      whitespaceCharacters += 1
      continue
    }
    invalidCharacters += 1
  }

  const encodedCharacters =
    alphabetCharacters + invalidCharacters + paddingCharacters
  const remainder = alphabetCharacters % 4
  const invalidPadding =
    paddingCharacters > 2
    || alphabetAfterPadding
    || (paddingCharacters > 0 && encodedCharacters % 4 !== 0)
  const invalidLength = paddingCharacters === 0 && remainder === 1
  const warnings: Array<MediaFactWarning> =
    invalidCharacters > 0 ? ["invalid_base64_alphabet"]
    : invalidPadding ? ["invalid_base64_padding"]
    : invalidLength ? ["invalid_base64_length"]
    : []
  const valid = warnings.length === 0

  return {
    facts: {
      alphabetCharacters,
      ...(valid ?
        {
          decodedBytes:
            Math.floor(alphabetCharacters / 4) * 3
            + (remainder === 2 ? 1
            : remainder === 3 ? 2
            : 0),
        }
      : {}),
      encodedCharacters,
      encodedUtf8Bytes: Buffer.byteLength(value, "utf8"),
      invalidCharacters,
      paddingCharacters,
      valid,
      whitespaceCharacters,
    },
    warnings,
  }
}

export const parseDataUrl = (value: string): ParsedDataUrl | null => {
  if (!value.toLowerCase().startsWith("data:")) return null
  const comma = value.indexOf(",")
  if (comma < 0) return { kind: "invalid", warning: "invalid_data_url" }

  const metadata = value.slice(5, comma).split(";")
  const rawMimeType = metadata.shift()?.trim()
  const mimeType = rawMimeType || undefined
  const base64 = metadata.some(
    (parameter) => parameter.trim().toLowerCase() === "base64",
  )
  if (!base64) {
    return {
      kind: "invalid",
      ...(mimeType ? { mimeType } : {}),
      warning: "unsupported_data_url_encoding",
    }
  }
  return {
    kind: "base64",
    ...(mimeType ? { mimeType } : {}),
    payload: value.slice(comma + 1),
  }
}
