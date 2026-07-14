import consola, { type ConsolaInstance } from "consola"

import {
  getResponsesImageNearBudgetRatio,
  getResponsesImageCompressionCacheBytes,
  getResponsesImageCompressionCacheEntries,
  getResponsesImageCompressionConcurrency,
  getResponsesImageCompressionFormat,
  getResponsesImageCompressionMaxActionsPerRequest,
  getResponsesImageCompressionTimeoutMs,
  getResponsesImageDecodeSafetyLimits,
  getResponsesPayloadBudgetBytes,
  getResponsesPayloadRetryBudgetBytes,
  getResponsesPayloadSendHardLimitBytes,
  isResponsesImageLatestReplacementAllowedOnHardLimit,
  isResponsesImageLatestReplacementAllowedOnRetry,
  isResponsesImageNormalReplacementAllowed,
  isResponsesImageOptimizationEnabled,
  isResponsesImageCompressionEnabled,
  shouldPreserveLatestUserImageGroup,
  shouldResponsesImageRetryRequireHttp,
} from "~/lib/config"
import { HTTPError, LocalPayloadTooLargeError } from "~/lib/error"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import { state } from "~/lib/state"
import type {
  createResponses as createCopilotResponses,
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesTransport,
} from "~/services/copilot/create-responses"
import {
  buildResponsesWebSocketPayload,
  ensureEncryptedReasoningIncluded,
} from "~/services/copilot/create-responses"

import {
  calculateResponsesPayloadBytes,
  optimizeInputImagesForPayloadBudget,
  type ImageCompressionAdapter,
  type ImagePayloadBudgetResult,
} from "./utils"
import { createSharpImageCompressionAdapter } from "./image-compression"

type CreateResponses = typeof createCopilotResponses
type CreateResponsesOptions = Parameters<CreateResponses>[1]

const imageCompressionAdapters = new Map<string, ImageCompressionAdapter>()

export interface OptimizedResponsesCreateOptions {
  createResponses: CreateResponses
  logger?: Pick<ConsolaInstance, "debug" | "info" | "warn">
  maxPromptImageSize?: number
  requestOptions: CreateResponsesOptions
  selectedModel?: {
    supported_endpoints?: Array<string>
  }
}

export const createOptimizedCopilotResponses = async (
  payload: ResponsesPayload,
  options: OptimizedResponsesCreateOptions,
): Promise<CreateResponsesReturn> => {
  ensureEncryptedReasoningIncluded(payload)
  const originalPayload = cloneResponsesPayload(payload)
  const firstPrepare = await prepareCopilotResponsesPayloadForSend(payload, {
    ...options,
    mode: "normal",
  })

  const firstRequestOptions = {
    ...options.requestOptions,
    transport: resolveEffectiveTransport(
      options.requestOptions.transport,
      firstPrepare.imageBudget,
      options.selectedModel,
    ),
  }

  try {
    return await options.createResponses(payload, firstRequestOptions)
  } catch (error) {
    if (
      !shouldRetryAfterPayloadTooLarge(error, firstRequestOptions.transport)
    ) {
      throw error
    }

    const retryPayload = cloneResponsesPayload(originalPayload)
    const retryPrepare = await prepareCopilotResponsesPayloadForSend(
      retryPayload,
      {
        ...options,
        mode: "retry",
        requestOptions: {
          ...options.requestOptions,
          transport: "http",
        },
      },
    )

    if (
      !retryPrepare.imageBudget.changed
      && retryPrepare.imageBudget.finalPayloadBytes
        >= firstPrepare.imageBudget.finalPayloadBytes
    ) {
      throw error
    }

    options.logger?.warn?.(
      "Retrying Copilot Responses request after payload-too-large image optimization",
      {
        finalPayloadBytes: retryPrepare.imageBudget.finalPayloadBytes,
        initialPayloadBytes: firstPrepare.imageBudget.finalPayloadBytes,
        replacedCount: retryPrepare.imageBudget.replacedCount,
      },
    )

    return await options.createResponses(retryPayload, {
      ...options.requestOptions,
      transport: "http",
    })
  }
}

