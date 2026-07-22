import { Worker } from "node:worker_threads"

import type { SupportedEncoding } from "~/lib/tokenizer-encodings"

const WORKER_IDLE_TIMEOUT_MS = 5_000
export const TOKENIZER_WORKER_MAX_PENDING_JOBS = 32
export const TOKENIZER_WORKER_MAX_PENDING_CODE_UNITS = 8 * 1024 * 1024

export type TokenizerWorkerBusyLimitKind = "code_units" | "jobs"

export class TokenizerWorkerBusyError extends Error {
  readonly code = "tokenizer_worker_busy"
  readonly limitKind: TokenizerWorkerBusyLimitKind
  readonly pendingCodeUnits: number
  readonly pendingJobs: number
  readonly requestedCodeUnits: number

  constructor(
    limitKind: TokenizerWorkerBusyLimitKind,
    details: {
      pendingCodeUnits: number
      pendingJobs: number
      requestedCodeUnits: number
    },
  ) {
    super(
      limitKind === "jobs" ?
        "Tokenizer worker is busy: pending job limit reached"
      : "Tokenizer worker is busy: pending code-unit limit reached",
    )
    this.name = "TokenizerWorkerBusyError"
    this.limitKind = limitKind
    this.pendingCodeUnits = details.pendingCodeUnits
    this.pendingJobs = details.pendingJobs
    this.requestedCodeUnits = details.requestedCodeUnits
  }
}

