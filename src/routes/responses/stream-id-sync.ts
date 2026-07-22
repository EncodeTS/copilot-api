/**
 * Stream ID Synchronization for @ai-sdk/openai compatibility
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * item in 'added' vs 'done' events. This breaks @ai-sdk/openai which expects
 * consistent IDs across the stream lifecycle.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 */

import type {
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

interface StreamIdTracker {
  outputItems: Map<number, string>
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

export const fixStreamIds = (
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string => {
  if (!data) return data
  const parsed = JSON.parse(data) as ResponseStreamEvent
  return fixParsedStreamIds(data, parsed, tracker, event)
}

export const fixParsedStreamIds = (
  data: string,
  parsed: ResponseStreamEvent,
  tracker: StreamIdTracker,
  wireEvent: string | undefined = parsed.type,
): string => {
  switch (wireEvent) {
    case "response.output_item.added": {
      return handleOutputItemAddedData(
        data,
        parsed as ResponseOutputItemAddedEvent,
        tracker,
      )
    }
    case "response.output_item.done": {
      return handleOutputItemDoneData(
        data,
        parsed as ResponseOutputItemDoneEvent,
        tracker,
      )
    }
    default: {
      return handleItemIdData(data, parsed, tracker)
    }
  }
}

const handleOutputItemAddedData = (
  data: string,
  parsed: ResponseOutputItemAddedEvent,
  tracker: StreamIdTracker,
): string => {
  if (parsed.item.id) {
    tracker.outputItems.set(parsed.output_index, parsed.item.id)
    return data
  }

  let randomSuffix = ""
  while (randomSuffix.length < 16) {
    randomSuffix += Math.random().toString(36).slice(2)
  }
  const id = `oi_${parsed.output_index}_${randomSuffix.slice(0, 16)}`
  tracker.outputItems.set(parsed.output_index, id)
  return JSON.stringify({ ...parsed, item: { ...parsed.item, id } })
}

const handleOutputItemDoneData = (
  data: string,
  parsed: ResponseOutputItemDoneEvent,
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index
  const originalId = tracker.outputItems.get(outputIndex)
  if (!originalId || parsed.item.id === originalId) return data
  return JSON.stringify({
    ...parsed,
    item: { ...parsed.item, id: originalId },
  })
}

const handleItemIdData = (
  data: string,
  parsed: ResponseStreamEvent & { output_index?: number; item_id?: string },
  tracker: StreamIdTracker,
): string => {
  const outputIndex = parsed.output_index
  if (outputIndex !== undefined) {
    const itemId = tracker.outputItems.get(outputIndex)
    if (itemId && parsed.item_id !== itemId) {
      return JSON.stringify({ ...parsed, item_id: itemId })
    }
  }
  return data
}
