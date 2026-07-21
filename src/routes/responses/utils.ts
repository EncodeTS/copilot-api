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
  DEFAULT_RESPONSES_PAYLOAD_BUDGET_BYTES,
  DEFAULT_RESPONSES_PAYLOAD_SEND_HARD_LIMIT_BYTES,
  getModelResponsesApiCompactThreshold as getConfiguredModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages as isConfiguredContextManagementEnabledForMessages,
  isContextManagementEnabledForResponses as isConfiguredContextManagementEnabledForResponses,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import {
  collectMediaFacts,
  type MediaFact,
  type MediaPathSegment,
} from "~/lib/media-facts"

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
  initialCloneCount?: number
}

export interface ImagePayloadBudgetResult {
  budgetInstrumentation: ImagePayloadBudgetInstrumentation
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
  outboundPayload: ResponsesPayload
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

export interface ImagePayloadBudgetInstrumentation {
  clones: number
  decodedBuffers: number
  ledgerMismatches: number
  serializations: number
  traversals: number
}

export interface ImageCompressionProfileSummary {
  attemptedCount: number
  compressedCount: number
  profile: ImageCompressionProfile["name"]
  statusCounts: ImageCompressionStatusCounts
}

interface ImagePayloadBudgetCandidate {
  base64Bytes: number
  contentIndex: number
  dataUrlBytes: number
  decodedBytes: number
  group: ImageBudgetCandidateGroup
  inputIndex: number
  mimeType: string
  oversized: boolean
  path: ReadonlyArray<MediaPathSegment>
  compressed?: boolean
  replaced?: boolean
}

interface ImagePayloadBudgetInventory {
  candidates: Array<ImagePayloadBudgetCandidate>
  mediaStats: PayloadMediaStats
}

interface ImagePayloadBudgetLedger {
  instrumentation: ImagePayloadBudgetInstrumentation
  payloadBytes: number
}

interface ImagePayloadMutationContext {
  candidates: Array<ImagePayloadBudgetCandidate>
  cloned: boolean
  maxPromptImageSize?: number
  originalPayload: ResponsesPayload
  payload: ResponsesPayload
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
  onBase64Decoded?: () => void
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

const DEFAULT_RESPONSES_IMAGE_NEAR_BUDGET_RATIO = 0.92

const IMAGE_DATA_URL_PATTERN =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/u

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

