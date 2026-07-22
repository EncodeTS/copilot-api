import { Worker } from "node:worker_threads"

import { validateByteLimit } from "~/lib/request-body-policy"
import { admitSingleZstdFrame } from "~/lib/zstd-frame"
import type {
  ZstdWorkerDecoder,
  ZstdWorkerInput,
  ZstdWorkerOutput,
} from "~/lib/zstd-worker-protocol"

export class ZstdDecoderUnavailableError extends Error {
  constructor() {
    super("Bounded zstd decoder is unavailable.")
    this.name = "ZstdDecoderUnavailableError"
  }
}

export class ZstdDecodeError extends Error {
  constructor() {
    super("Failed to decompress zstd request body.")
    this.name = "ZstdDecodeError"
  }
}

export interface ZstdDecodeOptions {
  maxDecodedBytes: number
  signal?: AbortSignal
}

export interface ZstdDecodeOperation {
  active: Promise<ZstdWorkerDecoder>
  closed: Promise<void>
  result: Promise<Uint8Array>
}

export interface ZstdWorkerPort {
  on(event: "error", listener: () => void): ZstdWorkerPort
  on(event: "exit", listener: () => void): ZstdWorkerPort
  on(
    event: "message",
    listener: (message: ZstdWorkerOutput) => void,
  ): ZstdWorkerPort
  terminate(): Promise<number>
}

export type ZstdWorkerFactory = (
  workerData: ZstdWorkerInput,
  transferList: ArrayBuffer[],
) => ZstdWorkerPort

export interface ZstdBodyDecoder {
  decode(
    compressed: Uint8Array,
    options: ZstdDecodeOptions,
  ): Promise<Uint8Array>
  start(compressed: Uint8Array, options: ZstdDecodeOptions): ZstdDecodeOperation
}

export const createZstdBodyDecoder = (
  spawnWorker: ZstdWorkerFactory = spawnDefaultWorker,
): ZstdBodyDecoder => ({
  async decode(compressed, options) {
    return await startWithWorker(compressed, options, spawnWorker).result
  },
  start(compressed, options) {
    return startWithWorker(compressed, options, spawnWorker)
  },
})

const defaultDecoder = createZstdBodyDecoder()

export const decodeZstdBody = (
  compressed: Uint8Array,
  options: ZstdDecodeOptions,
): Promise<Uint8Array> => defaultDecoder.decode(compressed, options)

export const startZstdDecode = (
  compressed: Uint8Array,
  options: ZstdDecodeOptions,
): ZstdDecodeOperation => defaultDecoder.start(compressed, options)

const startWithWorker = (
  compressed: Uint8Array,
  options: ZstdDecodeOptions,
  spawnWorker: ZstdWorkerFactory,
): ZstdDecodeOperation => {
  const maxDecodedBytes = validateByteLimit(
    options.maxDecodedBytes,
    "maxDecodedBytes",
  )
  const admission = admitSingleZstdFrame(compressed, maxDecodedBytes)
  throwIfAborted(options.signal)
  if (admission.zeroOutputProven) {
    return {
      active: Promise.resolve("zero"),
      closed: Promise.resolve(),
      result: Promise.resolve(new Uint8Array()),
    }
  }

  const workerInput = compressed.slice().buffer
  const workerData: ZstdWorkerInput = {
    compressed: workerInput,
    expectedDecodedBytes: admission.decodedBytes,
  }
  let worker: ZstdWorkerPort
  try {
    worker = spawnWorker(workerData, [workerInput])
  } catch {
    throw new ZstdDecoderUnavailableError()
  }

  let resolveActive: ((decoder: ZstdWorkerDecoder) => void) | undefined
  let rejectActive: ((error: unknown) => void) | undefined
  const active = new Promise<ZstdWorkerDecoder>((resolve, reject) => {
    resolveActive = resolve
    rejectActive = reject
  })
  void active.catch(() => undefined)

  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let resolveResult: ((output: Uint8Array) => void) | undefined
  let rejectResult: ((error: unknown) => void) | undefined
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  void result.catch(() => undefined)

  let finalizing = false
  let activeSeen = false
  const finish = async (
    outcome:
      | { output: Uint8Array; type: "success" }
      | { error: unknown; type: "failure" },
  ): Promise<void> => {
    if (finalizing) {
      return
    }
    finalizing = true
    try {
      await worker.terminate()
    } catch {
      // The worker has already exited; lifecycle cleanup is still complete.
    }
    options.signal?.removeEventListener("abort", abortWorker)
    const finalOutcome =
      options.signal?.aborted ?
        {
          error: getAbortReason(options.signal),
          type: "failure" as const,
        }
      : outcome
    if (!activeSeen && finalOutcome.type === "failure") {
      rejectActive?.(finalOutcome.error)
    }
    resolveClosed?.()
    if (finalOutcome.type === "success") {
      resolveResult?.(finalOutcome.output)
    } else {
      rejectResult?.(finalOutcome.error)
    }
  }

  const abortWorker = () => {
    void finish({
      error: getAbortReason(options.signal),
      type: "failure",
    })
  }
  options.signal?.addEventListener("abort", abortWorker, { once: true })

  worker.on("message", (message: ZstdWorkerOutput) => {
    if (message.type === "active") {
      activeSeen = true
      resolveActive?.(message.decoder)
      return
    }
    if (message.type === "result") {
      void finish({ output: new Uint8Array(message.output), type: "success" })
      return
    }
    void finish({
      error:
        message.code === "decoder_unavailable" ?
          new ZstdDecoderUnavailableError()
        : new ZstdDecodeError(),
      type: "failure",
    })
  })
  worker.on("error", () => {
    void finish({ error: new ZstdDecodeError(), type: "failure" })
  })
  worker.on("exit", () => {
    if (!finalizing) {
      void finish({
        error: new ZstdDecodeError(),
        type: "failure",
      })
    }
  })

  if (options.signal?.aborted) {
    abortWorker()
  }
  return { active, closed, result }
}

function spawnDefaultWorker(
  workerData: ZstdWorkerInput,
  transferList: ArrayBuffer[],
): ZstdWorkerPort {
  return new Worker(resolveWorkerUrl(), {
    transferList,
    workerData,
  })
}

const resolveWorkerUrl = (): URL =>
  new URL(
    import.meta.url.endsWith(".ts") ? "../zstd-worker.ts" : "./zstd-worker.js",
    import.meta.url,
  )

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw getAbortReason(signal)
  }
}

const getAbortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason
  ?? Object.assign(new Error("The request was aborted."), {
    name: "AbortError",
  })
