import * as fsPromises from "node:fs/promises"
import path from "node:path"

export const HANDLER_LOG_DEFAULTS = Object.freeze({
  cleanupIntervalMs: 24 * 60 * 60 * 1000,
  flushIntervalMs: 1000,
  maxBufferedBytes: 5 * 1024 * 1024,
  maxBufferSize: 100,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  retentionDays: 7,
})

const MANAGED_LOG_FILENAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-\d{4}-\d{2}-\d{2}\.part-\d+\.log$/u

const hasFileSystemErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const isMissingFileError = (error: unknown): boolean =>
  hasFileSystemErrorCode(error, "ENOENT")

interface ActiveLogSegment {
  filePath: string
  index: number
  size: number
}

interface LogFileMetadata {
  filePath: string
  mtimeMs: number
  size: number
}

export type HandlerLogFileSystem = Pick<
  typeof fsPromises,
  "chmod" | "mkdir" | "open" | "readdir" | "rm" | "stat"
>

export interface HandlerLogStorage {
  readonly logDirectory: string
  append(baseFilePath: string, line: string): void
  cleanup(): Promise<void>
  close(): Promise<void>
  flush(): Promise<void>
}

export interface HandlerLogStorageOptions {
  cleanupIntervalMs?: number
  fileSystem?: HandlerLogFileSystem
  flushIntervalMs?: number
  logDirectory: string
  maxBufferedBytes?: number
  maxBufferSize?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  now?: () => number
  onError?: (message: string, error: unknown) => void
  registerCleanup?: (cleanup: () => Promise<void>) => void
  retentionDays?: number
  startTimers?: boolean
}

const positiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback

export const isManagedHandlerLogFilename = (filename: string): boolean =>
  MANAGED_LOG_FILENAME_PATTERN.test(filename)