interface PrepareOptions extends OptimizedResponsesCreateOptions {
  mode: "normal" | "retry"
}

export const prepareCopilotResponsesPayloadForSend = async (
  payload: ResponsesPayload,
  options: PrepareOptions,
): Promise<{ imageBudget: ImagePayloadBudgetResult }> => {
  payload.service_tier = undefined
  ensureEncryptedReasoningIncluded(payload)
  const sendHardLimitBytes = getResponsesSendHardLimitForTransport(
    payload,
    getResponsesPayloadSendHardLimitBytes(),
    options.requestOptions,
  )
  const imageBudget = await optimizeInputImagesForPayloadBudget(payload, {
    allowNormalReplacement: isResponsesImageNormalReplacementAllowed(),
    allowReplacingLatestImages:
      isResponsesImageLatestReplacementAllowedOnHardLimit()
      || (options.mode === "retry"
        && isResponsesImageLatestReplacementAllowedOnRetry()),
    budgetBytes:
      options.mode === "retry" ?
        getResponsesPayloadRetryBudgetBytes()
      : getResponsesPayloadBudgetBytes(),
    compressionAdapter: getConfiguredImageCompressionAdapter(payload),
    compressionEnabled: isResponsesImageCompressionEnabled(),
    enabled: isResponsesImageOptimizationEnabled(),
    maxCompressionActions: getResponsesImageCompressionMaxActionsPerRequest(),
    maxPromptImageSize: options.maxPromptImageSize,
    nearBudgetRatio: getResponsesImageNearBudgetRatio(),
    preserveLatestUserImageGroup: shouldPreserveLatestUserImageGroup(),
    sendHardLimitBytes,
  })

  logImageBudgetResult(options.logger, imageBudget, options.mode)

  if (!imageBudget.sendAllowed) {
    throw new LocalPayloadTooLargeError(
      "Request body exceeds the configured Copilot Responses payload budget and no safe image downgrade remains.",
      {
        bodyBytesOverBudget: imageBudget.bodyBytesOverBudget,
        budgetBytes: imageBudget.budgetBytes,
        candidateCount: imageBudget.candidateCount,
        compressionActionLimit: imageBudget.compressionActionLimit,
        compressionActionLimitHit: imageBudget.compressionActionLimitHit,
        compressionAttemptedCount: imageBudget.compressionAttemptedCount,
        compressionCacheHitCount: imageBudget.compressionCacheHitCount,
        compressionDiagnosticCounts: imageBudget.compressionDiagnosticCounts,
        compressionDiagnosticSamples: imageBudget.compressionDiagnosticSamples,
        compressionNegativeCacheHitCount:
          imageBudget.compressionNegativeCacheHitCount,
        compressionProfiles: imageBudget.compressionProfiles,
        compressionStatusCounts: imageBudget.compressionStatusCounts,
        compressedCount: imageBudget.compressedCount,
        currentVisualWorkingSetReplaced:
          imageBudget.currentVisualGroupsAffected > 0,
        fileDataBytes: imageBudget.inputFileDataBytes,
        hardLimitMet: imageBudget.hardLimitMet,
        imageBytes: imageBudget.inlineImageBytes,
        imageCount: imageBudget.imageCount,
        largestImageBytes: imageBudget.largestImageBytes,
        largestUnoptimizableKind: imageBudget.largestUnoptimizableKind,
        latestImageReplaced: imageBudget.latestImageReplaced,
        oversizedInputImageCount: imageBudget.oversizedInputImageCount,
        oversizedResolvedCount: imageBudget.oversizedResolvedCount,
        payloadBytes: imageBudget.finalPayloadBytes,
        preservedLatestCount: imageBudget.preservedLatestCount,
        replacedCount: imageBudget.replacedCount,
        sendHardLimitBytes: imageBudget.sendHardLimitBytes,
        targetMet: imageBudget.targetMet,
        textAndToolBytes: imageBudget.textAndToolBytes,
        unresolvedReason: imageBudget.unresolvedReason,
      },
    )
  }

  return { imageBudget }
}