  const instrumentation = createImagePayloadBudgetInstrumentation(
    options.initialCloneCount,
  )
  const initialPayloadBytes = serializeImageBudgetPayload(
    payload,
    instrumentation,
  )
  const inventory = collectImagePayloadBudgetInventory(
    payload,
    options.maxPromptImageSize,
    instrumentation,
  )
  const { candidates, mediaStats } = inventory
  const ledger: ImagePayloadBudgetLedger = {
    instrumentation,
    payloadBytes: initialPayloadBytes,
  }
  const mutationContext: ImagePayloadMutationContext = {
    candidates,
    cloned: instrumentation.clones > 0,
    maxPromptImageSize: options.maxPromptImageSize,
    originalPayload: payload,
    payload,
  }
  const oversizedInputImageCount = candidates.filter(
    (candidate) => candidate.oversized,
  ).length
  const baseResult = createImagePayloadBudgetResult({
    budgetBytes,
    budgetInstrumentation: instrumentation,
    candidates,
    changed: false,
    finalPayloadBytes: initialPayloadBytes,
    initialPayloadBytes,
    nearBudgetRatio,
    mediaStats,
    outboundPayload: payload,
    oversizedInputImageCount,
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
      mutationContext,
      ledger,
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
      !isPayloadWithinTarget(ledger, candidates, budgetBytes)
      && shouldCompressProtectedCandidates(
        ledger,
        candidates,
        budgetBytes,
        sendHardLimitBytes,
        nearBudgetRatio,
      )
    ) {
      const latestSoftResult = await applyCompressionProfile(
        mutationContext,
        ledger,
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
      if (isPayloadWithinTarget(ledger, candidates, budgetBytes)) {
        break
      }
      const profileResult = await applyCompressionProfile(
        mutationContext,
        ledger,
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
    || !isPayloadWithinTarget(ledger, candidates, budgetBytes)
  ) {
    const replacementCandidates = [...candidates].sort(compareImageCandidates)
    for (const candidate of replacementCandidates) {
      const currentBytes = ledger.payloadBytes
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

      replaceCandidateWithPlaceholder(candidate, mutationContext, ledger)
      changed = true
      replacedCount += 1
      if (candidate.oversized) {
        oversizedResolvedCount += 1
      }
    }
  }

  if (
    compressionAvailable
    && !isPayloadWithinHardLimit(ledger, candidates, sendHardLimitBytes)
  ) {
    for (const profile of LATEST_COMPRESSION_PROFILES.slice(1)) {
      const profileResult = await applyCompressionProfile(
        mutationContext,
        ledger,
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
      if (isPayloadWithinHardLimit(ledger, candidates, sendHardLimitBytes)) {
        break
      }
    }
  }

  if (
    !isPayloadWithinHardLimit(ledger, candidates, sendHardLimitBytes)
    && options.allowReplacingLatestImages === true
  ) {
    const replacementCandidates = [...candidates].sort(compareImageCandidates)
    for (const candidate of replacementCandidates) {
      if (ledger.payloadBytes <= sendHardLimitBytes) {
        break
      }

      if (!isProtectedCandidate(candidate) || candidate.replaced) {
        continue
      }

      if (!canReplaceCandidate(candidate, options)) {
        continue
      }

      replaceCandidateWithPlaceholder(candidate, mutationContext, ledger)
      changed = true
      replacedCount += 1
      if (candidate.oversized) {
        oversizedResolvedCount += 1
      }
    }
  }

  const finalPayloadBytes = ledger.payloadBytes
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
    budgetInstrumentation: instrumentation,
    candidates,
    changed,
    finalPayloadBytes,
    initialPayloadBytes,
    nearBudgetRatio,
    mediaStats,
    outboundPayload: mutationContext.payload,
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

  const parsed = parseImageDataUrl(content.image_url)
  if (!parsed) {
    return null
  }

  return {
    decodedBytes: parsed.decodedBytes,
    record: content,
  }
}

const replaceInputImageWithPlaceholder = (image: InputImageDataUrl): void => {
  image.record.type = "input_image"
  image.record.image_url = REDACTED_IMAGE_PLACEHOLDER_DATA_URL
  image.record.detail = "low"
  delete image.record.file_id
}

const createImagePayloadBudgetInstrumentation = (
  initialCloneCount?: number,
): ImagePayloadBudgetInstrumentation => ({
  clones:
    typeof initialCloneCount === "number" && initialCloneCount > 0 ?
      Math.floor(initialCloneCount)
    : 0,
  decodedBuffers: 0,
  ledgerMismatches: 0,
  serializations: 0,
  traversals: 0,
})

const serializeImageBudgetPayload = (
  payload: ResponsesPayload,
  instrumentation: ImagePayloadBudgetInstrumentation,
): number => {
  instrumentation.serializations += 1
  return calculateResponsesPayloadBytes(payload)
}

const collectImagePayloadBudgetInventory = (
  payload: ResponsesPayload,
  maxPromptImageSize?: number,
  instrumentation?: ImagePayloadBudgetInstrumentation,
): ImagePayloadBudgetInventory => {
  if (instrumentation) instrumentation.traversals += 1
  if (!Array.isArray(payload.input)) {
    return { candidates: [], mediaStats: createEmptyPayloadMediaStats() }
  }

  const collection = collectMediaFacts(payload, {
    onBase64Decode: () => {
      if (instrumentation) instrumentation.decodedBuffers += 1
    },
    probeImageHeaders: false,
    protocol: "responses",
  })
  const candidates: Array<ImagePayloadBudgetCandidate> = []
  const mediaStats = createEmptyPayloadMediaStats()
  let latestImageInputIndex: number | undefined
  let latestUserImageIndex: number | undefined

  for (const fact of collection.facts) {
    collectMediaFactStats(fact, mediaStats)
    const candidate = createImagePayloadBudgetCandidate(
      fact,
      maxPromptImageSize,
    )
    if (!candidate) continue
    candidates.push(candidate)
    latestImageInputIndex = Math.max(
      latestImageInputIndex ?? candidate.inputIndex,
      candidate.inputIndex,
    )
    const item = payload.input[candidate.inputIndex]
    if (isResponseInputMessage(item) && item.role === "user") {
      latestUserImageIndex = Math.max(
        latestUserImageIndex ?? candidate.inputIndex,
        candidate.inputIndex,
      )
    }
  }

  for (const candidate of candidates) {
    candidate.group = getImageCandidateGroup({
      inputIndex: candidate.inputIndex,
      item: payload.input[candidate.inputIndex],
      latestImageInputIndex,
      latestUserImageIndex,
    })
  }
  applyStrictestAliasProtection(payload, candidates)
  finalizePayloadMediaStats(mediaStats)
  return { candidates, mediaStats }
}

const applyStrictestAliasProtection = (
  payload: ResponsesPayload,
  candidates: Array<ImagePayloadBudgetCandidate>,
): void => {
  const aliases = new Map<
    ResponseInputImage,
    Array<ImagePayloadBudgetCandidate>
  >()
  for (const candidate of candidates) {
    const record = getCandidateRecord(payload, candidate)
    if (!record) continue
    const group = aliases.get(record) ?? []
    group.push(candidate)
    aliases.set(record, group)
  }
  for (const group of aliases.values()) {
    const strictest = group.reduce((selected, candidate) =>
      (
        IMAGE_REPLACEMENT_GROUP_PRIORITY[candidate.group]
        > IMAGE_REPLACEMENT_GROUP_PRIORITY[selected.group]
      ) ?
        candidate
      : selected,
    )
    for (const candidate of group) candidate.group = strictest.group
  }
}

const createImagePayloadBudgetCandidate = (
  fact: Readonly<MediaFact>,
  maxPromptImageSize?: number,
): ImagePayloadBudgetCandidate | null => {
  if (
    fact.carrier !== "responses.input_image.image_url"
    || fact.referenceKind !== "data-url"
    || !fact.base64?.valid
    || fact.base64.decodedBytes === undefined
    || !fact.mimeType?.startsWith("image/")
  ) {
    return null
  }
  const inputIndex = fact.path[1]
  const contentIndex = fact.path.at(-2)
  if (typeof inputIndex !== "number" || typeof contentIndex !== "number") {
    return null
  }
  return {
    base64Bytes: fact.base64.encodedUtf8Bytes,
    contentIndex,
    dataUrlBytes: fact.encodedUtf8Bytes,
    decodedBytes: fact.base64.decodedBytes,
    group: "unknown",
    inputIndex,
    mimeType: fact.mimeType,
    oversized: isImageOverLimit(fact.base64.decodedBytes, maxPromptImageSize),
    path: fact.path.slice(0, -1),
  }
}

const getImageCandidateGroup = ({
  inputIndex,
  item,
  latestImageInputIndex,
  latestUserImageIndex,
}: {
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
  const paddingCharacters =
    normalizedBase64.endsWith("==") ? 2
    : normalizedBase64.endsWith("=") ? 1
    : 0

  return {
    base64Bytes: Buffer.byteLength(normalizedBase64, "utf8"),
    decodedBytes: Math.max(
      0,
      Math.floor((normalizedBase64.length * 3) / 4) - paddingCharacters,
    ),
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
  context: ImagePayloadMutationContext,
  ledger: ImagePayloadBudgetLedger,
): void => {
  ensureMutableImagePayload(context, ledger.instrumentation)
  const record = localizeCandidatePath(context.payload, candidate)
  const content = getCandidateContent(context.payload, candidate)
  if (!content || !record) return
  const beforeBytes = serializedValueBytes(content)
  replaceInputImageWithPlaceholder({
    decodedBytes: candidate.decodedBytes,
    record,
  })
  const imageUrl = record.image_url
  if (typeof imageUrl === "string") {
    const parsed = parseImageDataUrl(imageUrl)
    candidate.dataUrlBytes = Buffer.byteLength(imageUrl, "utf8")
    candidate.base64Bytes = parsed?.base64Bytes ?? 0
    candidate.decodedBytes = parsed?.decodedBytes ?? 0
    candidate.mimeType = parsed?.mimeType ?? candidate.mimeType
  }
  candidate.replaced = true
  candidate.oversized = false
  insertImageOmissionMarker(candidate, content)
  shiftCandidatePathsAfterInsertion(context, candidate, content)
  reconcileImagePayloadLedger(
    context,
    ledger,
    ledger.payloadBytes + serializedValueBytes(content) - beforeBytes,
  )
}

const insertImageOmissionMarker = (
  candidate: ImagePayloadBudgetCandidate,
  content: Array<ResponseInputContent>,
): void => {
  content.splice(candidate.contentIndex + 1, 0, {
    text: createImageOmissionMarkerText(candidate.group),
    type: "input_text",
  })
}

const shiftCandidatePathsAfterInsertion = (
  context: ImagePayloadMutationContext,
  insertedAfter: ImagePayloadBudgetCandidate,
  content: Array<ResponseInputContent>,
): void => {
  for (const candidate of context.candidates) {
    if (
      candidate === insertedAfter
      || candidate.contentIndex <= insertedAfter.contentIndex
      || getCandidateContent(context.payload, candidate) !== content
    ) {
      continue
    }
    candidate.contentIndex += 1
    candidate.path = [...candidate.path.slice(0, -1), candidate.contentIndex]
  }
}

const ensureMutableImagePayload = (
  context: ImagePayloadMutationContext,
  instrumentation: ImagePayloadBudgetInstrumentation,
): void => {
  if (context.cloned) return
  context.payload = structuredClone(context.originalPayload)
  context.cloned = true
  instrumentation.clones += 1
}

const getCandidateRecord = (
  payload: ResponsesPayload,
  candidate: ImagePayloadBudgetCandidate,
): ResponseInputImage | null => {
  const value = getValueAtMediaPath(payload, candidate.path)
  return isResponseInputImage(value as ResponseInputContent) ?
      (value as ResponseInputImage)
    : null
}

const getCandidateContent = (
  payload: ResponsesPayload,
  candidate: ImagePayloadBudgetCandidate,
): Array<ResponseInputContent> | null => {
  const value = getValueAtMediaPath(payload, candidate.path.slice(0, -1))
  return Array.isArray(value) ? (value as Array<ResponseInputContent>) : null
}

const localizeCandidatePath = (
  payload: ResponsesPayload,
  candidate: ImagePayloadBudgetCandidate,
): ResponseInputImage | null => {
  let container: unknown = payload
  for (const segment of candidate.path) {
    if (typeof container !== "object" || container === null) return null
    const parent = container as Record<string | number, unknown>
    const child = parent[segment]
    if (typeof child !== "object" || child === null) return null
    const localized =
      Array.isArray(child) ? Array.from(child as Array<unknown>) : { ...child }
    parent[segment] = localized
    container = localized
  }
  return isResponseInputImage(container as ResponseInputContent) ?
      (container as ResponseInputImage)
    : null
}

const getValueAtMediaPath = (
  root: unknown,
  path: ReadonlyArray<MediaPathSegment>,
): unknown => {
  let value = root
  for (const segment of path) {
    if (typeof value !== "object" || value === null) return undefined
    value = (value as Record<string | number, unknown>)[segment]
  }
  return value
}

const serializedValueBytes = (value: unknown): number =>
  imageBudgetLedgerDependencies.estimateSerializedValueBytes(value)

export const imageBudgetLedgerDependencies = {
  estimateSerializedValueBytes: (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8"),
}

const reconcileImagePayloadLedger = (
  context: ImagePayloadMutationContext,
  ledger: ImagePayloadBudgetLedger,
  expectedBytes: number,
): void => {
  const actualBytes = serializeImageBudgetPayload(
    context.payload,
    ledger.instrumentation,
  )
  if (actualBytes !== expectedBytes) {
    ledger.instrumentation.ledgerMismatches += 1
    refreshImagePayloadCandidateSemantics(context, ledger.instrumentation)
  }
  ledger.payloadBytes = actualBytes
}

const refreshImagePayloadCandidateSemantics = (
  context: ImagePayloadMutationContext,
  instrumentation: ImagePayloadBudgetInstrumentation,
): void => {
  const refreshed = collectImagePayloadBudgetInventory(
    context.payload,
    context.maxPromptImageSize,
    instrumentation,
  ).candidates
  const previousByPath = new Map(
    context.candidates.map((candidate) => [
      JSON.stringify(candidate.path),
      candidate,
    ]),
  )
  const merged = refreshed.map((candidate) => {
    const previous = previousByPath.get(JSON.stringify(candidate.path))
    if (!previous) return candidate
    const state = {
      compressed: previous.compressed,
      replaced: previous.replaced,
    }
    Object.assign(previous, candidate, state)
    return previous
  })
  context.candidates.splice(0, context.candidates.length, ...merged)
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
  context: ImagePayloadMutationContext,
  ledger: ImagePayloadBudgetLedger,
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

    const currentRecord = getCandidateRecord(context.payload, candidate)
    const dataUrl = currentRecord?.image_url
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
        onBase64Decoded: () => {
          ledger.instrumentation.decodedBuffers += 1
        },
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
    ensureMutableImagePayload(context, ledger.instrumentation)
    const record = localizeCandidatePath(context.payload, candidate)
    if (!record) {
      incrementImageCompressionStatusCount(statusCounts, "invalid_data_url")
      continue
    }
    const beforeBytes = serializedValueBytes(record)
    record.image_url = output.dataUrl
    if (profile.detail && profile.detail !== "keep-original") {
      record.detail = profile.detail
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
    reconcileImagePayloadLedger(
      context,
      ledger,
      ledger.payloadBytes + serializedValueBytes(record) - beforeBytes,
    )

    if (isPayloadWithinTarget(ledger, candidates, options.budgetBytes)) {
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
  ledger: ImagePayloadBudgetLedger,
  candidates: Array<ImagePayloadBudgetCandidate>,
  budgetBytes: number,
  sendHardLimitBytes: number,
  nearBudgetRatio: number,
): boolean => {
  const payloadBytes = ledger.payloadBytes
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
  ledger: ImagePayloadBudgetLedger,
  candidates: Array<ImagePayloadBudgetCandidate>,
  budgetBytes = DEFAULT_RESPONSES_PAYLOAD_BUDGET_BYTES,
): boolean =>
  ledger.payloadBytes <= budgetBytes
  && !candidates.some((candidate) => candidate.oversized && !candidate.replaced)

const isPayloadWithinHardLimit = (
  ledger: ImagePayloadBudgetLedger,
  candidates: Array<ImagePayloadBudgetCandidate>,
  sendHardLimitBytes: number,
): boolean =>
  ledger.payloadBytes <= sendHardLimitBytes
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
  budgetInstrumentation,
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
  mediaStats,
  outboundPayload,
  nearBudgetRatio,
  oversizedInputImageCount,
  oversizedResolvedCount = 0,
  replacedCount,
  sendHardLimitBytes,
  unresolvedReason,
}: {
  budgetBytes: number
  budgetInstrumentation: ImagePayloadBudgetInstrumentation
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
  mediaStats: PayloadMediaStats
  outboundPayload: ResponsesPayload
  nearBudgetRatio: number
  oversizedInputImageCount: number
  oversizedResolvedCount?: number
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

  const result: Omit<ImagePayloadBudgetResult, "outboundPayload"> = {
    bodyBytesOverBudget: Math.max(0, finalPayloadBytes - budgetBytes),
    budgetBytes,
    budgetInstrumentation: { ...budgetInstrumentation },
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
  return Object.defineProperty(result, "outboundPayload", {
    configurable: false,
    enumerable: false,
    value: outboundPayload,
    writable: false,
  }) as ImagePayloadBudgetResult
}

const finalizePayloadMediaStats = (stats: PayloadMediaStats): void => {
  stats.unoptimizableMediaBytes =
    stats.inputFileDataBytes
    + stats.nonImageDataUrlBytes
    + stats.remoteMediaLocatorBytes
    + stats.fileIdBytes
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

const collectMediaFactStats = (
  fact: Readonly<MediaFact>,
  stats: PayloadMediaStats,
): void => {
  const bytes = fact.encodedUtf8Bytes
  if (fact.carrier === "responses.input_file.file_data") {
    stats.inputFileDataBytes += bytes
    recordLargestUnoptimizableKind(stats, "input_file.file_data", bytes)
    return
  }
  if (fact.referenceKind === "file-id") {
    stats.fileIdBytes += bytes
    stats.fileIdCount += 1
    recordLargestUnoptimizableKind(stats, "file_id", bytes)
    return
  }
  if (fact.referenceKind === "remote-url") {
    stats.remoteMediaLocatorBytes += bytes
    stats.remoteMediaLocatorCount += 1
    recordLargestUnoptimizableKind(stats, "remote_media_url", bytes)
    return
  }
  if (fact.referenceKind === "data-url" && fact.mediaKind !== "image") {
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
