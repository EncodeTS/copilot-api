import type {
  ResponseContextManagementCompactionItem,
  ResponseFunctionCallOutputItem,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import {
  getModelResponsesApiCompactThreshold as getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages as isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses as isConfiguredContextManagementEnabledForResponses,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"

export const DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO = 0.9
export const MIN_RESPONSES_COMPACT_HEADROOM_TOKENS = 32_000
const DEFAULT_RESPONSES_PROMPT_LIMIT_TOKENS = 200_000
export type ResponsesApiContextManagementSource = "messages" | "responses"

export interface ResponsesModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
}

export const responsesUtilsDependencies = {
  getModelResponsesApiCompactThreshold:
    getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages:
    isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses:
    isConfiguredContextManagementEnabledForResponses,
  isResponsesApiWebSocketEnabled: isConfiguredResponsesApiWebSocketEnabled,
}

export const getResponsesRequestOptions = (
  payload: ResponsesPayload,
): { vision: boolean; initiator: "agent" | "user" } => {
  const vision = hasVisionInput(payload)
  const initiator = hasAgentInitiator(payload) ? "agent" : "user"

  return { vision, initiator }
}

export const getResponsesTransportForModel = (
  selectedModel:
    | {
        supported_endpoints?: Array<string>
      }
    | undefined,
  options: {
    compactType?: CompactType
  } = {},
): ResponsesTransport | null => {
  const capabilities = getResponsesEndpointCapabilities(selectedModel)
  const useWebSocket =
    responsesUtilsDependencies.isResponsesApiWebSocketEnabled()

  if (
    options.compactType !== COMPACT_REQUEST
    && useWebSocket
    && capabilities.websocket
  ) {
    return "websocket"
  }

  if (capabilities.http) {
    return "http"
  }

  return null
}

export const hasAgentInitiator = (payload: ResponsesPayload): boolean => {
  // Refactor `isAgentCall` logic to check only the last message in the history rather than any message. This prevents valid user messages from being incorrectly flagged as agent calls due to previous assistant history, ensuring proper credit consumption for multi-turn conversations.
  const lastItem = getPayloadItems(payload).at(-1)
  if (!lastItem) {
    return false
  }
  if (!("role" in lastItem) || !lastItem.role) {
    return true
  }
  const role =
    typeof lastItem.role === "string" ? lastItem.role.toLowerCase() : ""
  return role === "assistant"
}

export const hasVisionInput = (payload: ResponsesPayload): boolean => {
  const values = getPayloadItems(payload)
  return values.some((item) => containsVisionContent(item))
}

const DATA_URL_PREFIX = "data:"
// Static 96x32 PNG reading "Image too large / Redacted".
const REDACTED_IMAGE_PLACEHOLDER_DATA_URL =
  "data:image/png;base64,"
  + [
    "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAMAAADaHo1mAAADAFBMVEX///8fKTfR1dsAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAACae8QWAAAAvElEQVR42u1WixKAIAhj/f9Hdz2BXJiVed3pVSYtpgwsGSo3GaRq6wSd4F8EyIJx",
    "ydSUAMB8il51sHT2fiVQu8czguQwXWAyFvswIJhmoS9gmzYlcFiHj1aAgzcJVgCyguYhAhNZmMhYQZs1EJnnIAqKiuHjSrZT",
    "ucSQ4s8JkKDDIYr3IuR8vEWgqroKP9b1bYKk2wfgeVmqATQLXdXamsXdEKkz3QXEEeTTuWWImMhW6qci94/+hwSVf99HqVoD",
    "OAuj2SEAAAAASUVORK5CYII=",
  ].join("")

export const sanitizeOversizedInputImages = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
): number => {
  const limit =
    typeof maxPromptImageSize === "number" && maxPromptImageSize > 0 ?
      maxPromptImageSize
    : undefined

  if (limit === undefined || !Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(
    payload.input,
    (image) => image.decodedBytes > limit,
  )
}

export const sanitizeAllInputImages = (payload: ResponsesPayload): number => {
  if (!Array.isArray(payload.input)) {
    return 0
  }

  return sanitizeInputImages(payload.input, () => true)
}

export type ImageBudgetCandidateGroup =
  | "latest_user_group"
  | "current_turn_tool_output"
  | "latest_tool_visual_context"
  | "referenced_history_visual_context"
  | "recent_user"
  | "history_user"
  | "history_tool_output"
  | "unknown"

export type ImagePayloadBudgetUnresolvedReason =
  | "no_optimizable_images"
  | "current_visual_working_set_required"
  | "unoptimizable_file_data"
  | "compression_unavailable"
  | "no_smaller_payload"

export interface ImagePayloadBudgetOptions {
  enabled?: boolean
  budgetBytes?: number
  sendHardLimitBytes?: number
  nearBudgetRatio?: number
  maxPromptImageSize?: number
  preserveLatestUserImageGroup?: boolean
  allowReplacingLatestImages?: boolean
  allowNormalReplacement?: boolean
  compressionEnabled?: boolean
  compressionAdapter?: ImageCompressionAdapter
  maxCompressionActions?: number
}

export interface ImagePayloadBudgetResult {
  changed: boolean
  targetMet: boolean
  hardLimitMet: boolean
  sendAllowed: boolean
  retryEligible: boolean
  nearLimit: boolean
  unresolvedReason?: ImagePayloadBudgetUnresolvedReason
  initialPayloadBytes: number
  finalPayloadBytes: number
  budgetBytes: number
  sendHardLimitBytes: number
  imageCount: number
  candidateCount: number
  oversizedInputImageCount: number
  oversizedResolvedCount: number
  compressionAttemptedCount: number
  compressionActionLimit?: number
  compressionActionLimitHit: boolean
  compressionCacheHitCount: number
  compressionDiagnosticCounts: ImageCompressionDiagnosticCounts
  compressionDiagnosticSamples: Array<ImageCompressionDiagnosticSample>
  compressionNegativeCacheHitCount: number
  compressionProfiles: Array<ImageCompressionProfileSummary>
  compressionStatusCounts: ImageCompressionStatusCounts
  compressedCount: number
  replacedCount: number
  preservedLatestCount: number
  largestImageBytes?: number
  latestImageReplaced: boolean
  currentVisualGroupsAffected: number
  partiallyOmittedGroupCount: number
  inlineImageBytes: number
  inputFileDataBytes: number
  remoteMediaLocatorCount: number
  fileIdCount: number
  nonImageDataUrlBytes: number
  textAndToolBytes: number
  unoptimizableMediaBytes: number
  bodyBytesOverBudget: number
  largestUnoptimizableKind?:
    | "input_file.file_data"
    | "remote_media_url"
    | "file_id"
    | "non_image_data_url"
    | "text_or_tool"
}

export interface ImageCompressionProfileSummary {
  attemptedCount: number
  compressedCount: number
  profile: ImageCompressionProfile["name"]
  statusCounts: ImageCompressionStatusCounts
}

interface ImagePayloadBudgetCandidate {
  base64Bytes: number
  content: Array<ResponseInputContent>
  contentIndex: number
  dataUrlBytes: number
  decodedBytes: number
  group: ImageBudgetCandidateGroup
  inputIndex: number
  mimeType: string
  oversized: boolean
  compressed?: boolean
  replaced?: boolean
  record: ResponseInputImage
}

export interface ImageCompressionProfile {
  detail?: "low" | "high" | "auto" | "keep-original"
  jpegQuality: number
  maxLongEdge: number
  name:
    | "history-soft"
    | "history-hard"
    | "history-extreme"
    | "latest-soft"
    | "latest-hard"
    | "latest-extreme"
}

export interface ImageCompressionInput {
  dataUrl: string
  decodedBytes: number
  group: ImageBudgetCandidateGroup
  mimeType: string
  profile: ImageCompressionProfile
}

export interface ImageCompressionOutput {
  dataUrl: string
  outputBytes: number
}

export type ImageCompressionStatus =
  | "adapter_error"
  | "already_optimized"
  | "compressed"
  | "decode_limit"
  | "invalid_data_url"
  | "no_smaller"
  | "timeout"

export type ImageCompressionCacheHitKind = "positive" | "negative"

export type ImageCompressionStatusCounts = Partial<
  Record<ImageCompressionStatus, number>
>

export interface ImageCompressionResult {
  cacheHit?: ImageCompressionCacheHitKind
  diagnostic?: string
  diagnosticDetail?: ImageCompressionDiagnosticDetail
  elapsedMs?: number
  inputBytes?: number
  output?: ImageCompressionOutput
  outputBytes?: number
  status: ImageCompressionStatus
}

export type ImageCompressionDiagnosticCounts = Partial<Record<string, number>>

export interface ImageCompressionDiagnosticDetail {
  code?: string
  message?: string
  name?: string
  stack?: string
  stage?: string
}

export interface ImageCompressionDiagnosticSample
  extends ImageCompressionDiagnosticDetail {
  dataUrlBytes?: number
  decodedBytes?: number
  diagnostic: string
  elapsedMs?: number
  group?: ImageBudgetCandidateGroup
  inputBytes?: number
  mimeType?: string
  outputBytes?: number
  profile?: ImageCompressionProfile["name"]
  status: ImageCompressionStatus
}

export type ImageCompressionAdapterResult =
  | ImageCompressionOutput
  | ImageCompressionResult
  | null

export interface ImageCompressionAdapter {
  compress(input: ImageCompressionInput): Promise<ImageCompressionAdapterResult>
}

interface ParsedImageDataUrl {
  base64Bytes: number
  decodedBytes: number
  mimeType: string
}

interface PayloadMediaStats {
  fileIdBytes: number
  fileIdCount: number
  inputFileDataBytes: number
  largestUnoptimizableBytes: number
  largestUnoptimizableKind?: ImagePayloadBudgetResult["largestUnoptimizableKind"]
  nonImageDataUrlBytes: number
  remoteMediaLocatorBytes: number
  remoteMediaLocatorCount: number
  unoptimizableMediaBytes: number
}

const DEFAULT_RESPONSES_PAYLOAD_BUDGET_BYTES = 4_980_736
const DEFAULT_RESPONSES_PAYLOAD_SEND_HARD_LIMIT_BYTES = 5_226_496
const DEFAULT_RESPONSES_IMAGE_NEAR_BUDGET_RATIO = 0.92

const IMAGE_DATA_URL_PATTERN =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/u
const DATA_URL_MIME_PATTERN = /^data:([^;,]+)(?:;[^,]*)?;base64,/iu
const REMOTE_MEDIA_URL_PATTERN = /^(?:https?|file):\/\//iu

const PROTECTED_IMAGE_GROUPS = new Set<ImageBudgetCandidateGroup>([
  "latest_user_group",
  "current_turn_tool_output",
  "latest_tool_visual_context",
  "referenced_history_visual_context",
])

const IMAGE_REPLACEMENT_GROUP_PRIORITY: Record<
  ImageBudgetCandidateGroup,
  number
> = {
  history_tool_output: 0,
  unknown: 1,
  history_user: 2,
  recent_user: 3,
  current_turn_tool_output: 4,
  latest_tool_visual_context: 5,
  referenced_history_visual_context: 6,
  latest_user_group: 7,
}

const HISTORY_COMPRESSION_PROFILES: Array<ImageCompressionProfile> = [
  {
    detail: "keep-original",
    jpegQuality: 82,
    maxLongEdge: 1536,
    name: "history-soft",
  },
  { detail: "low", jpegQuality: 76, maxLongEdge: 1280, name: "history-hard" },
  {
    detail: "low",
    jpegQuality: 70,
    maxLongEdge: 1024,
    name: "history-extreme",
  },
]

const LATEST_COMPRESSION_PROFILES: Array<ImageCompressionProfile> = [
  {
    detail: "keep-original",
    jpegQuality: 90,
    maxLongEdge: 2576,
    name: "latest-soft",
  },
  {
    detail: "keep-original",
    jpegQuality: 84,
    maxLongEdge: 2048,
    name: "latest-hard",
  },
  {
    detail: "keep-original",
    jpegQuality: 76,
    maxLongEdge: 1600,
    name: "latest-extreme",
  },
]

export const calculateResponsesPayloadBytes = (
  payload: ResponsesPayload,
): number => Buffer.byteLength(JSON.stringify(payload), "utf8")

export const optimizeInputImagesForPayloadBudget = async (
  payload: ResponsesPayload,
  options: ImagePayloadBudgetOptions = {},
): Promise<ImagePayloadBudgetResult> => {
  const budgetBytes = normalizePositiveInteger(
    options.budgetBytes,
    DEFAULT_RESPONSES_PAYLOAD_BUDGET_BYTES,
  )
  const sendHardLimitBytes = normalizePositiveInteger(
    options.sendHardLimitBytes,
    DEFAULT_RESPONSES_PAYLOAD_SEND_HARD_LIMIT_BYTES,
  )
  const nearBudgetRatio =
    (
      typeof options.nearBudgetRatio === "number"
      && Number.isFinite(options.nearBudgetRatio)
      && options.nearBudgetRatio > 0
      && options.nearBudgetRatio <= 1
    ) ?
      options.nearBudgetRatio
    : DEFAULT_RESPONSES_IMAGE_NEAR_BUDGET_RATIO

  const initialPayloadBytes = calculateResponsesPayloadBytes(payload)
  const candidates = collectImagePayloadBudgetCandidates(
    payload,
    options.maxPromptImageSize,
  )
  const oversizedInputImageCount = candidates.filter(
    (candidate) => candidate.oversized,
  ).length
  const baseResult = createImagePayloadBudgetResult({
    budgetBytes,
    candidates,
    changed: false,
    finalPayloadBytes: initialPayloadBytes,
    initialPayloadBytes,
    nearBudgetRatio,
    oversizedInputImageCount,
    payload,
    replacedCount: 0,
    sendHardLimitBytes,
  })

  if (options.enabled === false) {
    return baseResult
  }

  if (baseResult.targetMet && oversizedInputImageCount === 0) {
    return baseResult
  }

  const compressionAvailable =
    options.compressionEnabled === true && Boolean(options.compressionAdapter)
  let changed = false
  let compressedCount = 0
  let compressionAttemptedCount = 0
  let compressionActionsRemaining = normalizeCompressionActionLimit(
    options.maxCompressionActions,
  )
  const compressionActionLimit =
    Number.isFinite(compressionActionsRemaining) ?
      compressionActionsRemaining
    : undefined
  let compressionCacheHitCount = 0
  const compressionDiagnosticCounts: ImageCompressionDiagnosticCounts = {}
  const compressionDiagnosticSamples: Array<ImageCompressionDiagnosticSample> =
    []
  let compressionNegativeCacheHitCount = 0
  const compressionProfiles: Array<ImageCompressionProfileSummary> = []
  const compressionStatusCounts: ImageCompressionStatusCounts = {}
  let replacedCount = 0
  let oversizedResolvedCount = 0

  if (compressionAvailable && options.compressionAdapter) {
    const historySoftResult = await applyCompressionProfile(
      payload,
      candidates.filter((candidate) => !isProtectedCandidate(candidate)),
      HISTORY_COMPRESSION_PROFILES[0],
      options,
      compressionActionsRemaining,
    )
    compressionProfiles.push(
      createCompressionProfileSummary(
        HISTORY_COMPRESSION_PROFILES[0].name,
        historySoftResult,
      ),
    )
    compressionAttemptedCount += historySoftResult.attemptedCount
    compressionCacheHitCount += historySoftResult.cacheHitCount
    compressionNegativeCacheHitCount += historySoftResult.negativeCacheHitCount
    compressedCount += historySoftResult.compressedCount
    mergeImageCompressionStatusCounts(
      compressionStatusCounts,
      historySoftResult.statusCounts,
    )
    mergeImageCompressionDiagnosticCounts(
      compressionDiagnosticCounts,
      historySoftResult.diagnosticCounts,
    )
    mergeImageCompressionDiagnosticSamples(
      compressionDiagnosticSamples,
      historySoftResult.diagnosticSamples,
    )
    compressionActionsRemaining -= historySoftResult.attemptedCount
    changed ||= compressedCount > 0

    if (
      !isPayloadWithinTarget(payload, candidates, budgetBytes)
      && shouldCompressProtectedCandidates(
        payload,
        candidates,
        budgetBytes,
        sendHardLimitBytes,
        nearBudgetRatio,
      )
    ) {
      const latestSoftResult = await applyCompressionProfile(
        payload,
        candidates.filter((candidate) => isProtectedCandidate(candidate)),
        LATEST_COMPRESSION_PROFILES[0],
        options,
        compressionActionsRemaining,
      )
      compressionProfiles.push(
        createCompressionProfileSummary(
          LATEST_COMPRESSION_PROFILES[0].name,
          latestSoftResult,
        ),
      )
      compressionAttemptedCount += latestSoftResult.attemptedCount
      compressionCacheHitCount += latestSoftResult.cacheHitCount
      compressionNegativeCacheHitCount += latestSoftResult.negativeCacheHitCount
      compressedCount += latestSoftResult.compressedCount
      mergeImageCompressionStatusCounts(
        compressionStatusCounts,
        latestSoftResult.statusCounts,
      )
      mergeImageCompressionDiagnosticCounts(
        compressionDiagnosticCounts,
        latestSoftResult.diagnosticCounts,
      )
      mergeImageCompressionDiagnosticSamples(
        compressionDiagnosticSamples,
        latestSoftResult.diagnosticSamples,
      )
      compressionActionsRemaining -= latestSoftResult.attemptedCount
      changed ||= latestSoftResult.compressedCount > 0
    }

    for (const profile of HISTORY_COMPRESSION_PROFILES.slice(1)) {
      if (isPayloadWithinTarget(payload, candidates, budgetBytes)) {
        break
      }
      const profileResult = await applyCompressionProfile(
        payload,
        candidates.filter((candidate) => !isProtectedCandidate(candidate)),
        profile,
        options,
        compressionActionsRemaining,
      )
      compressionProfiles.push(
        createCompressionProfileSummary(profile.name, profileResult),
      )
      compressionAttemptedCount += profileResult.attemptedCount
      compressionCacheHitCount += profileResult.cacheHitCount
      compressionNegativeCacheHitCount += profileResult.negativeCacheHitCount
      compressedCount += profileResult.compressedCount
      mergeImageCompressionStatusCounts(
        compressionStatusCounts,
        profileResult.statusCounts,
      )
      mergeImageCompressionDiagnosticCounts(
        compressionDiagnosticCounts,
        profileResult.diagnosticCounts,
      )
      mergeImageCompressionDiagnosticSamples(
        compressionDiagnosticSamples,
        profileResult.diagnosticSamples,
      )
      compressionActionsRemaining -= profileResult.attemptedCount
      changed ||= profileResult.compressedCount > 0
    }
  }

  if (
    !compressionAvailable
    || !isPayloadWithinTarget(payload, candidates, budgetBytes)
  ) {
    const replacementCandidates = [...candidates].sort(compareImageCandidates)
    for (const candidate of replacementCandidates) {
      const currentBytes = calculateResponsesPayloadBytes(payload)
      const hasUnsafeOversizedImage = hasUnsafeOversizedCandidates(candidates)
      if (
        currentBytes
          <= getReplacementTargetBytes({
            allowNormalReplacement: options.allowNormalReplacement === true,
            budgetBytes,
            compressionAvailable,
            compressedCount,
            sendHardLimitBytes,
          })
        && !hasUnsafeOversizedImage
      ) {
        break
      }

      if (
        isProtectedCandidate(candidate)
        && options.preserveLatestUserImageGroup !== false
      ) {
        continue
      }

      if (!canReplaceCandidate(candidate, options)) {
        continue
      }

      replaceCandidateWithPlaceholder(candidate)
      changed = true
      replacedCount += 1
      if (candidate.oversized) {
        oversizedResolvedCount += 1
      }
    }
  }

  if (
    compressionAvailable
    && !isPayloadWithinHardLimit(payload, candidates, sendHardLimitBytes)
  ) {
    for (const profile of LATEST_COMPRESSION_PROFILES.slice(1)) {
      const profileResult = await applyCompressionProfile(
        payload,
        candidates.filter((candidate) => isProtectedCandidate(candidate)),
        profile,
        options,
        compressionActionsRemaining,
      )
      compressionProfiles.push(
        createCompressionProfileSummary(profile.name, profileResult),
      )
      compressionAttemptedCount += profileResult.attemptedCount
      compressionCacheHitCount += profileResult.cacheHitCount
      compressionNegativeCacheHitCount += profileResult.negativeCacheHitCount
      compressedCount += profileResult.compressedCount
      mergeImageCompressionStatusCounts(
        compressionStatusCounts,
        profileResult.statusCounts,
      )
      mergeImageCompressionDiagnosticCounts(
        compressionDiagnosticCounts,
        profileResult.diagnosticCounts,
      )
      mergeImageCompressionDiagnosticSamples(
        compressionDiagnosticSamples,
        profileResult.diagnosticSamples,
      )
      compressionActionsRemaining -= profileResult.attemptedCount
      changed ||= profileResult.compressedCount > 0
      if (isPayloadWithinHardLimit(payload, candidates, sendHardLimitBytes)) {
        break
      }
    }
  }

  if (
    !isPayloadWithinHardLimit(payload, candidates, sendHardLimitBytes)
    && options.allowReplacingLatestImages === true
  ) {
    const replacementCandidates = [...candidates].sort(compareImageCandidates)
    for (const candidate of replacementCandidates) {
      if (calculateResponsesPayloadBytes(payload) <= sendHardLimitBytes) {
        break
      }

      if (!isProtectedCandidate(candidate) || candidate.replaced) {
        continue
      }

      if (!canReplaceCandidate(candidate, options)) {
        continue
      }

      replaceCandidateWithPlaceholder(candidate)
      changed = true
      replacedCount += 1
      if (candidate.oversized) {
        oversizedResolvedCount += 1
      }
    }
  }

  const finalPayloadBytes = calculateResponsesPayloadBytes(payload)
  const protectedOversizedCount = candidates.filter(
    (candidate) =>
      candidate.oversized
      && !candidate.replaced
      && isProtectedCandidate(candidate),
  ).length
  const unresolvedOversizedCount = candidates.filter(
    (candidate) => candidate.oversized && !candidate.replaced,
  ).length
  const resolvedOversizedCount = Math.max(
    oversizedResolvedCount,
    oversizedInputImageCount - unresolvedOversizedCount,
  )
  const sendAllowed =
    finalPayloadBytes <= sendHardLimitBytes && unresolvedOversizedCount === 0
  const unresolvedReason = getUnresolvedReason({
    candidates,
    compressionAvailable,
    finalPayloadBytes,
    protectedOversizedCount,
    sendAllowed,
    sendHardLimitBytes,
  })

  return createImagePayloadBudgetResult({
    budgetBytes,
    candidates,
    changed,
    finalPayloadBytes,
    initialPayloadBytes,
    nearBudgetRatio,
    oversizedInputImageCount,
    compressionActionLimit,
    compressionAttemptedCount,
    compressionCacheHitCount,
    compressionDiagnosticCounts,
    compressionDiagnosticSamples,
    compressionNegativeCacheHitCount,
    compressionProfiles: compressionProfiles.filter(
      (profile) => profile.attemptedCount > 0,
    ),
    compressionStatusCounts,
    compressedCount,
    oversizedResolvedCount: resolvedOversizedCount,
    payload,
    replacedCount,
    sendHardLimitBytes,
    unresolvedReason,
  })
}

interface InputImageDataUrl {
  decodedBytes: number
  record: ResponseInputImage
}

const sanitizeInputImages = (
  input: Array<ResponseInputItem>,
  shouldReplace: (image: InputImageDataUrl) => boolean,
): number => {
  let count = 0
  for (const image of collectInputImageDataUrls(input)) {
    if (!shouldReplace(image)) {
      continue
    }

    replaceInputImageWithPlaceholder(image)
    count += 1
  }

  return count
}

const collectInputImageDataUrls = (
  input: Array<ResponseInputItem>,
  images: Array<InputImageDataUrl> = [],
): Array<InputImageDataUrl> => {
  for (const item of input) {
    collectInputItemImageDataUrls(item, images)
  }

  return images
}

const collectInputItemImageDataUrls = (
  item: ResponseInputItem,
  images: Array<InputImageDataUrl>,
): void => {
  if (isResponseInputMessage(item)) {
    collectContentImageDataUrls(item.content, images)
  } else if (isResponseFunctionCallOutputItem(item)) {
    collectContentImageDataUrls(item.output, images)
  }
}

const collectContentImageDataUrls = (
  content: string | Array<ResponseInputContent> | undefined,
  images: Array<InputImageDataUrl>,
): void => {
  if (!Array.isArray(content)) {
    return
  }

  for (const block of content) {
    const image = getInputImageDataUrl(block)
    if (image) {
      images.push(image)
    }
  }
}

const getInputImageDataUrl = (
  content: ResponseInputContent,
): InputImageDataUrl | null => {
  if (!isResponseInputImage(content) || typeof content.image_url !== "string") {
    return null
  }

  const imageUrl = content.image_url
  if (!imageUrl.startsWith(DATA_URL_PREFIX)) {
    return null
  }

  const decodedBytes = estimateDataUrlByteLength(imageUrl)

  return {
    decodedBytes,
    record: content,
  }
}

const estimateDataUrlByteLength = (value: string): number => {
  return Math.max(0, Math.floor((value.length * 3) / 4))
}

const replaceInputImageWithPlaceholder = (image: InputImageDataUrl): void => {
  image.record.type = "input_image"
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  image.record.detail = "low"
  delete image.record.file_id
}

const collectImagePayloadBudgetCandidates = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
): Array<ImagePayloadBudgetCandidate> => {
  if (!Array.isArray(payload.input)) {
    return []
  }

  const latestUserImageIndex = getLatestUserImageInputIndex(payload.input)
  const latestImageInputIndex = getLatestImageInputIndex(payload.input)
  const candidates: Array<ImagePayloadBudgetCandidate> = []

  for (let inputIndex = 0; inputIndex < payload.input.length; inputIndex += 1) {
    const item = payload.input[inputIndex]
    const content = getImageContentArray(item)
    if (!content) {
      continue
    }

    for (
      let contentIndex = 0;
      contentIndex < content.length;
      contentIndex += 1
    ) {
      const block = content[contentIndex]
      if (!isResponseInputImage(block) || typeof block.image_url !== "string") {
        continue
      }

      const parsed = parseImageDataUrl(block.image_url)
      if (!parsed) {
        continue
      }

      candidates.push({
        ...parsed,
        content,
        contentIndex,
        dataUrlBytes: Buffer.byteLength(block.image_url, "utf8"),
        group: getImageCandidateGroup({
          input: payload.input,
          inputIndex,
          item,
          latestImageInputIndex,
          latestUserImageIndex,
        }),
        inputIndex,
        oversized: isImageOverLimit(parsed.decodedBytes, maxPromptImageSize),
        record: block,
      })
    }
  }

  return candidates
}

