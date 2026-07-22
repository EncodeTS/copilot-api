import { StringDecoder } from 'node:string_decoder'

import type {
  LogFeedBatch,
  LogFeedEntry,
  LogFeedSnapshot,
} from '../../shared-types'

export type { LogFeedBatch, LogFeedEntry, LogFeedSnapshot }

interface LogFeedSubscriber {
  cursor: number
  needsReset: boolean
  receive: (batch: LogFeedBatch) => void
}

export interface LogFeedSubscription {
  id: string
  snapshot: LogFeedSnapshot
  unsubscribe: () => void
}

const ESC_CHAR_CODE = 27
const BEL_CHAR_CODE = 7
const CSI_CHAR_CODE = 0x9b
const MAX_PENDING_ANSI_LENGTH = 4096
type AnsiDiscardMode = 'csi' | 'osc' | 'st'

function codeAt(input: string, index: number): number {
  return input.codePointAt(index) ?? -1
}

function findCsiEnd(input: string, startIndex: number): number | null {
  for (let index = startIndex; index < input.length; index += 1) {
    const code = codeAt(input, index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
  }
  return null
}

function findStringSequenceEnd(
  input: string,
  startIndex: number,
  allowBell: boolean,
): number | null {
  for (let index = startIndex; index < input.length; index += 1) {
    const code = codeAt(input, index)
    if (allowBell && code === BEL_CHAR_CODE) return index + 1
    if (code === ESC_CHAR_CODE && codeAt(input, index + 1) === 92) {
      return index + 2
    }
  }
  return null
}

function sanitizeAnsiChunk(
  input: string,
  activeDiscardMode: AnsiDiscardMode | null,
): {
  discardMode: AnsiDiscardMode | null
  output: string
  pending: string
} {
  let content = input
  if (activeDiscardMode) {
    const discardEnd =
      activeDiscardMode === 'csi' ?
        findCsiEnd(content, 0)
      : findStringSequenceEnd(content, 0, activeDiscardMode === 'osc')
    if (discardEnd === null) {
      return {
        discardMode: activeDiscardMode,
        output: '',
        pending:
          (
            activeDiscardMode !== 'csi'
            && content.endsWith(String.fromCharCode(ESC_CHAR_CODE))
          ) ?
            String.fromCharCode(ESC_CHAR_CODE)
          : '',
      }
    }
    content = content.slice(discardEnd)
  }

  const output: string[] = []
  let plainStart = 0
  let index = 0

  while (index < content.length) {
    const code = codeAt(content, index)
    if (code !== ESC_CHAR_CODE && code !== CSI_CHAR_CODE) {
      index += 1
      continue
    }

    if (index > plainStart) output.push(content.slice(plainStart, index))

    let sequenceEnd: number | null
    let sequenceMode: AnsiDiscardMode | null = null
    if (code === CSI_CHAR_CODE) {
      sequenceMode = 'csi'
      sequenceEnd = findCsiEnd(content, index + 1)
    } else {
      const next = content[index + 1]
      if (next === undefined) sequenceEnd = null
      else if (next === '[') {
        sequenceMode = 'csi'
        sequenceEnd = findCsiEnd(content, index + 2)
      } else if (next === ']') {
        sequenceMode = 'osc'
        sequenceEnd = findStringSequenceEnd(content, index + 2, true)
      } else if (['P', 'X', '^', '_'].includes(next)) {
        sequenceMode = 'st'
        sequenceEnd = findStringSequenceEnd(content, index + 2, false)
      } else {
        sequenceEnd = index + 2
      }
    }

    if (sequenceEnd === null || sequenceEnd > content.length) {
      const pending = content.slice(index)
      return {
        discardMode:
          pending.length > MAX_PENDING_ANSI_LENGTH ? sequenceMode : null,
        output: output.join(''),
        pending: pending.length <= MAX_PENDING_ANSI_LENGTH ? pending : '',
      }
    }

    index = sequenceEnd
    plainStart = sequenceEnd
  }

  if (plainStart < content.length) output.push(content.slice(plainStart))
  return { discardMode: null, output: output.join(''), pending: '' }
}

export class LogFeed {
  readonly capacity: number
  private cursor = 0
  private entries: LogFeedEntry[] = []
  private flushPending = false
  private nextSubscriptionId = 1
  private subscribers = new Map<string, LogFeedSubscriber>()

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('LogFeed capacity must be a positive integer')
    }
    this.capacity = capacity
  }

  append(message: string): void {
    if (message.length === 0) return

    this.cursor += 1
    this.entries.push({ cursor: this.cursor, message })
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity)
    }
    this.scheduleFlush()
  }

  clear(): LogFeedSnapshot {
    this.cursor += 1
    this.entries = []
    for (const subscriber of this.subscribers.values()) {
      subscriber.needsReset = true
    }
    this.scheduleFlush()
    return this.snapshot()
  }

  clearSubscribers(): void {
    this.subscribers.clear()
  }

  snapshot(): LogFeedSnapshot {
    return {
      cursor: this.cursor,
      entries: this.entries.map((entry) => ({ ...entry })),
    }
  }

  subscribe(receive: (batch: LogFeedBatch) => void): LogFeedSubscription {
    const id = String(this.nextSubscriptionId)
    this.nextSubscriptionId += 1
    const snapshot = this.snapshot()
    this.subscribers.set(id, {
      cursor: snapshot.cursor,
      needsReset: false,
      receive,
    })

    return {
      id,
      snapshot,
      unsubscribe: () => {
        this.subscribers.delete(id)
      },
    }
  }

  private scheduleFlush(): void {
    if (this.flushPending || this.subscribers.size === 0) return
    this.flushPending = true
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    this.flushPending = false
    const oldestCursor = this.entries[0]?.cursor ?? this.cursor + 1

    for (const [id, subscriber] of this.subscribers) {
      const overflowed = subscriber.cursor < oldestCursor - 1
      const entries = this.entries
        .filter((entry) => entry.cursor > subscriber.cursor)
        .map((entry) => ({ ...entry }))
      const reset = subscriber.needsReset || overflowed
      if (!reset && entries.length === 0) continue

      subscriber.cursor = this.cursor
      subscriber.needsReset = false
      try {
        subscriber.receive({ cursor: this.cursor, entries, reset })
      } catch {
        this.subscribers.delete(id)
      }
    }
  }
}

export function createLogStream(feed: LogFeed): {
  drained: Promise<void>
  flush: () => void
  handleData: (data: Buffer) => void
  isFlushed: () => boolean
} {
  const decoder = new StringDecoder('utf8')
  let flushed = false
  let discardMode: AnsiDiscardMode | null = null
  let pendingAnsi = ''
  let resolveDrained: () => void = () => undefined
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve
  })

  const appendDecoded = (decoded: string) => {
    const sanitized = sanitizeAnsiChunk(pendingAnsi + decoded, discardMode)
    discardMode = sanitized.discardMode
    pendingAnsi = sanitized.pending
    feed.append(sanitized.output)
  }

  return {
    drained,
    handleData: (data) => {
      if (flushed) return
      appendDecoded(decoder.write(data))
    },
    isFlushed: () => flushed,
    flush: () => {
      if (flushed) return
      flushed = true
      appendDecoded(decoder.end())
      discardMode = null
      pendingAnsi = ''
      resolveDrained()
    },
  }
}
