export const OPENAI_REASONING_CARRIER_SIGNATURE_PREFIX =
  "copilot-api-openai-reasoning-v1:"
export const OPENAI_REASONING_CARRIER_V2_SIGNATURE_PREFIX =
  "copilot-api-openai-reasoning-v2:"

export interface ReasoningCarrierEndpoint {
  model: string
  provider: string
}

interface ReasoningCarrierEnvelopeV2 {
  item: unknown
  origin: "openai-responses"
  source: ReasoningCarrierEndpoint
  version: 2
}

export interface DecodedVersionedReasoningCarrier {
  item: unknown
  source?: ReasoningCarrierEndpoint
}

export const encodeVersionedReasoningCarrier = (
  item: unknown,
  source: ReasoningCarrierEndpoint,
): string =>
  `${OPENAI_REASONING_CARRIER_V2_SIGNATURE_PREFIX}${Buffer.from(
    JSON.stringify({
      item,
      origin: "openai-responses",
      source,
      version: 2,
    } satisfies ReasoningCarrierEnvelopeV2),
    "utf8",
  ).toString("base64url")}`

export const decodeVersionedReasoningCarrier = (
  signature: string,
): DecodedVersionedReasoningCarrier | undefined => {
  const isV2 = signature.startsWith(
    OPENAI_REASONING_CARRIER_V2_SIGNATURE_PREFIX,
  )
  const isV1 = signature.startsWith(OPENAI_REASONING_CARRIER_SIGNATURE_PREFIX)
  if (!isV2 && !isV1) {
    return undefined
  }

  const prefix =
    isV2 ?
      OPENAI_REASONING_CARRIER_V2_SIGNATURE_PREFIX
    : OPENAI_REASONING_CARRIER_SIGNATURE_PREFIX
  const encoded = signature.slice(prefix.length)
  if (!encoded) {
    return undefined
  }

  try {
    const value: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    )
    if (!isV2) {
      return { item: value }
    }
    if (
      !isRecord(value)
      || value.version !== 2
      || value.origin !== "openai-responses"
      || !isReasoningCarrierEndpoint(value.source)
    ) {
      return undefined
    }
    return { item: value.item, source: value.source }
  } catch {
    return undefined
  }
}

const LEGACY_OPENAI_REASONING_CARRIER_ALPHABET = /^[A-Za-z0-9+/_=-]+$/u

export const parseLegacyOpenAIReasoningCarrierSignature = (
  signature: string,
): { encryptedContent: string; id: string } | undefined => {
  const splitIndex = signature.lastIndexOf("@")
  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return undefined
  }

  const encryptedContent = signature.slice(0, splitIndex)
  const id = signature.slice(splitIndex + 1)
  const idLooksLikeReasoning =
    /^rs(?:_|$)/u.test(id)
    || (id.length >= 64 && LEGACY_OPENAI_REASONING_CARRIER_ALPHABET.test(id))

  if (
    encryptedContent.length < 64
    || !LEGACY_OPENAI_REASONING_CARRIER_ALPHABET.test(encryptedContent)
    || !idLooksLikeReasoning
  ) {
    return undefined
  }

  return { encryptedContent, id }
}

export const isOpenAIReasoningCarrierSignature = (signature: string): boolean =>
  signature.startsWith(OPENAI_REASONING_CARRIER_SIGNATURE_PREFIX)
  || signature.startsWith(OPENAI_REASONING_CARRIER_V2_SIGNATURE_PREFIX)
  || parseLegacyOpenAIReasoningCarrierSignature(signature) !== undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isReasoningCarrierEndpoint = (
  value: unknown,
): value is ReasoningCarrierEndpoint =>
  isRecord(value)
  && typeof value.provider === "string"
  && value.provider.length > 0
  && typeof value.model === "string"
  && value.model.length > 0