const getImageContentArray = (
  item: ResponseInputItem,
): Array<ResponseInputContent> | null => {
  if (isResponseInputMessage(item) && Array.isArray(item.content)) {
    return item.content
  }

  if (isResponseFunctionCallOutputItem(item) && Array.isArray(item.output)) {
    return item.output
  }

  return null
}

const getLatestUserImageInputIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (!isResponseInputMessage(item) || item.role !== "user") {
      continue
    }
    if (contentHasImageDataUrl(item.content)) {
      return index
    }
  }

  return undefined
}

const getLatestImageInputIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const content = getImageContentArray(input[index])
    if (contentHasImageDataUrl(content)) {
      return index
    }
  }

  return undefined
}

const contentHasImageDataUrl = (
  content: string | Array<ResponseInputContent> | undefined | null,
): boolean =>
  Array.isArray(content)
  && content.some(
    (block) =>
      isResponseInputImage(block)
      && typeof block.image_url === "string"
      && parseImageDataUrl(block.image_url) !== null,
  )

const getImageCandidateGroup = ({
  inputIndex,
  item,
  latestImageInputIndex,
  latestUserImageIndex,
}: {
  input: Array<ResponseInputItem>
  inputIndex: number
  item: ResponseInputItem
  latestImageInputIndex?: number
  latestUserImageIndex?: number
}): ImageBudgetCandidateGroup => {
  if (isResponseInputMessage(item)) {
    if (item.role === "user") {
      return inputIndex === latestUserImageIndex ? "latest_user_group" : (
          "history_user"
        )
    }
    return "unknown"
  }

  if (isResponseFunctionCallOutputItem(item)) {
    if (
      inputIndex === latestImageInputIndex
      || (latestUserImageIndex !== undefined
        && inputIndex > latestUserImageIndex)
    ) {
      return "current_turn_tool_output"
    }
    return "history_tool_output"
  }

  return "unknown"
}

