import { createHmac, randomBytes } from "node:crypto"

import type {
  ImageCompressionDiagnosticDetail,
  ImageCompressionProfile,
  ImageCompressionStatus,
} from "./utils"

export interface ImageCompressionNamespace {
  account: string
  model: string
  origin: string
  tenant: string
}

export interface BinaryImageCompressionOutput {
  buffer: Buffer
  mimeType: "image/jpeg" | "image/webp"
}

export interface BinaryImageCompressionFailure {
  diagnostic?: string
  diagnosticDetail?: ImageCompressionDiagnosticDetail
  status: Exclude<ImageCompressionStatus, "compressed">
}

export type BinaryImageCompressionResult =
  | BinaryImageCompressionFailure
  | BinaryImageCompressionOutput

export interface ImageCompressionRuntimeLimits {
  cacheBytes: number
  cacheEntries: number
  concurrency: number
  maxPendingBytes: number
  maxPendingEntries: number
  negativeCacheTtlMs: number
  positiveCacheTtlMs: number
}

export interface ImageCompressionRuntimeSnapshot {
  activeWork: number
  cacheEntries: number
  cacheWeightBytes: number
  inFlightBytes: number
  inFlightEntries: number
  negativeCacheEntries: number
  optimizedOutputEntries: number
  positiveCacheEntries: number
  queuedBytes: number
  queuedWork: number
}

export interface ImageCompressionRuntimeRequest {
  contentBytes: number
  contentIdentity: string
  format: "jpeg" | "webp" | "auto"
  inputBytes: number
  mimeType: string
  namespace: ImageCompressionNamespace
  optimizerVersion: string
  policyKey: string
  profile: ImageCompressionProfile
  signal?: AbortSignal
  sourceDetail?: "low" | "high" | "auto" | "original"
  timeoutMs: number
  work(signal: AbortSignal): Promise<BinaryImageCompressionResult>
}

export interface ImageCompressionRuntimeResult {
  binaryOutput?: BinaryImageCompressionOutput
  cacheHit?: "negative" | "positive"
  diagnostic?: string
  diagnosticDetail?: ImageCompressionDiagnosticDetail
  elapsedMs?: number
  inputBytes?: number
  outputBytes?: number
  status: ImageCompressionStatus
}

interface ImageCompressionRuntimeConstructorOptions {
  derivePrimaryKey?: (parts: ReadonlyArray<PrivateKeyPart>) => string
  now?: () => number
}

interface PositiveCacheValue {
  kind: "positive"
  output: BinaryImageCompressionOutput
  outputBytes: number
}

interface NegativeCacheValue {
  kind: "negative"
  result: Omit<ImageCompressionRuntimeResult, "cacheHit" | "elapsedMs">
}

interface OptimizedOutputCacheValue {
  detail?: "low" | "high" | "auto" | "original"
  format: BinaryImageCompressionOutput["mimeType"]
  kind: "optimized-output"
  maxLongEdge: number
  policyKey: string
  quality: number
}

type RuntimeCacheValue =
  | NegativeCacheValue
  | OptimizedOutputCacheValue
  | PositiveCacheValue

interface RuntimeJob {
  controller: AbortController
  operation: Promise<ImageCompressionRuntimeResult>
  started: boolean
  subscribers: number
}

interface WeightedCacheEntry {
  createdAt: number
  expiresAt: number
  value: RuntimeCacheValue
  weight: number
}

