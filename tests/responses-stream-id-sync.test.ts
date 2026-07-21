import { expect, test } from "bun:test"

import {
  createStreamIdTracker,
  fixParsedStreamIds,
  fixStreamIds,
} from "../src/routes/responses/stream-id-sync"
import type { ResponseStreamEvent } from "../src/services/copilot/create-responses"

test("stream ID sync preserves exact wire JSON when IDs already agree", () => {
  const tracker = createStreamIdTracker()
  const addedData =
    '{ "type": "response.output_item.added", "sequence_number": 0, "output_index": 2, "item": { "type": "message", "id": "item-stable" } }'
  const added = JSON.parse(addedData) as ResponseStreamEvent
  expect(fixParsedStreamIds(addedData, added, tracker)).toBe(addedData)

  const deltaData =
    '{ "type": "response.output_text.delta", "sequence_number": 1, "output_index": 2, "item_id": "item-stable", "delta": "hello" }'
  expect(
    fixParsedStreamIds(
      deltaData,
      JSON.parse(deltaData) as ResponseStreamEvent,
      tracker,
    ),
  ).toBe(deltaData)

  const doneData =
    '{ "type": "response.output_item.done", "sequence_number": 2, "output_index": 2, "item": { "type": "message", "id": "item-stable" } }'
  expect(
    fixParsedStreamIds(
      doneData,
      JSON.parse(doneData) as ResponseStreamEvent,
      tracker,
    ),
  ).toBe(doneData)
})

test("stream ID sync serializes only when it creates or repairs an ID", () => {
  const tracker = createStreamIdTracker()
  const addedData = JSON.stringify({
    item: { type: "message" },
    output_index: 0,
    sequence_number: 0,
    type: "response.output_item.added",
  })
  const fixedAdded = fixParsedStreamIds(
    addedData,
    JSON.parse(addedData) as ResponseStreamEvent,
    tracker,
  )
  const generatedId = (JSON.parse(fixedAdded) as { item: { id: string } }).item
    .id
  expect(generatedId).toStartWith("oi_0_")

  const deltaData = JSON.stringify({
    delta: "hello",
    item_id: "upstream-mismatch",
    output_index: 0,
    sequence_number: 1,
    type: "response.output_text.delta",
  })
  expect(JSON.parse(fixStreamIds(deltaData, undefined, tracker))).toMatchObject(
    {
      item_id: generatedId,
    },
  )

  const doneData = JSON.stringify({
    item: { id: "upstream-done-mismatch", type: "message" },
    output_index: 0,
    sequence_number: 2,
    type: "response.output_item.done",
  })
  expect(
    JSON.parse(
      fixParsedStreamIds(
        doneData,
        JSON.parse(doneData) as ResponseStreamEvent,
        tracker,
      ),
    ),
  ).toMatchObject({ item: { id: generatedId } })
})

test("stream ID sync leaves untracked output and non-output events unchanged", () => {
  const tracker = createStreamIdTracker()
  const doneData =
    '{"type":"response.output_item.done","sequence_number":1,"output_index":9,"item":{"type":"message","id":"untracked"}}'
  expect(
    fixParsedStreamIds(
      doneData,
      JSON.parse(doneData) as ResponseStreamEvent,
      tracker,
    ),
  ).toBe(doneData)

  const createdData =
    '{"type":"response.created","sequence_number":2,"response":{}}'
  expect(
    fixParsedStreamIds(
      createdData,
      JSON.parse(createdData) as ResponseStreamEvent,
      tracker,
    ),
  ).toBe(createdData)
})