const parseImageDataUrl = (value: string): ParsedImageDataUrl | null => {
  const match = IMAGE_DATA_URL_PATTERN.exec(value)
  if (!match) {
    return null
  }

  const [, mimeType, base64Payload] = match
  const normalizedBase64 = base64Payload.replaceAll(/\s+/g, "")

  return {
    base64Bytes: Buffer.byteLength(normalizedBase64, "utf8"),
    decodedBytes: Buffer.from(normalizedBase64, "base64").byteLength,
    mimeType,
  }
}

const isImageOverLimit = (
  decodedBytes: number,
  maxPromptImageSize?: number,
): boolean =>
  typeof maxPromptImageSize === "number"
  && Number.isFinite(maxPromptImageSize)
  && maxPromptImageSize > 0
  && decodedBytes > maxPromptImageSize

const compareImageCandidates = (
  left: ImagePayloadBudgetCandidate,
  right: ImagePayloadBudgetCandidate,
): number => {
  const groupPriority =
    IMAGE_REPLACEMENT_GROUP_PRIORITY[left.group]
    - IMAGE_REPLACEMENT_GROUP_PRIORITY[right.group]
  if (groupPriority !== 0) {
    return groupPriority
  }

  if (left.inputIndex !== right.inputIndex) {
    return left.inputIndex - right.inputIndex
  }

  return right.dataUrlBytes - left.dataUrlBytes
}