interface SchedulerWaiter<T> {
  abort?: () => void
  bytes: number
  onStarted: () => void
  reject: (error: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
  signal: AbortSignal
  task: () => Promise<T>
}

interface Base64PrivateKeyPart {
  base64: string
  decodedBytes: number
}

type PrivateKeyPart = Base64PrivateKeyPart | Buffer | string

const DEFAULT_LIMITS: ImageCompressionRuntimeLimits = {
  cacheBytes: 0,
  cacheEntries: 0,
  concurrency: 1,
  maxPendingBytes: 256 * 1024 * 1024,
  maxPendingEntries: 64,
  negativeCacheTtlMs: 30_000,
  positiveCacheTtlMs: 10 * 60_000,
}

export const createImageCompressionRuntime = (
  options: ImageCompressionRuntimeConstructorOptions = {},
): ImageCompressionRuntime => new ImageCompressionRuntime(options)

export class ImageCompressionRuntime {
  readonly #cache: WeightedTtlLru
  readonly #derivePrimaryKey: (parts: ReadonlyArray<PrivateKeyPart>) => string
  readonly #inFlight = new Map<string, RuntimeJob>()
  readonly #now: () => number
  readonly #scheduler = new BoundedWorkScheduler()
  readonly #verificationSecret = randomBytes(32)
  #limits = DEFAULT_LIMITS

  constructor(options: ImageCompressionRuntimeConstructorOptions = {}) {
    const primarySecret = randomBytes(32)
    this.#derivePrimaryKey =
      options.derivePrimaryKey
      ?? ((parts) => derivePrivateKey(primarySecret, parts))
    this.#now = options.now ?? Date.now
    this.#cache = new WeightedTtlLru(this.#now)
    this.configure(DEFAULT_LIMITS)
  }

