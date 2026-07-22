import { collectAnthropicMediaFacts } from "~/lib/media-facts/anthropic-visitor"
import { collectChatMediaFacts } from "~/lib/media-facts/chat-visitor"
import { FactCollector, isRecord } from "~/lib/media-facts/collector"
import { collectResponsesMediaFacts } from "~/lib/media-facts/responses-visitor"
import type {
  CollectMediaFactsOptions,
  MediaFactCollection,
} from "~/lib/media-facts/types"

export const collectMediaFactsFromPayload = (
  value: unknown,
  options: CollectMediaFactsOptions,
): MediaFactCollection => {
  const collector = new FactCollector(options)
  const rootVisit = collector.visit(value, 0)
  if (!rootVisit.accepted || !isRecord(value) || !rootVisit.ancestor) {
    return collector.result()
  }

  if (options.protocol === "responses") {
    collectResponsesMediaFacts(value, rootVisit.ancestor, collector)
  } else if (options.protocol === "chat") {
    collectChatMediaFacts(value, rootVisit.ancestor, collector)
  } else {
    collectAnthropicMediaFacts(value, rootVisit.ancestor, collector)
  }
  return collector.result()
}