export const getResponsesSendHardLimitForTransport = (
  payload: ResponsesPayload,
  configuredLimitBytes: number,
  requestOptions: Pick<CreateResponsesOptions, "initiator" | "transport">,
): number => {
  if (requestOptions.transport !== "websocket") {
    return configuredLimitBytes
  }

  const payloadBytes = calculateResponsesPayloadBytes(payload)
  const websocketBytes = calculateResponsesPayloadBytes(
    buildResponsesWebSocketPayload(payload, requestOptions.initiator),
  )
  const transportOverheadBytes = Math.max(0, websocketBytes - payloadBytes)
  return Math.max(1, configuredLimitBytes - transportOverheadBytes)
}

const getConfiguredImageCompressionAdapter = (
  payload: ResponsesPayload,
): ImageCompressionAdapter | undefined => {
  if (!isResponsesImageCompressionEnabled()) {
    return undefined
  }

  const decodeLimits = getResponsesImageDecodeSafetyLimits()
  const options = {
    cacheBytes: getResponsesImageCompressionCacheBytes(),
    cacheEntries: getResponsesImageCompressionCacheEntries(),
    concurrency: getResponsesImageCompressionConcurrency(),
    decodeMaxBytesEstimate: decodeLimits.maxBytesEstimate,
    decodeMaxFrames: decodeLimits.maxFrames,
    decodeMaxLongEdge: decodeLimits.maxLongEdge,
    decodeMaxPixels: decodeLimits.maxPixels,
    format: getResponsesImageCompressionFormat(),
    namespace: [
      "copilot",
      state.accountType ?? "unknown-account",
      payload.model,
    ].join(":"),
    timeoutMs: getResponsesImageCompressionTimeoutMs(),
  }
  const key = JSON.stringify(options)
  let adapter = imageCompressionAdapters.get(key)
  if (!adapter) {
    adapter = createSharpImageCompressionAdapter(options)
    imageCompressionAdapters.set(key, adapter)
  }

  return adapter
}

const resolveEffectiveTransport = (
  requestedTransport: ResponsesTransport | undefined,
  imageBudget: ImagePayloadBudgetResult,
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
): ResponsesTransport | undefined => {
  if (
    requestedTransport !== "websocket"
    || !shouldResponsesImageRetryRequireHttp()
    || !canUseHttpResponses(selectedModel)
  ) {
    return requestedTransport
  }

  if (imageBudget.changed || imageBudget.nearLimit || !imageBudget.targetMet) {
    return "http"
  }

  return requestedTransport
}

const canUseHttpResponses = (
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
): boolean => getResponsesEndpointCapabilities(selectedModel).http

const shouldRetryAfterPayloadTooLarge = (
  error: unknown,
  transport: ResponsesTransport | undefined,
): boolean =>
  transport === "http"
  && error instanceof HTTPError
  && error.response.status === 413

const logImageBudgetResult = (
  logger: Pick<ConsolaInstance, "debug" | "info" | "warn"> | undefined,
  result: ImagePayloadBudgetResult,
  mode: "normal" | "retry",
): void => {
  const payload = {
    bodyBytesOverBudget: result.bodyBytesOverBudget,
    budgetBytes: result.budgetBytes,
    changed: result.changed,
    compressionActionLimit: result.compressionActionLimit,
    compressionActionLimitHit: result.compressionActionLimitHit,
    compressionAttemptedCount: result.compressionAttemptedCount,
    compressionCacheHitCount: result.compressionCacheHitCount,
    compressionDiagnosticCounts: result.compressionDiagnosticCounts,
    compressionDiagnosticSamples: result.compressionDiagnosticSamples,
    compressionNegativeCacheHitCount: result.compressionNegativeCacheHitCount,
    compressionProfiles: result.compressionProfiles,
    compressionStatusCounts: result.compressionStatusCounts,
    compressedCount: result.compressedCount,
    currentVisualGroupsAffected: result.currentVisualGroupsAffected,
    finalPayloadBytes: result.finalPayloadBytes,
    hardLimitMet: result.hardLimitMet,
    imageCount: result.imageCount,
    initialPayloadBytes: result.initialPayloadBytes,
    inlineImageBytes: result.inlineImageBytes,
    inputFileDataBytes: result.inputFileDataBytes,
    largestImageBytes: result.largestImageBytes,
    largestUnoptimizableKind: result.largestUnoptimizableKind,
    latestImageReplaced: result.latestImageReplaced,
    mode,
    nearLimit: result.nearLimit,
    oversizedInputImageCount: result.oversizedInputImageCount,
    oversizedResolvedCount: result.oversizedResolvedCount,
    preservedLatestCount: result.preservedLatestCount,
    replacedCount: result.replacedCount,
    sendHardLimitBytes: result.sendHardLimitBytes,
    targetMet: result.targetMet,
    textAndToolBytes: result.textAndToolBytes,
    unresolvedReason: result.unresolvedReason,
  }

  if (!result.sendAllowed || result.replacedCount > 0) {
    logger?.warn("responses.image_budget", payload)
  } else if (result.changed) {
    logger?.info("responses.image_budget", payload)
  } else {
    logger?.debug("responses.image_budget", payload)
  }

  if (!result.sendAllowed || result.changed || mode === "retry") {
    const summary = createImageBudgetConsoleSummary(result, mode)
    if (!result.sendAllowed || result.replacedCount > 0) {
      consola.warn(summary)
    } else {
      consola.info(summary)
    }
  }
}

