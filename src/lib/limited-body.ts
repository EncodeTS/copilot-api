import {
  InvalidContentLengthError,
  RequestBodyTooLargeError,
  type RequestBodyLimitStage,
} from "~/lib/request-body-policy"

export interface BodyByteLimit {
  expectedBytes: bigint | null
  maxBytes: number
  signal?: AbortSignal
  stage: RequestBodyLimitStage
}

type CancellableReader = {
  cancel(reason?: unknown): Promise<void>
}

class BodyByteLedger {
  readonly #expectedBytes: bigint | null
  readonly #maxBytes: number
  readonly #stage: RequestBodyLimitStage
  #bytesRead = 0

  constructor(options: BodyByteLimit) {
    this.#expectedBytes = options.expectedBytes
    this.#maxBytes = options.maxBytes
    this.#stage = options.stage
  }

  add(byteLength: number): void {
    this.#bytesRead += byteLength
    if (
      this.#expectedBytes !== null
      && BigInt(this.#bytesRead) > this.#expectedBytes
    ) {
      throw new InvalidContentLengthError(
        "Content-Length does not match the encoded request body.",
      )
    }
    if (this.#bytesRead > this.#maxBytes) {
      throw new RequestBodyTooLargeError(this.#stage)
    }
  }

  finish(): number {
    if (
      this.#expectedBytes !== null
      && BigInt(this.#bytesRead) !== this.#expectedBytes
    ) {
      throw new InvalidContentLengthError(
        "Content-Length does not match the encoded request body.",
      )
    }
    return this.#bytesRead
  }
}

export const collectLimitedBody = async (
  body: ReadableStream<Uint8Array>,
  options: BodyByteLimit,
): Promise<Uint8Array> => {
  const reader = body.getReader()
  const ledger = new BodyByteLedger(options)
  const chunks: Uint8Array[] = []
  const detachAbort = bindAbort(reader, options.signal)

  try {
    while (true) {
      throwIfAborted(options.signal)
      const { done, value } = await reader.read()
      throwIfAborted(options.signal)
      if (done) {
        break
      }
      ledger.add(value.byteLength)
      chunks.push(value)
    }
    const totalBytes = ledger.finish()
    if (chunks.length === 1) {
      return chunks[0] ?? new Uint8Array()
    }

    const result = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } catch (error) {
    await cancelQuietly(reader, error)
    throw error
  } finally {
    detachAbort()
  }
}

export const createLimitedBodyStream = (
  body: ReadableStream<Uint8Array>,
  options: BodyByteLimit,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  const ledger = new BodyByteLedger(options)
  const detachAbort = bindAbort(reader, options.signal)

  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      detachAbort()
      await reader.cancel(reason)
    },
    async pull(controller) {
      try {
        throwIfAborted(options.signal)
        const { done, value } = await reader.read()
        throwIfAborted(options.signal)
        if (done) {
          ledger.finish()
          detachAbort()
          controller.close()
          return
        }
        ledger.add(value.byteLength)
        controller.enqueue(value)
      } catch (error) {
        detachAbort()
        await cancelQuietly(reader, error)
        controller.error(error)
      }
    },
  })
}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

export const getAbortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason
  ?? Object.assign(new Error("The request was aborted."), {
    name: "AbortError",
  })

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw getAbortReason(signal)
  }
}

const bindAbort = (
  reader: CancellableReader,
  signal: AbortSignal | undefined,
): (() => void) => {
  const cancel = () => {
    void cancelQuietly(reader, getAbortReason(signal))
  }
  signal?.addEventListener("abort", cancel, { once: true })
  return () => signal?.removeEventListener("abort", cancel)
}

const cancelQuietly = async (
  reader: CancellableReader,
  reason: unknown,
): Promise<void> => {
  try {
    await reader.cancel(reason)
  } catch {
    // Cancellation is best-effort after a terminal admission error.
  }
}