  configure(limits: ImageCompressionRuntimeLimits): void {
    this.#limits = normalizeLimits(limits)
    this.#cache.configure({
      maxBytes: this.#limits.cacheBytes,
      maxEntries: this.#limits.cacheEntries,
      negativeTtlMs: this.#limits.negativeCacheTtlMs,
      positiveTtlMs: this.#limits.positiveCacheTtlMs,
    })
    this.#scheduler.configure({
      concurrency: this.#limits.concurrency,
      maxBytes: this.#limits.maxPendingBytes,
      maxEntries: this.#limits.maxPendingEntries,
    })
  }

  async run(
    request: ImageCompressionRuntimeRequest,
  ): Promise<ImageCompressionRuntimeResult> {
    const startedAt = this.#now()
    if (request.signal?.aborted) {
      return createRuntimeResult("aborted", startedAt, this.#now, {
        diagnostic: "compression_aborted",
        inputBytes: request.inputBytes,
      })
    }

    const keyParts = createCompressionKeyParts(request)
    const cacheKey = this.#createPrivateKey(keyParts)
    const optimizedOutputKey = this.#createPrivateKey(
      createOptimizedOutputKeyParts(request),
    )
    const optimizedOutput = this.#cache.get(optimizedOutputKey)
    if (
      optimizedOutput?.kind === "optimized-output"
      && isOptimizedOutputCompatible(optimizedOutput, request)
    ) {
      return createRuntimeResult("already_optimized", startedAt, this.#now, {
        inputBytes: request.inputBytes,
      })
    }

    const cached = this.#cache.get(cacheKey)
    if (cached?.kind === "positive") {
      return createRuntimeResult("compressed", startedAt, this.#now, {
        binaryOutput: cached.output,
        cacheHit: "positive",
        inputBytes: request.inputBytes,
        outputBytes: cached.outputBytes,
      })
    }
    if (cached?.kind === "negative") {
      return createRuntimeResult(cached.result.status, startedAt, this.#now, {
        ...cached.result,
        cacheHit: "negative",
      })
    }

    const running = this.#inFlight.get(cacheKey)
    if (running) {
      return await this.#subscribe(running, request)
    }

    const controller = new AbortController()
    const job: RuntimeJob = {
      controller,
      operation: Promise.resolve({ status: "adapter_error" }),
      started: false,
      subscribers: 0,
    }
    const scheduled = this.#scheduler.schedule(
      async () => {
        const rawResult = await request.work(controller.signal)
        const result = normalizeWorkResult(
          rawResult,
          request,
          startedAt,
          this.#now,
        )
        this.#storeResult(cacheKey, request, result)
        return result
      },
      request.contentBytes,
      controller.signal,
      () => {
        job.started = true
      },
    )
    if (!scheduled) {
      return createRuntimeResult("capacity_limit", startedAt, this.#now, {
        diagnostic: "compression_capacity_limit",
        inputBytes: request.inputBytes,
      })
    }

    job.operation = scheduled.catch((error: unknown) => {
      if (isAbortError(error)) {
        return createRuntimeResult("aborted", startedAt, this.#now, {
          diagnostic: "compression_aborted",
          inputBytes: request.inputBytes,
        })
      }
      return createRuntimeResult("adapter_error", startedAt, this.#now, {
        diagnostic: "compression_work_failed",
        diagnosticDetail: {
          name: error instanceof Error ? error.name : "UnknownError",
          stage: "runtime",
        },
        inputBytes: request.inputBytes,
      })
    })
    this.#inFlight.set(cacheKey, job)
    const clear = () => {
      if (this.#inFlight.get(cacheKey) === job) {
        this.#inFlight.delete(cacheKey)
      }
    }
    void job.operation.then(clear, clear)

    return await this.#subscribe(job, request)
  }

  snapshot(): ImageCompressionRuntimeSnapshot {
    const cache = this.#cache.snapshot()
    const scheduler = this.#scheduler.snapshot()
    return {
      activeWork: scheduler.active,
      cacheEntries: cache.entries,
      cacheWeightBytes: cache.weightBytes,
      inFlightBytes: scheduler.reservedBytes,
      inFlightEntries: this.#inFlight.size,
      negativeCacheEntries: cache.negativeEntries,
      optimizedOutputEntries: cache.optimizedOutputEntries,
      positiveCacheEntries: cache.positiveEntries,
      queuedBytes: scheduler.queuedBytes,
      queuedWork: scheduler.queued,
    }
  }

  #createPrivateKey(parts: ReadonlyArray<PrivateKeyPart>): string {
    const primary = this.#derivePrimaryKey(parts)
    const verification = derivePrivateKey(this.#verificationSecret, parts)
    return `${primary}:${verification}`
  }

  #storeResult(
    cacheKey: string,
    request: ImageCompressionRuntimeRequest,
    result: ImageCompressionRuntimeResult,
  ): void {
    if (result.binaryOutput && result.outputBytes !== undefined) {
      this.#cache.set(
        cacheKey,
        {
          kind: "positive",
          output: result.binaryOutput,
          outputBytes: result.outputBytes,
        },
        this.#limits.positiveCacheTtlMs,
      )
      const outputIdentity = this.#createPrivateKey(
        createOptimizedOutputKeyParts(request, result.binaryOutput.buffer),
      )
      this.#cache.set(
        outputIdentity,
        {
          detail: resolveAppliedDetail(request),
          format: result.binaryOutput.mimeType,
          kind: "optimized-output",
          maxLongEdge: request.profile.maxLongEdge,
          policyKey: request.policyKey,
          quality: request.profile.jpegQuality,
        },
        this.#limits.positiveCacheTtlMs,
      )
      return
    }

    if (isNegativeCacheableStatus(result.status)) {
      const cachedResult = {
        diagnostic: result.diagnostic,
        diagnosticDetail: result.diagnosticDetail,
        inputBytes: result.inputBytes,
        outputBytes: result.outputBytes,
        status: result.status,
      }
      this.#cache.set(
        cacheKey,
        { kind: "negative", result: cachedResult },
        this.#limits.negativeCacheTtlMs,
      )
    }
  }

  async #subscribe(
    job: RuntimeJob,
    request: ImageCompressionRuntimeRequest,
  ): Promise<ImageCompressionRuntimeResult> {
    const subscriberStartedAt = this.#now()
    job.subscribers += 1
    try {
      return await waitForSubscriber({
        createAbortResult: () =>
          createRuntimeResult("aborted", subscriberStartedAt, this.#now, {
            diagnostic: "compression_aborted",
            inputBytes: request.inputBytes,
          }),
        createTimeoutResult: () =>
          createRuntimeResult("timeout", subscriberStartedAt, this.#now, {
            diagnostic: "compression_timeout",
            diagnosticDetail: {
              message: `Compression exceeded ${request.timeoutMs}ms timeout.`,
              stage: "timeout",
            },
            inputBytes: request.inputBytes,
          }),
        operation: job.operation,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
      })
    } finally {
      job.subscribers -= 1
      if (
        job.subscribers === 0
        && !job.controller.signal.aborted
        && !job.started
      ) {
        job.controller.abort()
      }
    }
  }
}