const canReplaceCandidate = (
  candidate: ImagePayloadBudgetCandidate,
  options: ImagePayloadBudgetOptions,
): boolean => {
  if (!isProtectedCandidate(candidate)) {
    return true
  }

  if (options.preserveLatestUserImageGroup === false) {
    return true
  }

  return options.allowReplacingLatestImages === true
}

const isProtectedCandidate = (
  candidate: ImagePayloadBudgetCandidate,
): boolean => PROTECTED_IMAGE_GROUPS.has(candidate.group)

const hasUnsafeOversizedCandidates = (
  candidates: Array<ImagePayloadBudgetCandidate>,
): boolean =>
  candidates.some(
    (candidate) =>
      candidate.oversized
      && !candidate.replaced
      && !isProtectedCandidate(candidate),
  )

const replaceCandidateWithPlaceholder = (
  candidate: ImagePayloadBudgetCandidate,
): void => {
  replaceInputImageWithPlaceholder(candidate)
  const imageUrl = candidate.record.image_url
  if (typeof imageUrl === "string") {
    const parsed = parseImageDataUrl(imageUrl)
    candidate.dataUrlBytes = Buffer.byteLength(imageUrl, "utf8")
    candidate.base64Bytes = parsed?.base64Bytes ?? 0
    candidate.decodedBytes = parsed?.decodedBytes ?? 0
    candidate.mimeType = parsed?.mimeType ?? candidate.mimeType
  }
  candidate.replaced = true
  candidate.oversized = false
  insertImageOmissionMarker(candidate)
}

