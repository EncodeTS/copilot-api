import { collectMediaFactsFromPayload } from "~/lib/media-facts/traversal"

export {
  iterateAnthropicCanonicalContent,
  type AnthropicCanonicalContentEvent,
  type AnthropicCanonicalContentIteratorOptions,
  type AnthropicContentAncestor,
} from "~/lib/media-facts/anthropic-content"

export {
  MEDIA_FACT_MAX_DEPTH,
  MEDIA_FACT_MAX_FACTS,
  MEDIA_FACT_MAX_NODES,
  MEDIA_IMAGE_PROBE_MAX_BYTES,
} from "~/lib/media-facts/types"
export type {
  Base64Facts,
  CollectMediaFactsOptions,
  FileDetail,
  ImageDetail,
  ImageFacts,
  ImageFormat,
  MediaCarrier,
  MediaCollectionWarning,
  MediaFact,
  MediaFactCollection,
  MediaFactCollectionStats,
  MediaFactLimits,
  MediaFactWarning,
  MediaDetail,
  MediaKind,
  MediaPathKey,
  MediaPathSegment,
  MediaProtocol,
  MediaReferenceKind,
} from "~/lib/media-facts/types"

/**
 * Collects content-free facts only from protocol-defined request/history paths.
 * Token coefficients, payload admission, and compression policy belong to callers.
 */
export const collectMediaFacts = collectMediaFactsFromPayload