export const createHandlerLogStorage = (
  options: HandlerLogStorageOptions,
): HandlerLogStorage => {
  const fileSystem = options.fileSystem ?? fsPromises
  const maxBufferedBytes = positiveInteger(
    options.maxBufferedBytes,
    HANDLER_LOG_DEFAULTS.maxBufferedBytes,
  )
  const maxBufferSize = positiveInteger(
    options.maxBufferSize,
    HANDLER_LOG_DEFAULTS.maxBufferSize,
  )
  const maxFileBytes = Math.max(
    4,
    positiveInteger(options.maxFileBytes, HANDLER_LOG_DEFAULTS.maxFileBytes),
  )
  const maxTotalBytes = Math.max(
    maxFileBytes,
    positiveInteger(options.maxTotalBytes, HANDLER_LOG_DEFAULTS.maxTotalBytes),
  )
  const retentionMs =
    positiveInteger(options.retentionDays, HANDLER_LOG_DEFAULTS.retentionDays)
    * 24
    * 60
    * 60
    * 1000
  const now = options.now ?? Date.now
  const buffers = new Map<string, Array<string>>()
  const activeSegments = new Map<string, ActiveLogSegment>()

  let operationQueue = Promise.resolve()
  let totalBufferedBytes = 0
  let initialized = false
  let initializationScheduled = false
  let cleanupRegistered = false
  let timersStarted = false
  let closing = false
  let automaticFlush: Promise<void> | undefined
  let bufferLimitReported = false
  let closePromise: Promise<void> | undefined
  let flushInterval: ReturnType<typeof setInterval> | undefined
  let cleanupInterval: ReturnType<typeof setInterval> | undefined

  const reportError = (message: string, error: unknown) => {
    try {
      options.onError?.(message, error)
    } catch {
      // Logging must not fail because an error reporter failed.
    }
  }

  const enqueue = (
    failureMessage: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const result = operationQueue.then(async () => {
      try {
        await operation()
      } catch (error) {
        reportError(failureMessage, error)
      }
    })
    operationQueue = result
    return result
  }

  const ensureDirectory = async () => {
    const createdDirectory = await fileSystem.mkdir(options.logDirectory, {
      mode: 0o700,
      recursive: true,
    })
    if (createdDirectory !== undefined) activeSegments.clear()
    await fileSystem.chmod(options.logDirectory, 0o700)
  }

  const getSegmentPath = (baseFilePath: string, index: number): string => {
    const extension = path.extname(baseFilePath)
    return `${baseFilePath.slice(0, -extension.length)}.part-${index}${extension}`
  }

  const forgetSegment = (filePath: string) => {
    for (const [baseFilePath, segment] of activeSegments) {
      if (segment.filePath === filePath) activeSegments.delete(baseFilePath)
    }
  }

  const removeManagedFile = async (filePath: string): Promise<boolean> => {
    try {
      await fileSystem.rm(filePath)
      forgetSegment(filePath)
      return true
    } catch (error) {
      if (isMissingFileError(error)) {
        forgetSegment(filePath)
        return true
      }
      reportError("Failed to remove handler log", error)
      return false
    }
  }

  const cleanupManagedLogs = async () => {
    const files: Array<LogFileMetadata> = []

    for (const entry of await fileSystem.readdir(options.logDirectory)) {
      if (!isManagedHandlerLogFilename(entry)) continue

      const filePath = path.join(options.logDirectory, entry)
      let stats: Awaited<ReturnType<HandlerLogFileSystem["stat"]>>
      try {
        stats = await fileSystem.stat(filePath)
      } catch {
        continue
      }
      if (!stats.isFile()) continue

      if (
        now() - stats.mtimeMs > retentionMs
        && (await removeManagedFile(filePath))
      ) {
        continue
      }
      await fileSystem.chmod(filePath, 0o600)
      files.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size })
    }

    let totalBytes = files.reduce((total, file) => total + file.size, 0)
    if (totalBytes <= maxTotalBytes) return

    files.sort(
      (left, right) =>
        left.mtimeMs - right.mtimeMs
        || left.filePath.localeCompare(right.filePath),
    )
    for (const file of files) {
      if (totalBytes <= maxTotalBytes) break
      if (await removeManagedFile(file.filePath)) totalBytes -= file.size
    }
  }

  const startRuntime = async (): Promise<boolean> => {
    if (initialized) return true
    try {
      await ensureDirectory()
      await cleanupManagedLogs()
      initialized = true
      if (options.registerCleanup && !cleanupRegistered) {
        options.registerCleanup(close)
        cleanupRegistered = true
      }
      if (options.startTimers === false || timersStarted || closing) return true

      flushInterval = setInterval(
        () => {
          requestFlush()
        },
        positiveInteger(
          options.flushIntervalMs,
          HANDLER_LOG_DEFAULTS.flushIntervalMs,
        ),
      )
      flushInterval.unref()
      cleanupInterval = setInterval(
        () => {
          void cleanup().catch((error: unknown) => {
            reportError("Failed to clean handler logs", error)
          })
        },
        positiveInteger(
          options.cleanupIntervalMs,
          HANDLER_LOG_DEFAULTS.cleanupIntervalMs,
        ),
      )
      cleanupInterval.unref()
      timersStarted = true
      return true
    } catch (error) {
      reportError("Failed to initialize handler logs", error)
      return false
    }
  }

  const scheduleInitialization = () => {
    if (initialized || initializationScheduled || closing) return
    initializationScheduled = true
    void enqueue("Failed to initialize handler logs", async () => {
      try {
        await startRuntime()
      } finally {
        initializationScheduled = false
      }
    })
  }

  const getLatestSegmentIndex = async (
    baseFilePath: string,
  ): Promise<number> => {
    const extension = path.extname(baseFilePath)
    const stem = path.basename(baseFilePath, extension)
    const prefix = `${stem}.part-`
    let latestIndex = -1

    for (const entry of await fileSystem.readdir(options.logDirectory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(extension)) continue
      const indexText = entry.slice(prefix.length, -extension.length)
      if (!/^\d+$/u.test(indexText)) continue
      latestIndex = Math.max(latestIndex, Number(indexText))
    }
    return Math.max(latestIndex, 0)
  }

  const getActiveSegment = async (
    baseFilePath: string,
  ): Promise<ActiveLogSegment> => {
    const cached = activeSegments.get(baseFilePath)
    if (cached) return cached

    let index = await getLatestSegmentIndex(baseFilePath)
    let filePath = getSegmentPath(baseFilePath, index)
    let size = 0
    try {
      size = (await fileSystem.stat(filePath)).size
    } catch {
      // Created lazily on first flush.
    }

    if (size >= maxFileBytes) {
      index += 1
      filePath = getSegmentPath(baseFilePath, index)
      size = 0
    }

    const segment = { filePath, index, size }
    activeSegments.set(baseFilePath, segment)
    return segment
  }

  const rotateSegment = async (
    baseFilePath: string,
  ): Promise<ActiveLogSegment> => {
    const current = await getActiveSegment(baseFilePath)
    const next = {
      filePath: getSegmentPath(baseFilePath, current.index + 1),
      index: current.index + 1,
      size: 0,
    }
    activeSegments.set(baseFilePath, next)
    return next
  }

  const getUtf8SafeChunkEnd = (
    content: Buffer,
    offset: number,
    maximumEnd: number,
  ): number => {
    if (maximumEnd >= content.length) return content.length

    let end = maximumEnd
    while (end > offset && (content[end] & 0xc0) === 0x80) end -= 1
    return end
  }

  const writeChunk = async (filePath: string, chunk: Buffer) => {
    const handle = await fileSystem.open(filePath, "a", 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(chunk)
    } finally {
      await handle.close()
    }
  }

  const writeWithRotation = async (baseFilePath: string, content: Buffer) => {
    let offset = 0

    while (offset < content.length) {
      let segment = await getActiveSegment(baseFilePath)
      if (segment.size >= maxFileBytes) {
        segment = await rotateSegment(baseFilePath)
      }

      const chunkEnd = getUtf8SafeChunkEnd(
        content,
        offset,
        Math.min(offset + maxFileBytes - segment.size, content.length),
      )
      if (chunkEnd === offset) {
        await rotateSegment(baseFilePath)
        continue
      }

      const chunk = content.subarray(offset, chunkEnd)
      await writeChunk(segment.filePath, chunk)
      segment.size += chunk.length
      offset = chunkEnd
    }
  }

  const flushBaseFile = async (baseFilePath: string): Promise<boolean> => {
    const currentBuffer = buffers.get(baseFilePath)
    if (!currentBuffer || currentBuffer.length === 0) return false

    const snapshot = currentBuffer.slice()
    try {
      await writeWithRotation(
        baseFilePath,
        Buffer.from(snapshot.join("\n") + "\n", "utf8"),
      )
    } catch (error) {
      initialized = false
      activeSegments.delete(baseFilePath)
      reportError("Failed to write handler log", error)
      return false
    }

    const latestBuffer = buffers.get(baseFilePath)
    latestBuffer?.splice(0, snapshot.length)
    totalBufferedBytes = Math.max(
      0,
      totalBufferedBytes
        - Buffer.byteLength(snapshot.join("\n") + "\n", "utf8"),
    )
    if (totalBufferedBytes < maxBufferedBytes) bufferLimitReported = false
    if (!latestBuffer || latestBuffer.length === 0) buffers.delete(baseFilePath)
    return true
  }

  const flushBatch = async () => {
    let wrote = false
    for (const baseFilePath of Array.from(buffers.keys())) {
      if (await flushBaseFile(baseFilePath)) wrote = true
    }
    if (!wrote) return

    try {
      await cleanupManagedLogs()
    } catch (error) {
      initialized = false
      activeSegments.clear()
      reportError("Failed to clean handler logs", error)
    }
  }

  const requestFlush = (): void => {
    if (automaticFlush || closing) return
    automaticFlush = Promise.resolve()
      .then(flush)
      .catch((error: unknown) => {
        reportError("Failed to flush handler logs", error)
      })
      .finally(() => {
        automaticFlush = undefined
      })
  }

  function append(baseFilePath: string, line: string): void {
    if (closing) return
    const lineBytes = Buffer.byteLength(line, "utf8") + 1
    if (
      lineBytes > maxBufferedBytes
      || totalBufferedBytes + lineBytes > maxBufferedBytes
    ) {
      if (!bufferLimitReported) {
        bufferLimitReported = true
        reportError(
          "Handler log buffer limit reached; dropping new log entries",
          new Error(`Handler log buffer exceeds ${maxBufferedBytes} bytes`),
        )
      }
      return
    }
    const buffer = buffers.get(baseFilePath) ?? []
    buffer.push(line)
    buffers.set(baseFilePath, buffer)
    totalBufferedBytes += lineBytes
    scheduleInitialization()
    if (buffer.length >= maxBufferSize) requestFlush()
  }

  function flush(): Promise<void> {
    return enqueue("Failed to flush handler logs", async () => {
      if (!(await startRuntime())) return
      await flushBatch()
    })
  }

  function cleanup(): Promise<void> {
    return enqueue("Failed to clean handler logs", async () => {
      if (!(await startRuntime())) return
      try {
        await cleanupManagedLogs()
      } catch (error) {
        initialized = false
        activeSegments.clear()
        reportError("Failed to clean handler logs", error)
      }
    })
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise
    closing = true
    if (flushInterval) clearInterval(flushInterval)
    if (cleanupInterval) clearInterval(cleanupInterval)
    flushInterval = undefined
    cleanupInterval = undefined

    closePromise = enqueue("Failed to close handler logs", async () => {
      if (buffers.size > 0 && (await startRuntime())) await flushBatch()
      buffers.clear()
      totalBufferedBytes = 0
      activeSegments.clear()
    })
    return closePromise
  }

  return {
    append,
    cleanup,
    close,
    flush,
    logDirectory: options.logDirectory,
  }
}