const insertImageOmissionMarker = (
  candidate: ImagePayloadBudgetCandidate,
): void => {
  candidate.content.splice(candidate.contentIndex + 1, 0, {
    text: createImageOmissionMarkerText(candidate.group),
    type: "input_text",
  })
}

const createImageOmissionMarkerText = (
  group: ImageBudgetCandidateGroup,
): string =>
  `[Local proxy omitted one ${describeImageGroup(group)} because the Copilot Responses payload exceeded the configured image budget. Do not infer the omitted image contents. Ask the user to resend it if needed.]`

const describeImageGroup = (group: ImageBudgetCandidateGroup): string => {
  switch (group) {
    case "history_tool_output":
      return "older tool image"
    case "history_user":
    case "recent_user":
      return "older user image"
    case "latest_user_group":
      return "current user image"
    case "current_turn_tool_output":
    case "latest_tool_visual_context":
      return "current tool image"
    case "referenced_history_visual_context":
      return "referenced earlier image"
    case "unknown":
      return "earlier image"
  }
}

interface ImageCompressionProfileResult {
  attemptedCount: number
  cacheHitCount: number
  compressedCount: number
  diagnosticCounts: ImageCompressionDiagnosticCounts
  diagnosticSamples: Array<ImageCompressionDiagnosticSample>
  negativeCacheHitCount: number
  statusCounts: ImageCompressionStatusCounts
}

const createEmptyCompressionProfileResult =
  (): ImageCompressionProfileResult => ({
    attemptedCount: 0,
    cacheHitCount: 0,
    compressedCount: 0,
    diagnosticCounts: {},
    diagnosticSamples: [],
    negativeCacheHitCount: 0,
    statusCounts: {},
  })

const normalizeImageCompressionResult = (
  result: ImageCompressionAdapterResult | undefined,
): ImageCompressionResult => {
  if (!result) {
    return { diagnostic: "adapter_returned_null", status: "adapter_error" }
  }

  if ("status" in result) {
    return result
  }

  return {
    output: result,
    outputBytes: result.outputBytes,
    status: "compressed",
  }
}

const incrementImageCompressionStatusCount = (
  counts: ImageCompressionStatusCounts,
  status: ImageCompressionStatus,
): void => {
  counts[status] = (counts[status] ?? 0) + 1
}

const mergeImageCompressionStatusCounts = (
  target: ImageCompressionStatusCounts,
  source: ImageCompressionStatusCounts,
): void => {
  for (const [status, count] of Object.entries(source)) {
    if (!count) {
      continue
    }
    target[status as ImageCompressionStatus] =
      (target[status as ImageCompressionStatus] ?? 0) + count
  }
}

const incrementImageCompressionDiagnosticCount = (
  counts: ImageCompressionDiagnosticCounts,
  diagnostic: string,
): void => {
  counts[diagnostic] = (counts[diagnostic] ?? 0) + 1
}

const mergeImageCompressionDiagnosticCounts = (
  target: ImageCompressionDiagnosticCounts,
  source: ImageCompressionDiagnosticCounts,
): void => {
  for (const [diagnostic, count] of Object.entries(source)) {
    if (!count) {
      continue
    }
    target[diagnostic] = (target[diagnostic] ?? 0) + count
  }
}

const mergeImageCompressionDiagnosticSamples = (
  target: Array<ImageCompressionDiagnosticSample>,
  source: Array<ImageCompressionDiagnosticSample>,
): void => {
  for (const sample of source) {
    if (target.some((existing) => existing.diagnostic === sample.diagnostic)) {
      continue
    }
    target.push(sample)
    if (target.length >= 8) {
      return
    }
  }
}