class WeightedTtlLru {
  readonly #entries = new Map<string, WeightedCacheEntry>()
  readonly #now: () => number
  #maxBytes = 0
  #maxEntries = 0
  #weightBytes = 0

  constructor(now: () => number) {
    this.#now = now
  }

  configure(options: {
    maxBytes: number
    maxEntries: number
    negativeTtlMs: number
    positiveTtlMs: number
  }): void {
    this.#maxEntries = normalizeNonNegativeInteger(options.maxEntries)
    this.#maxBytes = normalizeNonNegativeInteger(options.maxBytes)
    for (const entry of this.#entries.values()) {
      const ttlMs =
        entry.value.kind === "negative" ?
          options.negativeTtlMs
        : options.positiveTtlMs
      entry.expiresAt = Math.min(
        entry.expiresAt,
        entry.createdAt + normalizeNonNegativeInteger(ttlMs),
      )
    }
    this.#pruneExpired()
    this.#evict()
  }

  get(key: string): RuntimeCacheValue | null {
    const entry = this.#entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.#now()) {
      this.#delete(key, entry)
      return null
    }
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: RuntimeCacheValue, ttlMs: number): void {
    const normalizedWeight = calculateCacheEntryWeight(key, value)
    if (
      this.#maxEntries <= 0
      || this.#maxBytes <= 0
      || normalizedWeight > this.#maxBytes
      || ttlMs <= 0
    ) {
      return
    }
    const existing = this.#entries.get(key)
    if (existing) this.#delete(key, existing)
    const createdAt = this.#now()
    this.#entries.set(key, {
      createdAt,
      expiresAt: createdAt + ttlMs,
      value,
      weight: normalizedWeight,
    })
    this.#weightBytes += normalizedWeight
    this.#evict()
  }

  snapshot(): {
    entries: number
    negativeEntries: number
    optimizedOutputEntries: number
    positiveEntries: number
    weightBytes: number
  } {
    this.#pruneExpired()
    let negativeEntries = 0
    let optimizedOutputEntries = 0
    let positiveEntries = 0
    for (const entry of this.#entries.values()) {
      if (entry.value.kind === "negative") negativeEntries += 1
      else if (entry.value.kind === "optimized-output") {
        optimizedOutputEntries += 1
      } else positiveEntries += 1
    }
    return {
      entries: this.#entries.size,
      negativeEntries,
      optimizedOutputEntries,
      positiveEntries,
      weightBytes: this.#weightBytes,
    }
  }

  #delete(key: string, entry: WeightedCacheEntry): void {
    if (!this.#entries.delete(key)) return
    this.#weightBytes = Math.max(0, this.#weightBytes - entry.weight)
  }

  #evict(): void {
    while (
      this.#entries.size > this.#maxEntries
      || this.#weightBytes > this.#maxBytes
    ) {
      const oldestKey = this.#entries.keys().next().value
      if (typeof oldestKey !== "string") return
      const oldest = this.#entries.get(oldestKey)
      if (!oldest) return
      this.#delete(oldestKey, oldest)
    }
  }

  #pruneExpired(): void {
    const now = this.#now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#delete(key, entry)
    }
  }
}

