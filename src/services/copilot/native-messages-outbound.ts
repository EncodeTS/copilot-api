import type { ConsolaInstance } from "consola"

import { getNativeMessagesOutboundAdmissionProfile } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, logDiagnosticEvent } from "~/lib/logger"
import { iterateAnthropicCanonicalContent } from "~/lib/media-facts"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

export type NativeMessagesOutboundEndpoint = "generation" | "token_count"

export interface NativeMessagesOutboundDiagnostic {
  admitted: 0 | 1
  bodyBytes: number
  bodyBytesOverLimit: number
  /** 0 is generation; 1 is native token count. */
  endpoint: 0 | 1
  hardEnforcement: 0 | 1
  imageSourceDataBytes: number
  imageSourceDataCount: number
  largestImageSourceDataBytes: number
  largestImageSourceDataBytesOverLimit: number
}

export interface NativeMessagesOutboundArtifact {
  readonly body: string
  readonly diagnostic: Readonly<NativeMessagesOutboundDiagnostic>
}

const logger = createHandlerLogger("native-messages-outbound")

const reportDiagnostic = (
  fields: NativeMessagesOutboundDiagnostic,
  target: ConsolaInstance = logger,
): void => {
  logDiagnosticEvent(target, "info", "native_messages.outbound_admission", {
    ...fields,
  })
}

export const nativeMessagesOutboundDependencies = {
  getAdmissionProfile: getNativeMessagesOutboundAdmissionProfile,
  reportDiagnostic,
}

export class NativeMessagesOutboundAdmissionError extends HTTPError {}

export const prepareNativeMessagesOutbound = (
  payload: AnthropicMessagesPayload,
  endpoint: NativeMessagesOutboundEndpoint,
): NativeMessagesOutboundArtifact => {
  const body = JSON.stringify(payload)
  const bodyBytes = Buffer.byteLength(body, "utf8")
  const imageSourceData = measureImageSourceData(payload)
  const profile = nativeMessagesOutboundDependencies.getAdmissionProfile()
  const bodyBytesOverLimit = overLimit(bodyBytes, profile.maxBodyBytes)
  const largestImageSourceDataBytesOverLimit = overLimit(
    imageSourceData.largestBytes,
    profile.maxImageSourceDataBytes,
  )
  const violatesHardLimit =
    bodyBytesOverLimit > 0 || largestImageSourceDataBytesOverLimit > 0
  const admitted = profile.hardEnforcement && violatesHardLimit ? 0 : 1
  const diagnostic = Object.freeze({
    admitted,
    bodyBytes,
    bodyBytesOverLimit,
    endpoint: endpoint === "generation" ? 0 : 1,
    hardEnforcement: profile.hardEnforcement ? 1 : 0,
    imageSourceDataBytes: imageSourceData.totalBytes,
    imageSourceDataCount: imageSourceData.count,
    largestImageSourceDataBytes: imageSourceData.largestBytes,
    largestImageSourceDataBytesOverLimit,
  })

  nativeMessagesOutboundDependencies.reportDiagnostic(diagnostic)
  if (admitted === 0) {
    throw createAdmissionError(diagnostic)
  }

  return Object.freeze({ body, diagnostic })
}

const overLimit = (bytes: number, limit: number | undefined): number =>
  limit === undefined ? 0 : Math.max(0, bytes - limit)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface ImageSourceDataMetrics {
  count: number
  largestBytes: number
  totalBytes: number
}

const measureImageSourceData = (
  payload: AnthropicMessagesPayload,
): ImageSourceDataMetrics => {
  let count = 0
  let largestBytes = 0
  let totalBytes = 0

  for (const event of iterateAnthropicCanonicalContent(payload)) {
    if (event.kind !== "block" || !isRecord(event.value)) continue
    const source = isRecord(event.value.source) ? event.value.source : undefined
    if (
      event.value.type !== "image"
      || source?.type !== "base64"
      || typeof source.data !== "string"
    ) {
      continue
    }
    const bytes = Buffer.byteLength(source.data, "utf8")
    count += 1
    largestBytes = Math.max(largestBytes, bytes)
    totalBytes += bytes
  }

  return { count, largestBytes, totalBytes }
}

const createAdmissionError = (
  diagnostic: NativeMessagesOutboundDiagnostic,
): NativeMessagesOutboundAdmissionError =>
  new NativeMessagesOutboundAdmissionError(
    "Native Messages outbound request exceeds configured limits",
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "request_too_large",
          message: "Native Messages outbound request exceeds configured limits",
          details: {
            body_bytes: diagnostic.bodyBytes,
            body_bytes_over_limit: diagnostic.bodyBytesOverLimit,
            image_source_data_bytes: diagnostic.imageSourceDataBytes,
            image_source_data_count: diagnostic.imageSourceDataCount,
            largest_image_source_data_bytes:
              diagnostic.largestImageSourceDataBytes,
            largest_image_source_data_bytes_over_limit:
              diagnostic.largestImageSourceDataBytesOverLimit,
          },
        },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 413,
      },
    ),
  )