const applyCompressionProfile = async (
  payload: ResponsesPayload,
  candidates: Array<ImagePayloadBudgetCandidate>,
  profile: ImageCompressionProfile,
  options: ImagePayloadBudgetOptions,
  maxAttempts: number,
): Promise<ImageCompressionProfileResult> => {
  if (maxAttempts <= 0) {
    return createEmptyCompressionProfileResult()
  }

  let attemptedCount = 0
  let cacheHitCount = 0
  let compressedCount = 0
  const diagnosticCounts: ImageCompressionDiagnosticCounts = {}
  const diagnosticSamples: Array<ImageCompressionDiagnosticSample> = []
  let negativeCacheHitCount = 0
  const statusCounts: ImageCompressionStatusCounts = {}

  for (const candidate of candidates.sort(compareImageCandidates)) {
    if (attemptedCount >= maxAttempts) {
      break
    }

    if (candidate.replaced) {
      continue
    }

    const dataUrl = candidate.record.image_url
    if (typeof dataUrl !== "string") {
      continue
    }

    attemptedCount += 1
    const compressionResult = normalizeImageCompressionResult(
      await options.compressionAdapter?.compress({
        dataUrl,
        decodedBytes: candidate.decodedBytes,
        group: candidate.group,
        mimeType: candidate.mimeType,
        profile,
      }),
    )
    if (compressionResult.cacheHit === "positive") {
      cacheHitCount += 1
    } else if (compressionResult.cacheHit === "negative") {
      negativeCacheHitCount += 1
    }

    const output = compressionResult.output
    if (compressionResult.diagnostic) {
      incrementImageCompressionDiagnosticCount(
        diagnosticCounts,
        compressionResult.diagnostic,
      )
      if (
        diagnosticSamples.length < 8
        && !diagnosticSamples.some(
          (sample) => sample.diagnostic === compressionResult.diagnostic,
        )
      ) {
        diagnosticSamples.push({
          ...compressionResult.diagnosticDetail,
          dataUrlBytes: candidate.dataUrlBytes,
          decodedBytes: candidate.decodedBytes,
          diagnostic: compressionResult.diagnostic,
          elapsedMs: compressionResult.elapsedMs,
          group: candidate.group,
          inputBytes: compressionResult.inputBytes,
          mimeType: candidate.mimeType,
          outputBytes: compressionResult.outputBytes,
          profile: profile.name,
          status: compressionResult.status,
        })
      }
    }

    if (!output) {
      incrementImageCompressionStatusCount(
        statusCounts,
        compressionResult.status,
      )
      continue
    }

    const parsedOutput = parseImageDataUrl(output.dataUrl)
    if (!parsedOutput) {
      incrementImageCompressionStatusCount(statusCounts, "invalid_data_url")
      continue
    }

    const outputDataUrlBytes = Buffer.byteLength(output.dataUrl, "utf8")
    if (outputDataUrlBytes >= candidate.dataUrlBytes) {
      incrementImageCompressionStatusCount(statusCounts, "no_smaller")
      continue
    }

    incrementImageCompressionStatusCount(statusCounts, compressionResult.status)
    candidate.record.image_url = output.dataUrl
    if (profile.detail && profile.detail !== "keep-original") {
      candidate.record.detail = profile.detail
    }
    candidate.dataUrlBytes = outputDataUrlBytes
    candidate.decodedBytes = parsedOutput.decodedBytes
    candidate.base64Bytes = parsedOutput.base64Bytes
    candidate.mimeType = parsedOutput.mimeType
    candidate.oversized = isImageOverLimit(
      parsedOutput.decodedBytes,
      options.maxPromptImageSize,
    )
    candidate.compressed = true
    compressedCount += 1

    if (isPayloadWithinTarget(payload, candidates, options.budgetBytes)) {
      break
    }
  }

  return {
    attemptedCount,
    cacheHitCount,
    compressedCount,
    diagnosticCounts,
    diagnosticSamples,
    negativeCacheHitCount,
    statusCounts,
  }
}

const createCompressionProfileSummary = (
  profile: ImageCompressionProfile["name"],
  result: ImageCompressionProfileResult,
): ImageCompressionProfileSummary => ({
  attemptedCount: result.attemptedCount,
  compressedCount: result.compressedCount,
  profile,
  statusCounts: result.statusCounts,
})

const shouldCompressProtectedCandidates = (
  payload: ResponsesPayload,
  candidates: Array<ImagePayloadBudgetCandidate>,
  budgetBytes: number,
  sendHardLimitBytes: number,
  nearBudgetRatio: number,
): boolean => {
  const payloadBytes = calculateResponsesPayloadBytes(payload)
  return (
    payloadBytes > budgetBytes * nearBudgetRatio
    || payloadBytes > budgetBytes
    || payloadBytes > sendHardLimitBytes
    || candidates.some(
      (candidate) => candidate.oversized && isProtectedCandidate(candidate),
    )
  )
}

const isPayloadWithinTarget = (
  payload: ResponsesPayload,
  candidates: Array<ImagePayloadBudgetCandidate>,
  budgetBytes = DEFAULT_RESPONSES_PAYLOAD_BUDGET_BYTES,
): boolean =>
  calculateResponsesPayloadBytes(payload) <= budgetBytes
  && !candidates.some((candidate) => candidate.oversized && !candidate.replaced)

const isPayloadWithinHardLimit = (
  payload: ResponsesPayload,
  candidates: Array<ImagePayloadBudgetCandidate>,
  sendHardLimitBytes: number,
): boolean =>
  calculateResponsesPayloadBytes(payload) <= sendHardLimitBytes
  && !candidates.some((candidate) => candidate.oversized && !candidate.replaced)

const getReplacementTargetBytes = ({
  allowNormalReplacement,
  budgetBytes,
  compressionAvailable,
  compressedCount,
  sendHardLimitBytes,
}: {
  allowNormalReplacement: boolean
  budgetBytes: number
  compressionAvailable: boolean
  compressedCount: number
  sendHardLimitBytes: number
}): number =>
  compressionAvailable && (compressedCount > 0 || allowNormalReplacement) ?
    budgetBytes
  : sendHardLimitBytes

