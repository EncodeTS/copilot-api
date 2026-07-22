import {
  classifyResponsesStreamTerminalEvent,
  parseResponsesStreamEventData,
} from "~/lib/responses-stream-protocol"
import {
  runResponsesStreamSession,
  type ResponsesStreamSessionChunk,
  type ResponsesStreamSessionFrame,
  type ResponsesStreamSessionOutcome,
} from "~/lib/responses-stream-session"

type SettledFirstRead =
  | { kind: "read"; result: IteratorResult<ResponsesStreamSessionChunk> }
  | { error: unknown; kind: "throw" }

export type PrefetchedResponsesSession =
  | {
      cancel: () => Promise<void>
      kind: "continue"
      source: AsyncIterable<ResponsesStreamSessionChunk>
    }
  | {
      frames: ReadonlyArray<ResponsesStreamSessionFrame>
      kind: "settled"
      outcome: ResponsesStreamSessionOutcome
    }

export const prefetchResponsesStreamSession = async ({
  observeFrame,
  signal,
  source,
}: {
  observeFrame?: (
    frame: ResponsesStreamSessionFrame,
  ) => PromiseLike<void> | void
  signal?: AbortSignal
  source: AsyncIterable<ResponsesStreamSessionChunk>
}): Promise<PrefetchedResponsesSession> => {
  const inner = openResponsesStreamIterator(source)
  const iterator = new PrefetchedResponsesIterator(inner)
  const replaySource: AsyncIterable<ResponsesStreamSessionChunk> = {
    [Symbol.asyncIterator]: () => iterator,
  }
  const first = await peekWithSignal(iterator, signal)

  if (!signal?.aborted && !shouldSettlePrefetchedSession(first)) {
    return {
      cancel: () => iterator.cancel(),
      kind: "continue",
      source: replaySource,
    }
  }

  const frames = new Array<ResponsesStreamSessionFrame>()
  try {
    const outcome = await runResponsesStreamSession({
      onFrame: async (frame) => {
        frames.push(frame)
        await observeFrame?.(frame)
      },
      signal,
      source: replaySource,
    })
    return { frames, kind: "settled", outcome }
  } finally {
    await iterator.cancel()
  }
}

const openResponsesStreamIterator = (
  source: AsyncIterable<ResponsesStreamSessionChunk>,
): AsyncIterator<ResponsesStreamSessionChunk> => {
  try {
    return source[Symbol.asyncIterator]()
  } catch (error) {
    return {
      next: () => {
        throw error
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }
  }
}

class PrefetchedResponsesIterator
  implements AsyncIterator<ResponsesStreamSessionChunk>
{
  private cancellation:
    | Promise<IteratorResult<ResponsesStreamSessionChunk>>
    | undefined
  private firstRead: Promise<SettledFirstRead> | undefined
  private readonly inner: AsyncIterator<ResponsesStreamSessionChunk>
  private replayFirst = true

  constructor(inner: AsyncIterator<ResponsesStreamSessionChunk>) {
    this.inner = inner
  }

  peek(): Promise<SettledFirstRead> {
    this.firstRead ??= Promise.resolve()
      .then(() => this.inner.next())
      .then<SettledFirstRead, SettledFirstRead>(
        (result) => ({
          kind: "read",
          result:
            result.done ? result : (
              { done: false, value: withParsedResult(result.value) }
            ),
        }),
        (error: unknown) => ({ error, kind: "throw" }),
      )
    return this.firstRead
  }

  async next(): Promise<IteratorResult<ResponsesStreamSessionChunk>> {
    if (!this.replayFirst) return this.inner.next()
    this.replayFirst = false
    const first = await this.peek()
    if (first.kind === "throw") throw first.error
    return first.result
  }

  return(
    value?: unknown,
  ): Promise<IteratorResult<ResponsesStreamSessionChunk>> {
    this.replayFirst = false
    this.cancellation ??= callIteratorReturn(this.inner, value)
    return this.cancellation
  }

  throw(error?: unknown): Promise<IteratorResult<ResponsesStreamSessionChunk>> {
    this.replayFirst = false
    if (this.inner.throw) {
      return Promise.resolve().then(() => this.inner.throw!(error))
    }
    return this.return().then(() => {
      throw toError(error, "Responses stream iterator rejected")
    })
  }

  async cancel(): Promise<void> {
    try {
      await this.return()
    } catch {
      // Cleanup is best-effort and cannot replace the typed session outcome.
    }
  }
}

const callIteratorReturn = <T>(
  iterator: AsyncIterator<T>,
  value: unknown,
): Promise<IteratorResult<T>> => {
  if (!iterator.return) {
    return Promise.resolve({ done: true, value: undefined })
  }
  try {
    return Promise.resolve(iterator.return(value))
  } catch (error) {
    return Promise.reject(toError(error, "Responses stream cleanup failed"))
  }
}

const toError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback)

const withParsedResult = (
  chunk: ResponsesStreamSessionChunk,
): ResponsesStreamSessionChunk => {
  if (!chunk.data || chunk.data === "[DONE]" || chunk.event === "ping") {
    return chunk
  }
  return {
    ...chunk,
    parsedResult: parseResponsesStreamEventData(chunk.data),
  }
}

type PrefetchObservation = SettledFirstRead | { kind: "abort" }

const peekWithSignal = async (
  iterator: PrefetchedResponsesIterator,
  signal: AbortSignal | undefined,
): Promise<PrefetchObservation> => {
  if (signal?.aborted) return { kind: "abort" }
  if (!signal) return iterator.peek()

  let onAbort: () => void = () => {}
  const aborted = new Promise<{ kind: "abort" }>((resolve) => {
    onAbort = () => resolve({ kind: "abort" })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([iterator.peek(), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

const shouldSettlePrefetchedSession = (first: PrefetchObservation): boolean => {
  if (first.kind !== "read") return true
  if (first.result.done) return true
  const chunk = first.result.value
  if (chunk.data === "[DONE]") return true
  const parsed = chunk.parsedResult
  return (
    parsed?.kind === "event"
    && classifyResponsesStreamTerminalEvent(parsed.event) !== null
  )
}