const createImageBudgetConsoleSummary = (
  result: ImagePayloadBudgetResult,
  mode: "normal" | "retry",
): string => {
  const status =
    !result.sendAllowed ? "blocked"
    : result.targetMet ? "target-met"
    : "hard-limit-met"
  const parts = [
    `responses.image_budget ${status}`,
    `mode=${mode}`,
    `payload=${formatBytes(result.initialPayloadBytes)}->${formatBytes(
      result.finalPayloadBytes,
    )}`,
    `budget=${formatBytes(result.budgetBytes)}`,
    `hard=${formatBytes(result.sendHardLimitBytes)}`,
    `images=${result.imageCount}`,
    `attempted=${result.compressionAttemptedCount}`,
    `compressed=${result.compressedCount}`,
    `replaced=${result.replacedCount}`,
    `latestReplaced=${result.latestImageReplaced}`,
  ]

  if (result.unresolvedReason) {
    parts.push(`reason=${result.unresolvedReason}`)
  }
  if (result.bodyBytesOverBudget > 0) {
    parts.push(`overBudget=${formatBytes(result.bodyBytesOverBudget)}`)
  }
  if (result.largestImageBytes !== undefined) {
    parts.push(`largestImage=${formatBytes(result.largestImageBytes)}`)
  }
  if (result.compressionActionLimitHit) {
    parts.push(`compressionLimitHit=${result.compressionActionLimit}`)
  }
  if (result.compressionCacheHitCount > 0) {
    parts.push(`cacheHit=${result.compressionCacheHitCount}`)
  }
  if (result.compressionNegativeCacheHitCount > 0) {
    parts.push(`negativeCacheHit=${result.compressionNegativeCacheHitCount}`)
  }
  const compressionDiagnostics = formatCompressionStatusCounts(
    result.compressionDiagnosticCounts,
  )
  if (compressionDiagnostics) {
    parts.push(`diagnostics=${compressionDiagnostics}`)
  }
  const compressionStatuses = formatCompressionStatusCounts(
    result.compressionStatusCounts,
  )
  if (compressionStatuses) {
    parts.push(`compression=${compressionStatuses}`)
  }
  if (result.compressionProfiles.length > 0) {
    parts.push(
      `profiles=${result.compressionProfiles
        .map(
          (profile) =>
            `${profile.profile}:${profile.attemptedCount}/${profile.compressedCount}`,
        )
        .join(",")}`,
    )
  }

  return parts.join(" ")
}

const formatCompressionStatusCounts = (
  counts: Partial<Record<string, number>>,
): string =>
  Object.entries(counts)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",")

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown"
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KiB`
  }
  const mib = bytes / 1024 / 1024
  return `${mib.toFixed(mib >= 10 ? 1 : 2)}MiB`
}

const cloneResponsesPayload = (payload: ResponsesPayload): ResponsesPayload =>
  structuredClone(payload)