class BoundedWorkScheduler {
  readonly #queue: Array<SchedulerWaiter<unknown>> = []
  #active = 0
  #concurrency = 1
  #maxBytes = 0
  #maxEntries = 0
  #reservedBytes = 0
  #reservedEntries = 0

  configure(options: {
    concurrency: number
    maxBytes: number
    maxEntries: number
  }): void {
    this.#concurrency = Math.max(1, Math.floor(options.concurrency))
    this.#maxBytes = normalizeNonNegativeInteger(options.maxBytes)
    this.#maxEntries = normalizeNonNegativeInteger(options.maxEntries)
    this.#drain()
  }

  schedule<T>(
    task: () => Promise<T>,
    bytes: number,
    signal: AbortSignal,
    onStarted: () => void,
  ): Promise<T> | null {
    const normalizedBytes = normalizeNonNegativeInteger(bytes)
    if (
      signal.aborted
      || this.#reservedEntries + 1 > this.#maxEntries
      || this.#reservedBytes + normalizedBytes > this.#maxBytes
    ) {
      return null
    }
    this.#reservedEntries += 1
    this.#reservedBytes += normalizedBytes
    const promise = new Promise<T>((resolve, reject) => {
      const waiter: SchedulerWaiter<T> = {
        bytes: normalizedBytes,
        onStarted,
        reject,
        resolve,
        signal,
        task,
      }
      waiter.abort = () => {
        const index = this.#queue.indexOf(waiter as SchedulerWaiter<unknown>)
        if (index < 0) return
        this.#queue.splice(index, 1)
        this.#releaseReservation(waiter.bytes)
        reject(createAbortError())
      }
      signal.addEventListener("abort", waiter.abort, { once: true })
      this.#queue.push(waiter as SchedulerWaiter<unknown>)
      this.#drain()
    })
    return promise
  }

  snapshot(): {
    active: number
    queued: number
    queuedBytes: number
    reservedBytes: number
  } {
    return {
      active: this.#active,
      queued: this.#queue.length,
      queuedBytes: this.#queue.reduce(
        (total, waiter) => total + waiter.bytes,
        0,
      ),
      reservedBytes: this.#reservedBytes,
    }
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const waiter = this.#queue.shift()
      if (!waiter) return
      if (waiter.abort) {
        waiter.signal.removeEventListener("abort", waiter.abort)
      }
      if (waiter.signal.aborted) {
        this.#releaseReservation(waiter.bytes)
        waiter.reject(createAbortError())
        continue
      }
      this.#active += 1
      waiter.onStarted()
      void Promise.resolve()
        .then(waiter.task)
        .then(waiter.resolve, waiter.reject)
        .finally(() => {
          this.#active = Math.max(0, this.#active - 1)
          this.#releaseReservation(waiter.bytes)
          this.#drain()
        })
    }
  }

  #releaseReservation(bytes: number): void {
    this.#reservedEntries = Math.max(0, this.#reservedEntries - 1)
    this.#reservedBytes = Math.max(0, this.#reservedBytes - bytes)
  }
}

const createCompressionKeyParts = (
  request: ImageCompressionRuntimeRequest,
): Array<PrivateKeyPart> => [
  "compression",
  ...createNamespaceKeyParts(request.namespace),
  request.mimeType,
  String(request.inputBytes),
  {
    base64: request.contentIdentity,
    decodedBytes: request.contentBytes,
  },
  JSON.stringify(request.profile),
  request.format,
  request.policyKey,
  request.optimizerVersion,
]

const createOptimizedOutputKeyParts = (
  request: ImageCompressionRuntimeRequest,
  contentIdentity: Base64PrivateKeyPart | Buffer = {
    base64: request.contentIdentity,
    decodedBytes: request.contentBytes,
  },
): Array<PrivateKeyPart> => [
  "optimized-output",
  ...createNamespaceKeyParts(request.namespace),
  contentIdentity,
  request.optimizerVersion,
]

