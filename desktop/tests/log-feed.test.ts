import { describe, expect, test } from 'bun:test'

import {
  LogFeed,
  createLogStream,
  type LogFeedBatch,
} from '../electron/log-feed'

async function flushBatches(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

describe('Desktop LogFeed', () => {
  test('retains only the newest capacity entries with monotonic cursors', () => {
    const feed = new LogFeed(3)

    for (const message of ['one', 'two', 'three', 'four', 'five']) {
      feed.append(message)
    }

    expect(feed.snapshot()).toEqual({
      cursor: 5,
      entries: [
        { cursor: 3, message: 'three' },
        { cursor: 4, message: 'four' },
        { cursor: 5, message: 'five' },
      ],
    })
  })

  test('atomically snapshots then batches later entries without loss or duplication', async () => {
    const feed = new LogFeed(4)
    feed.append('before')
    const batches: LogFeedBatch[] = []

    const subscription = feed.subscribe((batch) => batches.push(batch))
    feed.append('after-one')
    feed.append('after-two')
    await flushBatches()

    expect(subscription.snapshot).toEqual({
      cursor: 1,
      entries: [{ cursor: 1, message: 'before' }],
    })
    expect(batches).toEqual([
      {
        cursor: 3,
        entries: [
          { cursor: 2, message: 'after-one' },
          { cursor: 3, message: 'after-two' },
        ],
        reset: false,
      },
    ])
  })

  test('bounds a capacity-plus-N burst and marks an overflow reset', async () => {
    const feed = new LogFeed(3)
    const batches: LogFeedBatch[] = []
    feed.subscribe((batch) => batches.push(batch))

    for (const message of ['one', 'two', 'three', 'four', 'five']) {
      feed.append(message)
    }
    await flushBatches()

    expect(batches).toEqual([
      {
        cursor: 5,
        entries: [
          { cursor: 3, message: 'three' },
          { cursor: 4, message: 'four' },
          { cursor: 5, message: 'five' },
        ],
        reset: true,
      },
    ])
  })

  test('clear advances the feed revision and resets subscribers while unsubscribe stops delivery', async () => {
    const feed = new LogFeed(3)
    feed.append('before-clear')
    const batches: LogFeedBatch[] = []
    const subscription = feed.subscribe((batch) => batches.push(batch))

    expect(feed.clear()).toEqual({ cursor: 2, entries: [] })
    await flushBatches()
    expect(batches).toEqual([{ cursor: 2, entries: [], reset: true }])

    subscription.unsubscribe()
    feed.append('after-unsubscribe')
    await flushBatches()
    expect(batches).toHaveLength(1)
    expect(feed.snapshot()).toEqual({
      cursor: 3,
      entries: [{ cursor: 3, message: 'after-unsubscribe' }],
    })
  })

  test('decodes split UTF-8 and strips ANSI sequences split across chunks', () => {
    const feed = new LogFeed(4)
    const stream = createLogStream(feed)
    const encoded = Buffer.from('中文')

    stream.handleData(encoded.subarray(0, 2))
    stream.handleData(encoded.subarray(2))
    stream.handleData(Buffer.from('\u001b[3'))
    stream.handleData(Buffer.from('1mred\u001b[0'))
    stream.handleData(Buffer.from('m'))
    stream.flush()

    expect(feed.snapshot().entries.map((entry) => entry.message)).toEqual([
      '中文',
      'red',
    ])
  })

  test('evicts a throwing subscriber without blocking later subscribers', async () => {
    const feed = new LogFeed(3)
    let throwingCalls = 0
    const received: LogFeedBatch[] = []
    feed.subscribe(() => {
      throwingCalls += 1
      throw new Error('renderer disappeared')
    })
    feed.subscribe((batch) => received.push(batch))

    feed.append('first')
    await flushBatches()
    feed.append('second')
    await flushBatches()

    expect(throwingCalls).toBe(1)
    expect(received).toHaveLength(2)
    expect(received[1]?.entries).toEqual([{ cursor: 2, message: 'second' }])
  })

  test('discards an overlong unterminated ANSI string until its terminator', () => {
    const feed = new LogFeed(4)
    const stream = createLogStream(feed)

    stream.handleData(Buffer.from(`\u001b]0;${'x'.repeat(5000)}`))
    stream.handleData(Buffer.from('must-not-leak'))
    stream.handleData(Buffer.from('\u0007safe'))
    stream.flush()

    expect(feed.snapshot().entries.map((entry) => entry.message)).toEqual([
      'safe',
    ])
  })

  test('does not let BEL terminate an overlong DCS before a split ST', () => {
    const feed = new LogFeed(4)
    const stream = createLogStream(feed)

    stream.handleData(Buffer.from(`\u001bP${'x'.repeat(5000)}`))
    stream.handleData(Buffer.from('\u0007must-not-leak\u001b'))
    stream.handleData(Buffer.from('\\safe'))
    stream.flush()

    expect(feed.snapshot().entries.map((entry) => entry.message)).toEqual([
      'safe',
    ])
  })
})