const createImagePayloadBudgetResult = ({
  budgetBytes,
  candidates,
  changed,
  compressedCount = 0,
  compressionActionLimit,
  compressionAttemptedCount = 0,
  compressionCacheHitCount = 0,
  compressionDiagnosticCounts = {},
  compressionDiagnosticSamples = [],
  compressionNegativeCacheHitCount = 0,
  compressionProfiles = [],
  compressionStatusCounts = {},
  finalPayloadBytes,
  initialPayloadBytes,
  nearBudgetRatio,
  oversizedInputImageCount,
  oversizedResolvedCount = 0,
  payload,
  replacedCount,
  sendHardLimitBytes,
  unresolvedReason,
}: {
  budgetBytes: number
  candidates: Array<ImagePayloadBudgetCandidate>
  changed: boolean
  compressedCount?: number
  compressionActionLimit?: number
  compressionAttemptedCount?: number
  compressionCacheHitCount?: number
  compressionDiagnosticCounts?: ImageCompressionDiagnosticCounts
  compressionDiagnosticSamples?: Array<ImageCompressionDiagnosticSample>
  compressionNegativeCacheHitCount?: number
  compressionProfiles?: Array<ImageCompressionProfileSummary>
  compressionStatusCounts?: ImageCompressionStatusCounts
  finalPayloadBytes: number
  initialPayloadBytes: number
  nearBudgetRatio: number
  oversizedInputImageCount: number
  oversizedResolvedCount?: number
  payload: ResponsesPayload
  replacedCount: number
  sendHardLimitBytes: number
  unresolvedReason?: ImagePayloadBudgetUnresolvedReason
}): ImagePayloadBudgetResult => {
  const hardLimitMet = finalPayloadBytes <= sendHardLimitBytes
  const unresolvedOversizedCount = candidates.filter(
    (candidate) => candidate.oversized && !candidate.replaced,
  ).length
  const targetMet =
    finalPayloadBytes <= budgetBytes && unresolvedOversizedCount === 0
  const sendAllowed = hardLimitMet && unresolvedOversizedCount === 0
  const replacedCandidates = candidates.filter(
    (candidate) => candidate.replaced,
  )
  const latestImageReplaced = replacedCandidates.some(
    (candidate) => candidate.group === "latest_user_group",
  )
  const currentVisualGroupsAffected = new Set(
    replacedCandidates
      .filter((candidate) => isProtectedCandidate(candidate))
      .map((candidate) => candidate.group),
  ).size
  const inlineImageBytes = candidates.reduce(
    (total, candidate) => total + candidate.dataUrlBytes,
    0,
  )
  const mediaStats = collectPayloadMediaStats(payload)
  const textAndToolBytes = Math.max(
    0,
    finalPayloadBytes - inlineImageBytes - mediaStats.unoptimizableMediaBytes,
  )
  const resolvedUnresolvedReason =
    (
      unresolvedReason === "no_optimizable_images"
      && mediaStats.inputFileDataBytes > 0
    ) ?
      "unoptimizable_file_data"
    : unresolvedReason
  const largestImageBytes = candidates.reduce<number | undefined>(
    (largest, candidate) =>
      largest === undefined ?
        candidate.dataUrlBytes
      : Math.max(largest, candidate.dataUrlBytes),
    undefined,
  )

  return {
    bodyBytesOverBudget: Math.max(0, finalPayloadBytes - budgetBytes),
    budgetBytes,
    candidateCount: candidates.length,
    changed,
    compressionActionLimit,
    compressionActionLimitHit:
      compressionActionLimit !== undefined
      && compressionAttemptedCount >= compressionActionLimit,
    compressionAttemptedCount,
    compressionCacheHitCount,
    compressionDiagnosticCounts,
    compressionDiagnosticSamples,
    compressionNegativeCacheHitCount,
    compressionProfiles,
    compressionStatusCounts,
    compressedCount,
    currentVisualGroupsAffected,
    fileIdCount: mediaStats.fileIdCount,
    finalPayloadBytes,
    hardLimitMet,
    imageCount: candidates.length,
    initialPayloadBytes,
    inlineImageBytes,
    inputFileDataBytes: mediaStats.inputFileDataBytes,
    largestImageBytes,
    largestUnoptimizableKind:
      mediaStats.largestUnoptimizableKind
      ?? (textAndToolBytes > 0 ? "text_or_tool" : undefined),
    latestImageReplaced,
    nearLimit:
      finalPayloadBytes > budgetBytes * nearBudgetRatio
      || finalPayloadBytes > budgetBytes,
    nonImageDataUrlBytes: mediaStats.nonImageDataUrlBytes,
    oversizedInputImageCount,
    oversizedResolvedCount,
    partiallyOmittedGroupCount: currentVisualGroupsAffected,
    preservedLatestCount: candidates.filter(
      (candidate) =>
        candidate.group === "latest_user_group" && !candidate.replaced,
    ).length,
    remoteMediaLocatorCount: mediaStats.remoteMediaLocatorCount,
    replacedCount,
    retryEligible: candidates.length > 0,
    sendAllowed,
    sendHardLimitBytes,
    targetMet,
    textAndToolBytes,
    unoptimizableMediaBytes: mediaStats.unoptimizableMediaBytes,
    unresolvedReason: resolvedUnresolvedReason,
  }
}

const collectPayloadMediaStats = (
  payload: ResponsesPayload,
): PayloadMediaStats => {
  const stats = createEmptyPayloadMediaStats()
  collectPayloadMediaStatsFromValue(payload, [], stats, new WeakSet<object>())
  stats.unoptimizableMediaBytes =
    stats.inputFileDataBytes
    + stats.nonImageDataUrlBytes
    + stats.remoteMediaLocatorBytes
    + stats.fileIdBytes
  return stats
}

const createEmptyPayloadMediaStats = (): PayloadMediaStats => ({
  fileIdBytes: 0,
  fileIdCount: 0,
  inputFileDataBytes: 0,
  largestUnoptimizableBytes: 0,
  nonImageDataUrlBytes: 0,
  remoteMediaLocatorBytes: 0,
  remoteMediaLocatorCount: 0,
  unoptimizableMediaBytes: 0,
})

const collectPayloadMediaStatsFromValue = (
  value: unknown,
  path: Array<string>,
  stats: PayloadMediaStats,
  seen: WeakSet<object>,
): void => {
  if (typeof value === "string") {
    collectStringMediaStats(value, path, stats)
    return
  }

  if (typeof value !== "object" || value === null) {
    return
  }

  if (seen.has(value)) {
    return
  }
  seen.add(value)

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectPayloadMediaStatsFromValue(
        value[index],
        [...path, String(index)],
        stats,
        seen,
      )
    }
    return
  }

  for (const [key, childValue] of Object.entries(value)) {
    collectPayloadMediaStatsFromValue(childValue, [...path, key], stats, seen)
  }
}

const collectStringMediaStats = (
  value: string,
  path: Array<string>,
  stats: PayloadMediaStats,
): void => {
  const bytes = Buffer.byteLength(value, "utf8")

  if (isFileDataPath(path)) {
    stats.inputFileDataBytes += bytes
    recordLargestUnoptimizableKind(stats, "input_file.file_data", bytes)
    return
  }

  if (isFileIdPath(path)) {
    stats.fileIdBytes += bytes
    stats.fileIdCount += 1
    recordLargestUnoptimizableKind(stats, "file_id", bytes)
    return
  }

  if (isRemoteMediaLocatorPath(path) && REMOTE_MEDIA_URL_PATTERN.test(value)) {
    stats.remoteMediaLocatorBytes += bytes
    stats.remoteMediaLocatorCount += 1
    recordLargestUnoptimizableKind(stats, "remote_media_url", bytes)
    return
  }

  const mimeType = DATA_URL_MIME_PATTERN.exec(value)?.[1]?.toLowerCase()
  if (mimeType && !mimeType.startsWith("image/")) {
    stats.nonImageDataUrlBytes += bytes
    recordLargestUnoptimizableKind(stats, "non_image_data_url", bytes)
  }
}

const recordLargestUnoptimizableKind = (
  stats: PayloadMediaStats,
  kind: Exclude<
    ImagePayloadBudgetResult["largestUnoptimizableKind"],
    "text_or_tool" | undefined
  >,
  bytes: number,
): void => {
  if (bytes > stats.largestUnoptimizableBytes) {
    stats.largestUnoptimizableBytes = bytes
    stats.largestUnoptimizableKind = kind
  }
}

const isFileDataPath = (path: Array<string>): boolean =>
  path.at(-1) === "file_data"