const createNamespaceKeyParts = (
  namespace: ImageCompressionNamespace,
): Array<PrivateKeyPart> => [
  namespace.tenant,
  namespace.origin,
  namespace.account,
  namespace.model,
]

const derivePrivateKey = (
  secret: Buffer,
  parts: ReadonlyArray<PrivateKeyPart>,
): string => {
  const hmac = createHmac("sha256", secret)
  for (const part of parts) {
    const size = Buffer.allocUnsafe(4)
    size.writeUInt32BE(
      typeof part === "string" ? Buffer.byteLength(part, "utf8")
      : "base64" in part ? part.decodedBytes
      : part.byteLength,
    )
    hmac.update(size)
    if (typeof part === "string" || Buffer.isBuffer(part)) {
      hmac.update(part)
    } else {
      hmac.update(part.base64, "base64")
    }
  }
  return hmac.digest("hex")
}

const normalizeWorkResult = (
  rawResult: BinaryImageCompressionResult,
  request: ImageCompressionRuntimeRequest,
  startedAt: number,
  now: () => number,
): ImageCompressionRuntimeResult => {
  if ("buffer" in rawResult) {
    const outputBytes = calculateDataUrlBytes(
      rawResult.mimeType,
      rawResult.buffer.byteLength,
    )
    if (outputBytes >= request.inputBytes) {
      return createRuntimeResult("no_smaller", startedAt, now, {
        diagnostic: "no_smaller_output",
        inputBytes: request.inputBytes,
        outputBytes,
      })
    }
    return createRuntimeResult("compressed", startedAt, now, {
      binaryOutput: {
        buffer: rawResult.buffer,
        mimeType: rawResult.mimeType,
      },
      inputBytes: request.inputBytes,
      outputBytes,
    })
  }

  const diagnostic = sanitizeDiagnosticCode(rawResult.diagnostic)
  return createRuntimeResult(rawResult.status, startedAt, now, {
    diagnostic,
    diagnosticDetail: sanitizeDiagnosticDetail(
      rawResult.diagnosticDetail,
      diagnostic,
    ),
    inputBytes: request.inputBytes,
  })
}

const isOptimizedOutputCompatible = (
  marker: OptimizedOutputCacheValue,
  request: ImageCompressionRuntimeRequest,
): boolean =>
  marker.format === resolveRequestedOutputFormat(request)
  && marker.policyKey === request.policyKey
  && marker.quality <= request.profile.jpegQuality
  && marker.maxLongEdge <= request.profile.maxLongEdge
  && marker.detail === resolveAppliedDetail(request)

const resolveRequestedOutputFormat = (
  request: ImageCompressionRuntimeRequest,
): BinaryImageCompressionOutput["mimeType"] | null => {
  if (request.format === "jpeg") return "image/jpeg"
  if (request.format === "webp") return "image/webp"
  if (request.mimeType === "image/jpeg" || request.mimeType === "image/webp") {
    return request.mimeType
  }
  return null
}

const resolveAppliedDetail = (
  request: ImageCompressionRuntimeRequest,
): OptimizedOutputCacheValue["detail"] =>
  request.profile.detail && request.profile.detail !== "keep-original" ?
    request.profile.detail
  : request.sourceDetail

const calculateCacheEntryWeight = (
  key: string,
  value: RuntimeCacheValue,
): number => {
  const keyBytes = Buffer.byteLength(key, "utf8")
  if (value.kind === "positive") {
    return (
      keyBytes
      + value.output.buffer.byteLength
      + Buffer.byteLength(
        JSON.stringify({
          kind: value.kind,
          mimeType: value.output.mimeType,
          outputBytes: value.outputBytes,
        }),
        "utf8",
      )
    )
  }
  return keyBytes + Buffer.byteLength(JSON.stringify(value), "utf8")
}

