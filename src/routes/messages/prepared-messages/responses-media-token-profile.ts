import type { MediaFact } from "~/lib/media-facts"
import type { Model } from "~/services/copilot/get-models"

const PROFILE_VERSION_DATE = "2026-07-21"
const LOW_DETAIL_IMAGE_TOKENS = 85
const HIGH_DETAIL_TILE_TOKENS = 170
const HIGH_DETAIL_BASE_TOKENS = 85
const HIGH_DETAIL_TILE_SIZE = 512
const HIGH_DETAIL_LONG_EDGE = 2_048
const HIGH_DETAIL_SHORT_EDGE = 768
const GPT56_PATCH_SIZE = 32
const GPT56_MAX_PATCHES = 1_536
const UNKNOWN_IMAGE_TOKENS = 765
const UNKNOWN_FILE_TOKENS = 2_048
const AUTO_DETAIL_FILE_TOKENS = 4_096
const HIGH_DETAIL_FILE_TOKENS = 8_192
export const RESPONSES_UNKNOWN_MEDIA_TOKENS = 1_024
const MAX_FILE_ESTIMATE_TOKENS = 32_768
const FILE_PROFILE_VERSION = "2026-07-21/responses-file-detail/v1"

export interface ResponsesMediaProfileIdentity {
  readonly fileVersion: typeof FILE_PROFILE_VERSION
  readonly mapping: "copilot-unverified"
  readonly name: "gpt-5.6-vision" | "responses-conservative"
  readonly version: string
}

export interface ResponsesMediaTokenProfile {
  readonly identity: ResponsesMediaProfileIdentity
  estimateFact: (fact: Readonly<MediaFact>) => {
    readonly tokens: number
    readonly unknown: boolean
  }
}

const clampPositiveTokens = (value: number, maximum: number): number =>
  Math.max(1, Math.min(maximum, Math.ceil(value)))

const scaledHighDetailDimensions = (
  width: number,
  height: number,
): { height: number; width: number } => {
  let scaledWidth = width
  let scaledHeight = height
  const longEdge = Math.max(scaledWidth, scaledHeight)
  if (longEdge > HIGH_DETAIL_LONG_EDGE) {
    const scale = HIGH_DETAIL_LONG_EDGE / longEdge
    scaledWidth *= scale
    scaledHeight *= scale
  }
  const shortEdge = Math.min(scaledWidth, scaledHeight)
  if (shortEdge > HIGH_DETAIL_SHORT_EDGE) {
    const scale = HIGH_DETAIL_SHORT_EDGE / shortEdge
    scaledWidth *= scale
    scaledHeight *= scale
  }
  return { height: scaledHeight, width: scaledWidth }
}

const highDetailImageTokens = (width: number, height: number): number => {
  const scaled = scaledHighDetailDimensions(width, height)
  const tiles =
    Math.ceil(scaled.width / HIGH_DETAIL_TILE_SIZE)
    * Math.ceil(scaled.height / HIGH_DETAIL_TILE_SIZE)
  return HIGH_DETAIL_BASE_TOKENS + HIGH_DETAIL_TILE_TOKENS * tiles
}

const gpt56PatchImageTokens = (width: number, height: number): number => {
  const patches =
    Math.ceil(width / GPT56_PATCH_SIZE) * Math.ceil(height / GPT56_PATCH_SIZE)
  return Math.min(GPT56_MAX_PATCHES, patches)
}

const estimateKnownDimensionsImage = (
  fact: Readonly<MediaFact>,
  dimensions: NonNullable<MediaFact["image"]>,
  profile: ResponsesMediaProfileIdentity["name"],
): { tokens: number; unknown: boolean } => {
  if (fact.detail === "low") {
    return { tokens: LOW_DETAIL_IMAGE_TOKENS, unknown: false }
  }
  const usesPatchProfile =
    fact.detail === "auto"
    || fact.detail === "original"
    || fact.detail === undefined
  if (profile === "gpt-5.6-vision" && usesPatchProfile) {
    return {
      tokens: gpt56PatchImageTokens(dimensions.width, dimensions.height),
      unknown: false,
    }
  }
  if (profile === "responses-conservative" && usesPatchProfile) {
    return {
      tokens: Math.max(
        UNKNOWN_IMAGE_TOKENS,
        gpt56PatchImageTokens(dimensions.width, dimensions.height),
        highDetailImageTokens(dimensions.width, dimensions.height),
      ),
      unknown: true,
    }
  }
  return {
    tokens: highDetailImageTokens(dimensions.width, dimensions.height),
    unknown: fact.detail === undefined,
  }
}

const estimateImage = (
  fact: Readonly<MediaFact>,
  profile: ResponsesMediaProfileIdentity["name"],
): { tokens: number; unknown: boolean } => {
  if (fact.image) return estimateKnownDimensionsImage(fact, fact.image, profile)
  const decodedBytes = fact.base64?.decodedBytes
  if (decodedBytes !== undefined) {
    return {
      tokens: clampPositiveTokens(
        LOW_DETAIL_IMAGE_TOKENS + decodedBytes / 4_096,
        GPT56_MAX_PATCHES,
      ),
      unknown: true,
    }
  }
  return { tokens: UNKNOWN_IMAGE_TOKENS, unknown: true }
}

const estimateFile = (
  fact: Readonly<MediaFact>,
): { tokens: number; unknown: boolean } => {
  const detailFloor =
    fact.detail === "low" ? UNKNOWN_FILE_TOKENS
    : fact.detail === "auto" ? AUTO_DETAIL_FILE_TOKENS
    : HIGH_DETAIL_FILE_TOKENS
  const decodedBytes = fact.base64?.decodedBytes
  const contentEstimate = decodedBytes === undefined ? 0 : decodedBytes / 4
  return {
    tokens: Math.max(
      detailFloor,
      clampPositiveTokens(contentEstimate, MAX_FILE_ESTIMATE_TOKENS),
    ),
    // Local parsing is not equivalent to the official count endpoint,
    // including for otherwise-valid PDFs.
    unknown: true,
  }
}

export const selectResponsesMediaTokenProfile = (
  model: Model,
): ResponsesMediaTokenProfile => {
  const family = model.capabilities.family?.toLowerCase() ?? ""
  const id = model.id.toLowerCase()
  const name =
    family.startsWith("gpt-5.6") || id.startsWith("gpt-5.6") ?
      "gpt-5.6-vision"
    : "responses-conservative"
  const identity = Object.freeze({
    fileVersion: FILE_PROFILE_VERSION,
    mapping: "copilot-unverified" as const,
    name,
    version: `${PROFILE_VERSION_DATE}/${name}/v2`,
  })
  return Object.freeze({
    identity,
    estimateFact: (fact: Readonly<MediaFact>) => {
      if (fact.referenceKind === "unknown" || fact.warnings.length > 0) {
        const knownEstimate =
          fact.mediaKind === "image" ? estimateImage(fact, name)
          : fact.mediaKind === "file" ? estimateFile(fact)
          : { tokens: RESPONSES_UNKNOWN_MEDIA_TOKENS, unknown: true }
        return {
          tokens: Math.max(
            RESPONSES_UNKNOWN_MEDIA_TOKENS,
            knownEstimate.tokens,
          ),
          unknown: true,
        }
      }
      if (fact.mediaKind === "image") return estimateImage(fact, name)
      if (fact.mediaKind === "file") return estimateFile(fact)
      return { tokens: RESPONSES_UNKNOWN_MEDIA_TOKENS, unknown: true }
    },
  })
}
