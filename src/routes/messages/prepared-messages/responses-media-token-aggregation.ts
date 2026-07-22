import type { MediaFactCollection } from "~/lib/media-facts"
import type { Model } from "~/services/copilot/get-models"

import {
  RESPONSES_UNKNOWN_MEDIA_TOKENS,
  type ResponsesMediaProfileIdentity,
  selectResponsesMediaTokenProfile,
} from "~/routes/messages/prepared-messages/responses-media-token-profile"

export interface ResponsesMediaEstimate {
  readonly facts: number
  readonly fileItems: number
  readonly imageItems: number
  readonly tokens: number
  readonly unknownItems: number
}

export interface ResponsesMediaAggregation {
  readonly estimate: ResponsesMediaEstimate
  readonly profile: ResponsesMediaProfileIdentity
}

export class ResponsesMediaAggregationLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResponsesMediaAggregationLimitError"
  }
}

export const aggregateResponsesMediaTokens = (
  collection: MediaFactCollection,
  model: Model,
  additionalUnknownItems: number,
): ResponsesMediaAggregation => {
  if (collection.stats.truncated) {
    throw new ResponsesMediaAggregationLimitError(
      `Responses media fact collection was truncated: ${collection.warnings.join(",")}`,
    )
  }

  const profile = selectResponsesMediaTokenProfile(model)
  let fileItems = 0
  let imageItems = 0
  let tokens = additionalUnknownItems * RESPONSES_UNKNOWN_MEDIA_TOKENS
  let unknownItems = additionalUnknownItems
  for (const fact of collection.facts) {
    const factEstimate = profile.estimateFact(fact)
    tokens += factEstimate.tokens
    if (fact.mediaKind === "file") fileItems += 1
    if (fact.mediaKind === "image") imageItems += 1
    if (factEstimate.unknown) unknownItems += 1
  }

  return Object.freeze({
    estimate: Object.freeze({
      facts: collection.facts.length,
      fileItems,
      imageItems,
      tokens,
      unknownItems,
    }),
    profile: profile.identity,
  })
}