interface TokenizerJob {
  accounted: boolean
  abort: () => void
  codeUnits: number
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

export interface TokenizerWorkerTransport {
  onError: (listener: (error: Error) => void) => void
  onExit: (listener: (code: number) => void) => void
  onMessage: (listener: (value: unknown) => void) => void
  postMessage: (value: unknown) => void
  terminate: () => Promise<number>
  unref: () => void
}

export const tokenizerWorkerClientDependencies: {
  createWorker: (url: URL) => TokenizerWorkerTransport
} = {
  createWorker: (url) => {
    const worker = new Worker(url)
    return {
      onError: (listener) => {
        worker.on("error", listener)
      },
      onExit: (listener) => {
        worker.on("exit", listener)
      },
      onMessage: (listener) => {
        worker.on("message", listener)
      },
      postMessage: (value) => {
        worker.postMessage(value)
      },
      terminate: () => worker.terminate(),
      unref: () => {
        worker.unref()
      },
    }
  },
}

/** Aggregate worker load only; no tokenized text or job identity is exposed. */
export interface TokenizerWorkerLoadSnapshot {
  readonly activeJobs: number
  readonly pendingCodeUnits: number
  readonly pendingJobs: number
  readonly queuedJobs: number
}

let activeJob: TokenizerJob | undefined
let idleTimer: NodeJS.Timeout | undefined
let nextJobId = 1
let pendingCodeUnits = 0
let pendingJobs = 0
let worker: TokenizerWorkerTransport | undefined
const queue = new Array<TokenizerJob>()

export const getTokenizerWorkerLoadSnapshot =
  (): TokenizerWorkerLoadSnapshot => ({
    activeJobs: activeJob ? 1 : 0,
    pendingCodeUnits,
    pendingJobs,
    queuedJobs: queue.length,
  })

export const closeIdleTokenizerWorker = async (): Promise<void> => {
  if (
    activeJob
    || queue.length > 0
    || pendingJobs !== 0
    || pendingCodeUnits !== 0
  ) {
    throw new Error("Cannot close tokenizer worker while jobs are pending")
  }
  clearIdleTimer()
  const idleWorker = worker
  worker = undefined
  if (idleWorker) await idleWorker.terminate()
}

export const countTextsInTokenizerWorker = (
  texts: Array<string>,
  encoding: SupportedEncoding,
  signal: AbortSignal,
): Promise<Array<number>> => {
  signal.throwIfAborted()
  const codeUnits = texts.reduce((total, text) => total + text.length, 0)
  const limitKind = getWorkerBusyLimitKind(codeUnits)
  if (limitKind) {
    return Promise.reject(
      new TokenizerWorkerBusyError(limitKind, {
        pendingCodeUnits,
        pendingJobs,
        requestedCodeUnits: codeUnits,
      }),
    )
  }
  return new Promise((resolve, reject) => {
    const job: TokenizerJob = {
      accounted: false,
      abort: () => {},
      codeUnits,
      encoding,
      id: nextJobId++,
      reject,
      resolve,
      signal,
      texts,
    }
    job.abort = () => cancelJob(job)
    signal.addEventListener("abort", job.abort, { once: true })
    accountPendingJob(job)
    queue.push(job)
    startNextJob()
  })
}

const getWorkerBusyLimitKind = (
  requestedCodeUnits: number,
): TokenizerWorkerBusyLimitKind | undefined => {
  if (pendingJobs >= TOKENIZER_WORKER_MAX_PENDING_JOBS) return "jobs"
  if (
    requestedCodeUnits > TOKENIZER_WORKER_MAX_PENDING_CODE_UNITS
    || pendingCodeUnits
      > TOKENIZER_WORKER_MAX_PENDING_CODE_UNITS - requestedCodeUnits
  ) {
    return "code_units"
  }
  return undefined
}

const startNextJob = () => {
  if (activeJob || queue.length === 0) return
  clearIdleTimer()

  const job = queue.shift()
  if (!job) return
  if (job.signal.aborted) {
    finishPendingJob(job)
    rejectWithAbortReason(job)
    startNextJob()
    return
  }

  activeJob = job
  try {
    const activeWorker = getWorker()
    activeWorker.postMessage({
      encoding: job.encoding,
      id: job.id,
      texts: job.texts,
    })
  } catch (error) {
    failActiveJob(error instanceof Error ? error : new Error(String(error)))
    terminateWorker()
  }
}

const getWorker = (): TokenizerWorkerTransport => {
  if (worker) return worker

  const createdWorker = tokenizerWorkerClientDependencies.createWorker(
    getTokenizerWorkerUrl(),
  )
  createdWorker.onMessage((value) => handleWorkerMessage(createdWorker, value))
  createdWorker.onError((error) => handleWorkerFailure(createdWorker, error))
  createdWorker.onExit((code) => handleWorkerExit(createdWorker, code))
  createdWorker.unref()
  worker = createdWorker
  return createdWorker
}

const handleWorkerMessage = (
  sourceWorker: TokenizerWorkerTransport,
  value: unknown,
) => {
  if (worker !== sourceWorker) return
  if (!isTokenizerWorkerResponse(value)) {
    handleWorkerFailure(
      sourceWorker,
      new TypeError("Tokenizer worker returned an invalid response"),
    )
    return
  }
  if (!activeJob || value.id !== activeJob.id) return

  const job = activeJob
  activeJob = undefined
  finishPendingJob(job)
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

const handleWorkerFailure = (
  failedWorker: TokenizerWorkerTransport,
  error: Error,
) => {
  if (worker !== failedWorker) return
  worker = undefined
  failActiveJob(error)
  void failedWorker.terminate().finally(startNextJob)
}

const handleWorkerExit = (
  exitedWorker: TokenizerWorkerTransport,
  code: number,
) => {
  if (worker !== exitedWorker) return
  worker = undefined
  if (activeJob) {
    failActiveJob(
      new Error(
        code === 0 ?
          "Tokenizer worker exited before completing its active job"
        : `Tokenizer worker exited with code ${code}`,
      ),
    )
  }
  startNextJob()
}

const failActiveJob = (error: Error) => {
  const job = activeJob
  activeJob = undefined
  if (job) finishPendingJob(job)
  job?.reject(error)
}

const cancelJob = (job: TokenizerJob) => {
  if (activeJob === job) {
    activeJob = undefined
    finishPendingJob(job)
    rejectWithAbortReason(job)
    terminateWorker()
    return
  }

  const queuedIndex = queue.indexOf(job)
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1)
    finishPendingJob(job)
    rejectWithAbortReason(job)
  }
}

const cleanupJob = (job: TokenizerJob) => {
  job.signal.removeEventListener("abort", job.abort)
}

const accountPendingJob = (job: TokenizerJob) => {
  if (job.accounted) return
  job.accounted = true
  pendingJobs += 1
  pendingCodeUnits += job.codeUnits
}

const finishPendingJob = (job: TokenizerJob) => {
  cleanupJob(job)
  if (!job.accounted) return
  job.accounted = false
  pendingJobs -= 1
  pendingCodeUnits -= job.codeUnits
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
