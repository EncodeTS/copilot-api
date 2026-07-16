import { Worker } from "node:worker_threads"

import type { SupportedEncoding } from "~/lib/tokenizer-encodings"

const WORKER_IDLE_TIMEOUT_MS = 5_000

interface TokenizerJob {
  abort: () => void
  encoding: SupportedEncoding
  id: number
  reject: (reason?: unknown) => void
  resolve: (counts: Array<number>) => void
  signal: AbortSignal
  texts: Array<string>
}

interface TokenizerWorkerResponse {
  counts?: Array<number>
  error?: string
  id: number
}

let activeJob: TokenizerJob | undefined
let idleTimer: NodeJS.Timeout | undefined
let nextJobId = 1
let worker: Worker | undefined
const queue = new Array<TokenizerJob>()

export const countTextsInTokenizerWorker = (
  texts: Array<string>,
  encoding: SupportedEncoding,
  signal: AbortSignal,
): Promise<Array<number>> => {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const job: TokenizerJob = {
      abort: () => {},
      encoding,
      id: nextJobId++,
      reject,
      resolve,
      signal,
      texts,
    }
    job.abort = () => cancelJob(job)
    signal.addEventListener("abort", job.abort, { once: true })
    queue.push(job)
    startNextJob()
  })
}

const startNextJob = () => {
  if (activeJob || queue.length === 0) return
  clearIdleTimer()

  const job = queue.shift()
  if (!job) return
  if (job.signal.aborted) {
    cleanupJob(job)
    rejectWithAbortReason(job)
    startNextJob()
    return
  }

  activeJob = job
  const activeWorker = getWorker()
  activeWorker.postMessage({
    encoding: job.encoding,
    id: job.id,
    texts: job.texts,
  })
}

const getWorker = (): Worker => {
  if (worker) return worker

  const createdWorker = new Worker(getTokenizerWorkerUrl())
  createdWorker.on("message", handleWorkerMessage)
  createdWorker.on("error", (error) =>
    handleWorkerFailure(createdWorker, error),
  )
  createdWorker.on("exit", (code) => {
    if (worker !== createdWorker) return
    worker = undefined
    if (code !== 0) {
      failActiveJob(new Error(`Tokenizer worker exited with code ${code}`))
    }
    startNextJob()
  })
  createdWorker.unref()
  worker = createdWorker
  return createdWorker
}

const handleWorkerMessage = (value: unknown) => {
  if (!isTokenizerWorkerResponse(value)) {
    failActiveJob(
      new TypeError("Tokenizer worker returned an invalid response"),
    )
    return
  }
  if (!activeJob || value.id !== activeJob.id) return

  const job = activeJob
  activeJob = undefined
  cleanupJob(job)
  if (value.error !== undefined) {
    job.reject(new Error(value.error))
  } else if (value.counts) {
    job.resolve(value.counts)
  } else {
    job.reject(new TypeError("Tokenizer worker returned no counts"))
  }
  scheduleIdleTermination()
  startNextJob()
}

const handleWorkerFailure = (failedWorker: Worker, error: Error) => {
  if (worker !== failedWorker) return
  worker = undefined
  failActiveJob(error)
  void failedWorker.terminate()
  startNextJob()
}

const failActiveJob = (error: Error) => {
  const job = activeJob
  activeJob = undefined
  if (job) cleanupJob(job)
  job?.reject(error)
}

const cancelJob = (job: TokenizerJob) => {
  if (activeJob === job) {
    activeJob = undefined
    cleanupJob(job)
    rejectWithAbortReason(job)
    terminateWorker()
    return
  }

  const queuedIndex = queue.indexOf(job)
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1)
    cleanupJob(job)
    rejectWithAbortReason(job)
  }
}

const cleanupJob = (job: TokenizerJob) => {
  job.signal.removeEventListener("abort", job.abort)
}

const rejectWithAbortReason = (job: TokenizerJob) => {
  // Preserve AbortSignal.reason identity, including non-Error reasons.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  job.reject(job.signal.reason)
}

const terminateWorker = () => {
  const terminatedWorker = worker
  worker = undefined
  if (terminatedWorker) {
    void terminatedWorker.terminate().finally(startNextJob)
  } else {
    startNextJob()
  }
}

const scheduleIdleTermination = () => {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = undefined
    if (!activeJob && queue.length === 0) terminateWorker()
  }, WORKER_IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

const clearIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = undefined
}

const getTokenizerWorkerUrl = (): URL =>
  import.meta.url.endsWith(".ts") ?
    new URL("../tokenizer-worker.ts", import.meta.url)
  : new URL("./tokenizer-worker.js", import.meta.url)

const isTokenizerWorkerResponse = (
  value: unknown,
): value is TokenizerWorkerResponse => {
  if (typeof value !== "object" || value === null) return false
  const response = value as Record<string, unknown>
  return (
    typeof response.id === "number"
    && (response.error === undefined || typeof response.error === "string")
    && (response.counts === undefined || isSafeIntegerArray(response.counts))
  )
}

const isSafeIntegerArray = (value: unknown): value is Array<number> =>
  Array.isArray(value)
  && value.every(
    (count: unknown) =>
      typeof count === "number" && Number.isSafeInteger(count),
  )
