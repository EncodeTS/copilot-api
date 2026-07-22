import type { LogFeedEntry, LogFeedUpdate } from '../types/ipc'

export interface LogFeedState {
  cursor: number
  entries: LogFeedEntry[]
}

export function createLogFeedState(): LogFeedState {
  return { cursor: 0, entries: [] }
}

function newestEntries(
  entries: LogFeedEntry[],
  capacity: number,
): LogFeedEntry[] {
  const byCursor = new Map<number, LogFeedEntry>()
  for (const entry of entries) byCursor.set(entry.cursor, entry)
  return [...byCursor.values()]
    .sort((left, right) => left.cursor - right.cursor)
    .slice(-capacity)
}

export function applyLogFeedUpdate(
  state: LogFeedState,
  update: LogFeedUpdate,
  capacity: number,
): LogFeedState {
  if (!Number.isSafeInteger(capacity) || capacity < 1) return state

  if (update.kind === 'snapshot') {
    if (update.snapshot.cursor < state.cursor) return state
    return {
      cursor: update.snapshot.cursor,
      entries: newestEntries(update.snapshot.entries, capacity),
    }
  }

  const { batch } = update
  if (batch.cursor < state.cursor) return state
  const entries =
    batch.reset ?
      batch.entries
    : [
        ...state.entries,
        ...batch.entries.filter((entry) => entry.cursor > state.cursor),
      ]
  return {
    cursor: batch.cursor,
    entries: newestEntries(entries, capacity),
  }
}