const isFileIdPath = (path: Array<string>): boolean => path.at(-1) === "file_id"

const isRemoteMediaLocatorPath = (path: Array<string>): boolean => {
  const key = path.at(-1)
  const parent = path.at(-2)
  return key === "image_url" || (key === "url" && parent === "image_url")
}

const getUnresolvedReason = ({
  candidates,
  compressionAvailable,
  finalPayloadBytes,
  protectedOversizedCount,
  sendAllowed,
  sendHardLimitBytes,
}: {
  candidates: Array<ImagePayloadBudgetCandidate>
  compressionAvailable: boolean
  finalPayloadBytes: number
  protectedOversizedCount: number
  sendAllowed: boolean
  sendHardLimitBytes: number
}): ImagePayloadBudgetUnresolvedReason | undefined => {
  if (sendAllowed) {
    return undefined
  }

  if (candidates.length === 0) {
    return "no_optimizable_images"
  }

  if (protectedOversizedCount > 0 || finalPayloadBytes > sendHardLimitBytes) {
    return "current_visual_working_set_required"
  }

  return compressionAvailable ? "no_smaller_payload" : "compression_unavailable"
}

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ?
    Math.floor(value)
  : fallback

const normalizeCompressionActionLimit = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ?
    Math.floor(value)
  : Number.POSITIVE_INFINITY

const isResponseInputMessage = (
  item: ResponseInputItem,
): item is ResponseInputMessage => {
  return (
    typeof item === "object"
    && item !== null
    && "role" in item
    && typeof item.role === "string"
  )
}

const isResponseFunctionCallOutputItem = (
  item: ResponseInputItem,
): item is ResponseFunctionCallOutputItem => {
  return (
    typeof item === "object"
    && item !== null
    && "type" in item
    && item.type === "function_call_output"
  )
}

const isResponseInputImage = (
  content: ResponseInputContent,
): content is ResponseInputImage => {
  return (
    typeof content === "object"
    && content !== null
    && "type" in content
    && content.type === "input_image"
  )
}

export const resolveResponsesCompactThreshold = (
  modelLimits?: ResponsesModelLimits,
  compactThresholdRatio = DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
): number => {
  const promptLimit = resolveResponsesPromptLimit(modelLimits)
  const ratio =
    (
      Number.isFinite(compactThresholdRatio)
      && compactThresholdRatio > 0
      && compactThresholdRatio <= 1
    ) ?
      compactThresholdRatio
    : DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO
  const ratioThreshold = Math.floor(promptLimit * ratio)
  const headroomThreshold = Math.max(
    1,
    promptLimit - MIN_RESPONSES_COMPACT_HEADROOM_TOKENS,
  )
  return Math.max(1, Math.min(ratioThreshold, headroomThreshold))
}

export const resolveResponsesPromptLimit = (
  modelLimits?: ResponsesModelLimits,
): number => {
  const promptLimit = modelLimits?.max_prompt_tokens
  if (typeof promptLimit === "number" && promptLimit > 0) {
    return promptLimit
  }

  const contextLimit = modelLimits?.max_context_window_tokens
  if (typeof contextLimit === "number" && contextLimit > 0) {
    const outputLimit = modelLimits?.max_output_tokens
    return Math.max(
      1,
      contextLimit
        - (typeof outputLimit === "number" && outputLimit > 0 ?
          outputLimit
        : 0),
    )
  }

  return DEFAULT_RESPONSES_PROMPT_LIMIT_TOKENS
}

const getModelResponsesApiCompactThreshold = (
  model: string,
): number | undefined => {
  const threshold =
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold(model)

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

const createCompactionContextManagement = (
  compactThreshold: number,
): Array<ResponseContextManagementCompactionItem> => [
  {
    type: "compaction",
    compact_threshold: compactThreshold,
  },
]

export type ResponsesContextManagementDecision = {
  owner: "client" | "gateway" | "none"
  injected: boolean
  shouldPruneInput: boolean
}

export const applyResponsesApiContextManagement = (
  payload: ResponsesPayload,
  modelLimits: ResponsesModelLimits | undefined,
  options: {
    compactThresholdRatio?: number
    source: ResponsesApiContextManagementSource
  },
): ResponsesContextManagementDecision => {
  if (hasTerminalCompactionTrigger(payload)) {
    return {
      owner: "client",
      injected: false,
      shouldPruneInput: false,
    }
  }

  if (payload.context_management !== undefined) {
    return {
      owner: "client",
      injected: false,
      shouldPruneInput: false,
    }
  }

  if (!isContextManagementEnabledForSource(options.source)) {
    return {
      owner: "none",
      injected: false,
      shouldPruneInput: false,
    }
  }

  const modelCompactThreshold = getModelResponsesApiCompactThreshold(
    payload.model,
  )
  payload.context_management = createCompactionContextManagement(
    modelCompactThreshold
      ?? resolveResponsesCompactThreshold(
        modelLimits,
        options.compactThresholdRatio
          ?? DEFAULT_RESPONSES_COMPACT_THRESHOLD_RATIO,
      ),
  )
  return {
    owner: "gateway",
    injected: true,
    shouldPruneInput: true,
  }
}

const isContextManagementEnabledForSource = (
  source: ResponsesApiContextManagementSource,
): boolean => {
  if (source === "messages") {
    return responsesUtilsDependencies.isContextManagementEnabledForMessages()
  }

  return responsesUtilsDependencies.isContextManagementEnabledForResponses()
}

const hasTerminalCompactionTrigger = (payload: ResponsesPayload): boolean => {
  const { input } = payload
  if (!Array.isArray(input) || input.length === 0) {
    return false
  }

  return isResponseInputItemType(input.at(-1), "compaction_trigger")
}

export const compactInputByLatestCompaction = (
  payload: ResponsesPayload,
): void => {
  if (!Array.isArray(payload.input) || payload.input.length === 0) {
    return
  }

  const latestCompactionMessageIndex = getLatestCompactionMessageIndex(
    payload.input,
  )

  if (latestCompactionMessageIndex === undefined) {
    return
  }

  payload.input = payload.input.slice(latestCompactionMessageIndex)
}

const getLatestCompactionMessageIndex = (
  input: Array<ResponseInputItem>,
): number | undefined => {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isCompactionInputItem(input[index])) {
      return index
    }
  }

  return undefined
}

const isCompactionInputItem = (value: ResponseInputItem): boolean => {
  return isResponseInputItemType(value, "compaction")
}

const isResponseInputItemType = (value: unknown, type: string): boolean => {
  return (
    typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === type
  )
}

const getPayloadItems = (
  payload: ResponsesPayload,
): Array<ResponseInputItem> => {
  const result: Array<ResponseInputItem> = []

  const { input } = payload

  if (Array.isArray(input)) {
    result.push(...input)
  }

  return result
}

const containsVisionContent = (value: unknown): boolean => {
  if (!value) return false

  if (Array.isArray(value)) {
    return value.some((entry) => containsVisionContent(entry))
  }

  if (typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  const type =
    typeof record.type === "string" ? record.type.toLowerCase() : undefined

  if (type === "input_image") {
    return true
  }

  if (Array.isArray(record.content)) {
    return record.content.some((entry) => containsVisionContent(entry))
  }

  return false
}
