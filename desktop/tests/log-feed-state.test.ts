import { describe, expect, test } from 'bun:test'

import {
  applyLogFeedUpdate,
  createLogFeedState,
} from '../src/lib/log-feed-state'

describe('Dashboard log feed state', () => {
  test('applies snapshot then overlapping batches without duplicate rows', () => {
    let state = createLogFeedState()
    state = applyLogFeedUpdate(
      state,
      {
        kind: 'snapshot',
        snapshot: {
          cursor: 2,
          entries: [
            { cursor: 1, message: 'one' },
            { cursor: 2, message: 'two' },
          ],
        },
      },
      3,
    )
    state = applyLogFeedUpdate(
      state,
      {
        batch: {
          cursor: 4,
          entries: [
            { cursor: 2, message: 'duplicate-two' },
            { cursor: 3, message: 'three' },
            { cursor: 4, message: 'four' },
          ],
          reset: false,
        },
        kind: 'batch',
      },
      3,
    )

    expect(state).toEqual({
      cursor: 4,
      entries: [
        { cursor: 2, message: 'two' },
        { cursor: 3, message: 'three' },
        { cursor: 4, message: 'four' },
      ],
    })
  })

  test('replaces rows on overflow reset and clear without rewinding the cursor', () => {
    const populated = {
      cursor: 5,
      entries: [{ cursor: 5, message: 'old' }],
    }
    const overflowed = applyLogFeedUpdate(
      populated,
      {
        batch: {
          cursor: 8,
          entries: [
            { cursor: 7, message: 'new-seven' },
            { cursor: 8, message: 'new-eight' },
          ],
          reset: true,
        },
        kind: 'batch',
      },
      2,
    )

    expect(overflowed.entries.map((entry) => entry.message)).toEqual([
      'new-seven',
      'new-eight',
    ])
    expect(
      applyLogFeedUpdate(
        overflowed,
        {
          batch: { cursor: 8, entries: [], reset: true },
          kind: 'batch',
        },
        2,
      ),
    ).toEqual({ cursor: 8, entries: [] })
  })

  test('bounds an oversized snapshot to the newest renderer capacity', () => {
    const state = applyLogFeedUpdate(
      createLogFeedState(),
      {
        kind: 'snapshot',
        snapshot: {
          cursor: 5,
          entries: [1, 2, 3, 4, 5].map((cursor) => ({
            cursor,
            message: String(cursor),
          })),
        },
      },
      3,
    )

    expect(state.entries.map((entry) => entry.cursor)).toEqual([3, 4, 5])
  })
})
