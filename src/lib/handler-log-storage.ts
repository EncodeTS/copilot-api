import fs from "node:fs"
import path from "node:path"

export const HANDLER_LOG_DEFAULTS = Object.freeze({
  cleanupIntervalMs: 24 * 60 * 60 * 1000,
  flushIntervalMs: 1000,
  maxBufferSize: 100,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  retentionDays: 7,
})

const MANAGED_LOG_FILENAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-\d{4}-\d{2}-\d{2}\.part-\d+\.log$/u

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

export interface HandlerLogStorage {
  readonly logDirectory: string
  append(baseFilePath: string, line: string): void
  cleanup(): void
  close(): void
  flush(): void
}

export interface HandlerLogStorageOptions {
  cleanupIntervalMs?: number
  flushIntervalMs?: number
  logDirectory: string
  maxBufferSize?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  now?: () => number
  onError?: (message: string, error: unknown) => void
  registerCleanup?: (cleanup: () => void) => void
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
  const onError = options.onError ?? (() => {})
  const buffers = new Map<string, Array<string>>()
  const activeSegments = new Map<string, ActiveLogSegment>()

  let initialized = false
  let cleanupRegistered = false
  let flushInterval: ReturnType<typeof setInterval> | undefined
  let cleanupInterval: ReturnType<typeof setInterval> | undefined

  const ensureDirectory = () => {
    if (!fs.existsSync(options.logDirectory)) {
      fs.mkdirSync(options.logDirectory, { mode: 0o700, recursive: true })
    }
    fs.chmodSync(options.logDirectory, 0o700)
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

  const removeManagedFile = (filePath: string): boolean => {
    try {
      fs.rmSync(filePath)
      forgetSegment(filePath)
      return true
    } catch (error) {
      onError("Failed to remove handler log", error)
      return false
    }
  }

  const cleanupManagedLogs = () => {
    const files: Array<LogFileMetadata> = []

    for (const entry of fs.readdirSync(options.logDirectory)) {
      if (!isManagedHandlerLogFilename(entry)) continue

      const filePath = path.join(options.logDirectory, entry)
      let stats: fs.Stats
      try {
        stats = fs.statSync(filePath)
      } catch {
        continue
      }
      if (!stats.isFile()) continue

      if (now() - stats.mtimeMs > retentionMs) {
        removeManagedFile(filePath)
        continue
      }
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
      if (removeManagedFile(file.filePath)) totalBytes -= file.size
    }
  }

  const initialize = () => {
    if (initialized) return
    ensureDirectory()
    initialized = true
    cleanupManagedLogs()

    if (options.registerCleanup && !cleanupRegistered) {
      options.registerCleanup(close)
      cleanupRegistered = true
    }
    if (options.startTimers === false) return

    flushInterval = setInterval(
      flush,
      positiveInteger(
        options.flushIntervalMs,
        HANDLER_LOG_DEFAULTS.flushIntervalMs,
      ),
    )
    flushInterval.unref()
    cleanupInterval = setInterval(
      cleanup,
      positiveInteger(
        options.cleanupIntervalMs,
        HANDLER_LOG_DEFAULTS.cleanupIntervalMs,
      ),
    )
    cleanupInterval.unref()
  }

  const getLatestSegmentIndex = (baseFilePath: string): number => {
    const extension = path.extname(baseFilePath)
    const stem = path.basename(baseFilePath, extension)
    const prefix = `${stem}.part-`
    let latestIndex = -1

    for (const entry of fs.readdirSync(options.logDirectory)) {
      if (!entry.startsWith(prefix) || !entry.endsWith(extension)) continue
      const indexText = entry.slice(prefix.length, -extension.length)
      if (!/^\d+$/u.test(indexText)) continue
      latestIndex = Math.max(latestIndex, Number(indexText))
    }
    return Math.max(latestIndex, 0)
  }

  const getActiveSegment = (baseFilePath: string): ActiveLogSegment => {
    const cached = activeSegments.get(baseFilePath)
    if (cached) return cached

    let index = getLatestSegmentIndex(baseFilePath)
    let filePath = getSegmentPath(baseFilePath, index)
    let size = 0
    try {
      size = fs.statSync(filePath).size
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

  const rotateSegment = (baseFilePath: string): ActiveLogSegment => {
    const current = getActiveSegment(baseFilePath)
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

  const writeChunk = (filePath: string, chunk: Buffer) => {
    const descriptor = fs.openSync(filePath, "a", 0o600)
    try {
      fs.fchmodSync(descriptor, 0o600)
      let offset = 0
      while (offset < chunk.length) {
        offset += fs.writeSync(descriptor, chunk, offset)
      }
    } finally {
      fs.closeSync(descriptor)
    }
  }

  const writeWithRotation = (baseFilePath: string, content: Buffer) => {
    let offset = 0

    while (offset < content.length) {
      let segment = getActiveSegment(baseFilePath)
      if (segment.size >= maxFileBytes) segment = rotateSegment(baseFilePath)

      const chunkEnd = getUtf8SafeChunkEnd(
        content,
        offset,
        Math.min(offset + maxFileBytes - segment.size, content.length),
      )
      if (chunkEnd === offset) {
        rotateSegment(baseFilePath)
        continue
      }

      const chunk = content.subarray(offset, chunkEnd)
      writeChunk(segment.filePath, chunk)
      segment.size += chunk.length
      offset = chunkEnd
    }
  }

  const flushBaseFile = (baseFilePath: string) => {
    const buffer = buffers.get(baseFilePath)
    if (!buffer || buffer.length === 0) return

    buffers.set(baseFilePath, [])
    try {
      writeWithRotation(
        baseFilePath,
        Buffer.from(buffer.join("\n") + "\n", "utf8"),
      )
      cleanupManagedLogs()
    } catch (error) {
      onError("Failed to write handler log", error)
    }
  }

  function append(baseFilePath: string, line: string): void {
    initialize()
    const buffer = buffers.get(baseFilePath) ?? []
    buffer.push(line)
    buffers.set(baseFilePath, buffer)
    if (buffer.length >= maxBufferSize) flushBaseFile(baseFilePath)
  }

  function flush(): void {
    initialize()
    for (const baseFilePath of buffers.keys()) flushBaseFile(baseFilePath)
  }

  function cleanup(): void {
    initialize()
    cleanupManagedLogs()
  }

  function close(): void {
    if (!initialized) return
    if (flushInterval) clearInterval(flushInterval)
    if (cleanupInterval) clearInterval(cleanupInterval)
    flushInterval = undefined
    cleanupInterval = undefined
    for (const baseFilePath of buffers.keys()) flushBaseFile(baseFilePath)
    buffers.clear()
    activeSegments.clear()
  }

  return {
    append,
    cleanup,
    close,
    flush,
    logDirectory: options.logDirectory,
  }
}
