export type MediaProtocol = "anthropic" | "chat" | "responses"

export type MediaPathKey =
  | "audio"
  | "content"
  | "data"
  | "file"
  | "file_data"
  | "file_id"
  | "file_url"
  | "id"
  | "image_url"
  | "input"
  | "input_audio"
  | "messages"
  | "output"
  | "outputs"
  | "result"
  | "source"
  | "url"

export type MediaPathSegment = MediaPathKey | number

export type MediaKind = "audio" | "file" | "image"
export type ImageDetail = "auto" | "high" | "low" | "original"
export type FileDetail = "auto" | "high" | "low"
export type MediaDetail = ImageDetail | FileDetail

export interface MediaCarrierDefinition {
  "anthropic.document.source.data": {
    mediaKind: "file"
    protocol: "anthropic"
  }
  "anthropic.document.source.file_id": {
    mediaKind: "file"
    protocol: "anthropic"
  }
  "anthropic.document.source.url": {
    mediaKind: "file"
    protocol: "anthropic"
  }
  "anthropic.image.source.data": {
    mediaKind: "image"
    protocol: "anthropic"
  }
  "anthropic.image.source.file_id": {
    mediaKind: "image"
    protocol: "anthropic"
  }
  "anthropic.image.source.url": {
    mediaKind: "image"
    protocol: "anthropic"
  }
  "chat.file.file_data": { mediaKind: "file"; protocol: "chat" }
  "chat.file.file_id": { mediaKind: "file"; protocol: "chat" }
  "chat.image_url.url": { mediaKind: "image"; protocol: "chat" }
  "chat.input_audio.data": { mediaKind: "audio"; protocol: "chat" }
  "chat.message.audio.id": { mediaKind: "audio"; protocol: "chat" }
  "responses.code_interpreter_call.outputs.image.url": {
    mediaKind: "image"
    protocol: "responses"
  }
  "responses.computer_call_output.output.file_id": {
    mediaKind: "image"
    protocol: "responses"
  }
  "responses.computer_call_output.output.image_url": {
    mediaKind: "image"
    protocol: "responses"
  }
  "responses.image_generation_call.result": {
    mediaKind: "image"
    protocol: "responses"
  }
  "responses.input_file.file_data": {
    mediaKind: "file"
    protocol: "responses"
  }
  "responses.input_file.file_id": {
    mediaKind: "file"
    protocol: "responses"
  }
  "responses.input_file.file_url": {
    mediaKind: "file"
    protocol: "responses"
  }
  "responses.input_image.file_id": {
    mediaKind: "image"
    protocol: "responses"
  }
  "responses.input_image.image_url": {
    mediaKind: "image"
    protocol: "responses"
  }
}

export type MediaCarrier = keyof MediaCarrierDefinition

type ResponsesImageCarrier =
  | "responses.input_image.file_id"
  | "responses.input_image.image_url"

type StandardDetailCarrier =
  | "chat.image_url.url"
  | "responses.input_file.file_data"
  | "responses.input_file.file_id"
  | "responses.input_file.file_url"

type DetailFor<Carrier extends MediaCarrier> =
  Carrier extends ResponsesImageCarrier ? ImageDetail
  : Carrier extends StandardDetailCarrier ? FileDetail
  : never

export type MediaReferenceKind =
  | "audio-id"
  | "base64"
  | "data-url"
  | "file-id"
  | "remote-url"
  | "unknown"

export type MediaFactWarning =
  | "invalid_base64_alphabet"
  | "invalid_base64_length"
  | "invalid_base64_padding"
  | "invalid_data_url"
  | "invalid_image_header"
  | "invalid_media_reference"
  | "invalid_media_value"
  | "invalid_mime_type"
  | "image_probe_limit_reached"
  | "mime_format_mismatch"
  | "unknown_image_format"
  | "unknown_mime_type"
  | "unsupported_mime_type"
  | "unsupported_data_url_encoding"

export type MediaCollectionWarning =
  | "cycle_detected"
  | "invalid_container"
  | "max_depth_exceeded"
  | "max_facts_exceeded"
  | "max_nodes_exceeded"

export interface Base64Facts {
  readonly alphabetCharacters: number
  /** Exact decoded length from validated Base64 arithmetic; no full decode. */
  readonly decodedBytes?: number
  readonly encodedCharacters: number
  readonly encodedUtf8Bytes: number
  readonly invalidCharacters: number
  readonly paddingCharacters: number
  readonly valid: boolean
  readonly whitespaceCharacters: number
}

export type ImageFormat = "gif" | "jpeg" | "png" | "webp"

export interface ImageFacts {
  readonly format: ImageFormat
  readonly frameCount: number
  readonly frameCountExact: boolean
  readonly height: number
  readonly probedBytes: number
  readonly width: number
}

export interface MediaFact {
  readonly base64?: Base64Facts
  readonly carrier: MediaCarrier
  /** Signals that the fact contains no locator, ID, Base64, or stable media hash. */
  readonly contentFree: true
  readonly detail?: MediaDetail
  /** Exact UTF-8 bytes of the carrier string, not the enclosing JSON body. */
  readonly encodedUtf8Bytes: number
  readonly image?: ImageFacts
  readonly mediaKind: MediaKind
  /** Canonical lowercase MIME only; untrusted MIME text is never retained. */
  readonly mimeType?: string
  readonly path: ReadonlyArray<MediaPathSegment>
  readonly protocol: MediaProtocol
  readonly referenceKind: MediaReferenceKind
  readonly warnings: ReadonlyArray<MediaFactWarning>
}

export const MEDIA_FACT_MAX_DEPTH = 128
export const MEDIA_FACT_MAX_FACTS = 1_024
export const MEDIA_FACT_MAX_NODES = 10_000

/** Header-read safety bound only. This is not a payload admission limit. */
export const MEDIA_IMAGE_PROBE_MAX_BYTES = 256 * 1024

export interface MediaFactLimits {
  readonly maxDepth: number
  readonly maxFacts: number
  readonly maxNodes: number
}

export interface CollectMediaFactsOptions {
  onBase64Decode?: () => void
  probeImageHeaders?: boolean
  protocol: MediaProtocol
}

export interface MediaFactCollectionStats {
  readonly factsCollected: number
  readonly maxDepthVisited: number
  readonly nodesVisited: number
  readonly truncated: boolean
}

export interface MediaFactCollection {
  readonly facts: ReadonlyArray<Readonly<MediaFact>>
  readonly limits: Readonly<MediaFactLimits>
  readonly stats: Readonly<MediaFactCollectionStats>
  readonly warnings: ReadonlyArray<MediaCollectionWarning>
}

export type MediaFactDescriptor = {
  [Carrier in MediaCarrier]: {
    carrier: Carrier
    detail?: DetailFor<Carrier>
    mediaKind: MediaCarrierDefinition[Carrier]["mediaKind"]
    path: Array<MediaPathSegment>
    protocol: MediaCarrierDefinition[Carrier]["protocol"]
  }
}[MediaCarrier]