const createRuntimeResult = (
  status: ImageCompressionStatus,
  startedAt: number,
  now: () => number,
  options: Omit<ImageCompressionRuntimeResult, "elapsedMs" | "status"> = {},
): ImageCompressionRuntimeResult => ({
  ...options,
  elapsedMs: Math.max(0, now() - startedAt),
  status,
})

const sanitizeDiagnosticCode = (
  value: string | undefined,
): string | undefined =>
  value && /^[a-z0-9_.-]{1,80}$/u.test(value) ? value : "compression_failed"

const sanitizeDiagnosticDetail = (
  detail: ImageCompressionDiagnosticDetail | undefined,
  diagnostic: string | undefined,
): ImageCompressionDiagnosticDetail | undefined => {
  if (!detail) return undefined
  const stage = sanitizeDiagnosticField(detail.stage, 80)
  const canPreserveGeneratedMessage =
    diagnostic === "decode_safety_limit"
    || diagnostic === "missing_image_dimensions"
  return {
    code: sanitizeDiagnosticField(detail.code, 80),
    message:
      canPreserveGeneratedMessage ? sanitizeDiagnosticField(detail.message, 600)
      : stage ? `Image compression failed during ${stage}.`
      : undefined,
    name: sanitizeDiagnosticField(detail.name, 80),
    stage,
  }
}

const sanitizeDiagnosticField = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  if (!value) return undefined
  const safe = value
    .replaceAll(
      /data:[^,\s]+;base64,[A-Za-z0-9+/=_-]+/giu,
      "[redacted-data-url]",
    )
    .replaceAll(/[A-Za-z0-9+/=_-]{256,}/gu, "[redacted-long-token]")
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength)}`
}

const calculateDataUrlBytes = (
  mimeType: string,
  decodedBytes: number,
): number =>
  Buffer.byteLength(`data:${mimeType};base64,`, "utf8")
  + Math.ceil(decodedBytes / 3) * 4

const normalizeLimits = (
  limits: ImageCompressionRuntimeLimits,
): ImageCompressionRuntimeLimits => ({
  cacheBytes: normalizeNonNegativeInteger(limits.cacheBytes),
  cacheEntries: normalizeNonNegativeInteger(limits.cacheEntries),
  concurrency: Math.max(1, Math.floor(limits.concurrency)),
  maxPendingBytes: normalizeNonNegativeInteger(limits.maxPendingBytes),
  maxPendingEntries: normalizeNonNegativeInteger(limits.maxPendingEntries),
  negativeCacheTtlMs: normalizeNonNegativeInteger(limits.negativeCacheTtlMs),
  positiveCacheTtlMs: normalizeNonNegativeInteger(limits.positiveCacheTtlMs),
})

const normalizeNonNegativeInteger = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const isNegativeCacheableStatus = (status: ImageCompressionStatus): boolean =>
  status === "already_optimized"
  || status === "decode_limit"
  || status === "no_smaller"

const createAbortError = (): Error => {
  const error = new Error("Image compression work aborted")
  error.name = "AbortError"
  return error
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

const waitForSubscriber = async <T>(options: {
  createAbortResult: () => T
  createTimeoutResult: () => T
  operation: Promise<T>
  signal?: AbortSignal
  timeoutMs: number
}): Promise<T> => {
  if (options.signal?.aborted) return options.createAbortResult()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  try {
    return await Promise.race([
      options.operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(
          () => resolve(options.createTimeoutResult()),
          Math.max(1, options.timeoutMs),
        )
        timer.unref()
      }),
      ...(options.signal ?
        [
          new Promise<T>((resolve) => {
            abortHandler = () => resolve(options.createAbortResult())
            options.signal?.addEventListener("abort", abortHandler, {
              once: true,
            })
          }),
        ]
      : []),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortHandler) {
      options.signal?.removeEventListener("abort", abortHandler)
    }
  }
}

export const processImageCompressionRuntime = createImageCompressionRuntime()
