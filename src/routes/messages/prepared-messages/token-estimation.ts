import { collectMediaFacts } from "~/lib/media-facts"
import {
  isSupportedEncoding,
  type SupportedEncoding,
} from "~/lib/tokenizer-encodings"
import { countTextsInTokenizerWorker } from "~/lib/tokenizer-worker-client"
import {
  getTokenizerFromModel,
  type TokenizerSchedulingOptions,
} from "~/lib/tokenizer"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  aggregateResponsesMediaTokens,
  ResponsesMediaAggregationLimitError,
  type ResponsesMediaEstimate,
} from "~/routes/messages/prepared-messages/responses-media-token-aggregation"
import type { ResponsesMediaProfileIdentity } from "~/routes/messages/prepared-messages/responses-media-token-profile"
import {
  collectResponsesSemanticSpans,
  ResponsesSemanticSpanLimitError,
  type ResponsesSemanticSpanCollection,
} from "~/routes/messages/prepared-messages/responses-semantic-spans"

const RESPONSES_ESTIMATE_SAFETY_FACTOR = 1.07

export interface ResponsesTokenEstimateBreakdown {
  readonly media: ResponsesMediaEstimate
  readonly profile: ResponsesMediaProfileIdentity
  readonly safetyFactor: number
  readonly semantic: {
    readonly spans: number
    readonly structuralTokens: number
    readonly tokens: number
  }
}

export interface ResponsesTokenEstimateResult {
  readonly breakdown: ResponsesTokenEstimateBreakdown
  readonly inputTokens: number
}

export const responsesTokenEstimateDependencies: {
  countTexts: (
    texts: Array<string>,
    encoding: SupportedEncoding,
    signal: AbortSignal,
  ) => Promise<Array<number>>
} = {
  countTexts: countTextsInTokenizerWorker,
}

export class ResponsesTokenEstimateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesTokenEstimateLimitError"
  }
}

const collectSemanticSpans = (
  payload: ResponsesPayload,
  signal?: AbortSignal,
): ResponsesSemanticSpanCollection => {
  try {
    return collectResponsesSemanticSpans(payload, signal)
  } catch (error) {
    if (error instanceof ResponsesSemanticSpanLimitError) {
      throw new ResponsesTokenEstimateLimitError(error.message)
    }
    throw error
  }
}

const getSupportedTokenizer = (model: Model): SupportedEncoding => {
  const tokenizer = getTokenizerFromModel(model)
  return isSupportedEncoding(tokenizer) ? tokenizer : "o200k_base"
}

const countSemanticTextTokens = async (
  texts: ReadonlyArray<string>,
  model: Model,
  options: TokenizerSchedulingOptions,
): Promise<number> => {
  if (texts.length === 0) return 0
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const countsPromise = responsesTokenEstimateDependencies.countTexts(
    [...texts],
    getSupportedTokenizer(model),
    signal,
  )
  if (options.yieldControl) {
    void countsPromise.catch(() => undefined)
    await options.yieldControl()
    signal.throwIfAborted()
  }
  const counts = await countsPromise
  signal.throwIfAborted()
  if (
    counts.length !== texts.length
    || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new TypeError("Tokenizer worker returned invalid Responses counts")
  }
  return counts.reduce((total, count) => total + count, 0)
}

const aggregateMediaTokens = (
  payload: ResponsesPayload,
  selectedModel: Model,
  additionalUnknownItems: number,
) => {
  const collection = collectMediaFacts(payload, { protocol: "responses" })
  try {
    return aggregateResponsesMediaTokens(
      collection,
      selectedModel,
      additionalUnknownItems,
    )
  } catch (error) {
    if (error instanceof ResponsesMediaAggregationLimitError) {
      throw new ResponsesTokenEstimateLimitError(error.message)
    }
    throw error
  }
}

export const estimateResponsesInputTokensDetailed = async (
  payload: ResponsesPayload,
  selectedModel: Model,
  options: TokenizerSchedulingOptions = {},
): Promise<ResponsesTokenEstimateResult> => {
  options.signal?.throwIfAborted()
  const semantic = collectSemanticSpans(payload, options.signal)
  const media = aggregateMediaTokens(
    payload,
    selectedModel,
    semantic.unknownMediaItems,
  )
  options.signal?.throwIfAborted()
  const semanticTokens = await countSemanticTextTokens(
    semantic.texts,
    selectedModel,
    options,
  )
  const subtotal =
    semanticTokens + semantic.structuralTokens + media.estimate.tokens
  const inputTokens = Math.ceil(subtotal * RESPONSES_ESTIMATE_SAFETY_FACTOR)

  return Object.freeze({
    breakdown: Object.freeze({
      media: media.estimate,
      profile: media.profile,
      safetyFactor: RESPONSES_ESTIMATE_SAFETY_FACTOR,
      semantic: Object.freeze({
        spans: semantic.texts.length,
        structuralTokens: semantic.structuralTokens,
        tokens: semanticTokens,
      }),
    }),
    inputTokens,
  })
}

export const estimateResponsesInputTokens = async (
  payload: ResponsesPayload,
  selectedModel: Model,
  options: TokenizerSchedulingOptions = {},
): Promise<number> =>
  (await estimateResponsesInputTokensDetailed(payload, selectedModel, options))
    .inputTokens
