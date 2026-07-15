import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"
import { state } from "./state"
import { redactLogString, redactPayloadForDebug } from "./log-redaction"

export { redactLogString, redactPayloadForDebug } from "./log-redaction"

export const HANDLER_LOG_DEFAULTS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  retentionDays: 7,
})

const LOG_RETENTION_DAYS = HANDLER_LOG_DEFAULTS.retentionDays
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const LOG_DIR = process.env.COPILOT_API_LOG_DIR?.trim() || DEFAULT_LOG_DIR
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100

const readByteLimit = (name: string, fallback: number): number => {
  const value = Number(process.env[name]?.trim())
  return Number.isSafeInteger(value) && value >= 256 ? value : fallback
}

const MAX_LOG_FILE_BYTES = readByteLimit(
  "COPILOT_API_LOG_MAX_FILE_BYTES",
  HANDLER_LOG_DEFAULTS.maxFileBytes,
)
const MAX_LOG_TOTAL_BYTES = Math.max(
  MAX_LOG_FILE_BYTES,
  readByteLimit(
    "COPILOT_API_LOG_MAX_TOTAL_BYTES",
    HANDLER_LOG_DEFAULTS.maxTotalBytes,
  ),
)
const MANAGED_LOG_FILENAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-\d{4}-\d{2}-\d{2}\.part-\d+\.log$/u

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()

interface ActiveLogSegment {
  filePath: string
  index: number
  size: number
}

const activeLogSegments = new Map<string, ActiveLogSegment>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined

export const getHandlerLogDirectory = (): string => LOG_DIR

const ensureLogDirectory = () => {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { mode: 0o700, recursive: true })
  }

  fs.chmodSync(LOG_DIR, 0o700)
}

interface LogFileMetadata {
  filePath: string
  mtimeMs: number
  size: number
}

const closeLogFile = (filePath: string) => {
  const stream = logStreams.get(filePath)
  if (stream) {
    stream.end()
    logStreams.delete(filePath)
  }

  for (const [baseFilePath, segment] of activeLogSegments) {
    if (segment.filePath === filePath) {
      activeLogSegments.delete(baseFilePath)
    }
  }
}

const removeLogFile = (filePath: string): boolean => {
  closeLogFile(filePath)
  try {
    fs.rmSync(filePath)
    return true
  } catch {
    return false
  }
}

const cleanupOldLogs = () => {
  if (!fs.existsSync(LOG_DIR)) {
    return
  }

  const now = Date.now()
  const files: Array<LogFileMetadata> = []

  for (const entry of fs.readdirSync(LOG_DIR)) {
    if (!MANAGED_LOG_FILENAME_PATTERN.test(entry)) {
      continue
    }

    const filePath = path.join(LOG_DIR, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile()) {
      continue
    }

    if (now - stats.mtimeMs > LOG_RETENTION_MS) {
      removeLogFile(filePath)
      continue
    }

    files.push({ filePath, mtimeMs: stats.mtimeMs, size: stats.size })
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes <= MAX_LOG_TOTAL_BYTES) return

  files.sort(
    (left, right) =>
      left.mtimeMs - right.mtimeMs
      || left.filePath.localeCompare(right.filePath),
  )
  for (const file of files) {
    if (totalBytes <= MAX_LOG_TOTAL_BYTES) break
    if (removeLogFile(file.filePath)) totalBytes -= file.size
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const getSegmentPath = (baseFilePath: string, index: number): string => {
  const extension = path.extname(baseFilePath)
  return `${baseFilePath.slice(0, -extension.length)}.part-${index}${extension}`
}

const getLatestSegmentIndex = (baseFilePath: string): number => {
  const directory = path.dirname(baseFilePath)
  const extension = path.extname(baseFilePath)
  const stem = path.basename(baseFilePath, extension)
  const prefix = `${stem}.part-`

  let latestIndex = -1
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(extension)) continue

    const indexText = entry.slice(prefix.length, -extension.length)
    if (!/^\d+$/u.test(indexText)) continue
    latestIndex = Math.max(latestIndex, Number(indexText))
  }
  return Math.max(latestIndex, 0)
}

const getActiveLogSegment = (baseFilePath: string): ActiveLogSegment => {
  const cached = activeLogSegments.get(baseFilePath)
  if (cached) return cached

  let index = getLatestSegmentIndex(baseFilePath)
  let filePath = getSegmentPath(baseFilePath, index)
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    // The first segment is created lazily when the buffer is flushed.
  }

  if (size >= MAX_LOG_FILE_BYTES) {
    index += 1
    filePath = getSegmentPath(baseFilePath, index)
    size = 0
  }

  const segment = { filePath, index, size }
  activeLogSegments.set(baseFilePath, segment)
  return segment
}

const rotateLogSegment = (baseFilePath: string): ActiveLogSegment => {
  const current = getActiveLogSegment(baseFilePath)
  const stream = logStreams.get(current.filePath)
  if (stream) {
    stream.end()
    logStreams.delete(current.filePath)
  }

  const next = {
    filePath: getSegmentPath(baseFilePath, current.index + 1),
    index: current.index + 1,
    size: 0,
  }
  activeLogSegments.set(baseFilePath, next)
  return next
}

const getUtf8SafeChunkEnd = (
  content: Buffer,
  offset: number,
  maximumEnd: number,
): number => {
  if (maximumEnd >= content.length) return content.length

  let end = maximumEnd
  while (end > offset && (content[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return end
}

const writeWithRotation = (baseFilePath: string, content: Buffer): void => {
  let offset = 0

  while (offset < content.length) {
    let segment = getActiveLogSegment(baseFilePath)
    if (segment.size >= MAX_LOG_FILE_BYTES) {
      segment = rotateLogSegment(baseFilePath)
    }

    const remainingBytes = MAX_LOG_FILE_BYTES - segment.size
    const chunkEnd = getUtf8SafeChunkEnd(
      content,
      offset,
      Math.min(offset + remainingBytes, content.length),
    )
    if (chunkEnd === offset) {
      rotateLogSegment(baseFilePath)
      continue
    }

    const chunk = content.subarray(offset, chunkEnd)
    const stream = getLogStream(segment.filePath)
    stream.write(chunk, (error) => {
      if (error) {
        console.warn("Failed to write handler log", error)
        return
      }
      cleanupOldLogs()
    })
    segment.size += chunk.length
    offset += chunk.length
  }
}

const flushBuffer = (baseFilePath: string) => {
  const buffer = logBuffers.get(baseFilePath)
  if (!buffer || buffer.length === 0) {
    return
  }

  const content = Buffer.from(buffer.join("\n") + "\n", "utf8")
  writeWithRotation(baseFilePath, content)

  logBuffers.set(baseFilePath, [])
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const cleanup = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }
  logStreams.clear()
  logBuffers.clear()
  activeLogSegments.clear()
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  cleanupOldLogs()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(cleanupOldLogs, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(cleanup)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    const descriptor = fs.openSync(filePath, "a", 0o600)
    try {
      fs.fchmodSync(descriptor, 0o600)
    } catch (error) {
      fs.closeSync(descriptor)
      throw error
    }

    stream = fs.createWriteStream(filePath, {
      autoClose: true,
      fd: descriptor,
    })
    logStreams.set(filePath, stream)

    stream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      logStreams.delete(filePath)
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer(filePath)
  }
}

type DebugLogger = Pick<ConsolaInstance, "debug">

type AsyncDebugValueFactory = () => Promise<unknown>

interface PayloadSummary {
  byteCount: number
  counts?: Record<string, number>
  errorCode?: number | string
  eventType?: string
  kind: "payload_summary"
  model?: string
}

const SUMMARY_COUNT_KEYS = ["input", "messages", "output", "tools"] as const
const SAFE_METADATA_PATTERN = /^[a-zA-Z0-9._:/+-]+$/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toSafeMetadata = (value: unknown): string | undefined =>
  (
    typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && SAFE_METADATA_PATTERN.test(value)
  ) ?
    value
  : undefined

const serializeForByteCount = (value: unknown): string => {
  const seen = new WeakSet<object>()

  try {
    return JSON.stringify(value, (_key, childValue: unknown) => {
      if (typeof childValue === "bigint") {
        return childValue.toString()
      }
      if (typeof childValue !== "object" || childValue === null) {
        return childValue
      }
      if (seen.has(childValue)) {
        return "[circular]"
      }
      seen.add(childValue)
      return childValue
    })
  } catch {
    return util.inspect(value, { depth: null, colors: false })
  }
}

const summarizePayloadForDebug = (value: unknown): PayloadSummary => {
  const serialized = serializeForByteCount(value)
  const summary: PayloadSummary = {
    byteCount: Buffer.byteLength(serialized, "utf8"),
    kind: "payload_summary",
  }

  if (!isRecord(value)) {
    return summary
  }

  const eventType = toSafeMetadata(value.type)
  if (eventType) summary.eventType = eventType

  const model = toSafeMetadata(value.model)
  if (model) summary.model = model

  const counts = Object.fromEntries(
    SUMMARY_COUNT_KEYS.flatMap((key) =>
      Array.isArray(value[key]) ? [[key, value[key].length]] : [],
    ),
  )
  if (Object.keys(counts).length > 0) summary.counts = counts

  const error = isRecord(value.error) ? value.error : undefined
  const errorCode =
    toSafeMetadata(error?.code)
    ?? toSafeMetadata(value.code)
    ?? (typeof value.status === "number" ? value.status : undefined)
    ?? (typeof value.status_code === "number" ? value.status_code : undefined)
  if (errorCode !== undefined) summary.errorCode = errorCode

  return summary
}

const isFullPayloadLoggingEnabled = (): boolean =>
  state.verbose && process.env.COPILOT_API_LOG_FULL_PAYLOADS?.trim() === "1"

const parsePayloadSummary = (value: string): PayloadSummary | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }

  if (
    !isRecord(parsed)
    || parsed.kind !== "payload_summary"
    || typeof parsed.byteCount !== "number"
    || !Number.isFinite(parsed.byteCount)
    || parsed.byteCount < 0
  ) {
    return undefined
  }

  const summary: PayloadSummary = {
    byteCount: parsed.byteCount,
    kind: "payload_summary",
  }
  const eventType = toSafeMetadata(parsed.eventType)
  if (eventType) summary.eventType = eventType
  const model = toSafeMetadata(parsed.model)
  if (model) summary.model = model

  const parsedCounts = parsed.counts
  if (isRecord(parsedCounts)) {
    const counts = Object.fromEntries(
      SUMMARY_COUNT_KEYS.flatMap((key) => {
        const count = parsedCounts[key]
        return (
            typeof count === "number"
              && Number.isSafeInteger(count)
              && count >= 0
          ) ?
            [[key, count]]
          : []
      }),
    )
    if (Object.keys(counts).length > 0) summary.counts = counts
  }

  const errorCode =
    toSafeMetadata(parsed.errorCode)
    ?? (typeof parsed.errorCode === "number" ? parsed.errorCode : undefined)
  if (errorCode !== undefined) summary.errorCode = errorCode

  return summary
}

const summarizeLogArgument = (value: unknown): unknown => {
  if (typeof value === "string") {
    const payloadSummary = parsePayloadSummary(value)
    if (payloadSummary) return payloadSummary

    return {
      byteCount: Buffer.byteLength(value, "utf8"),
      kind: "string_summary",
    }
  }

  if (
    typeof value === "number"
    || typeof value === "boolean"
    || value == null
  ) {
    return value
  }

  return summarizePayloadForDebug(value)
}

const prepareFileLogArguments = (args: Array<unknown>): Array<unknown> =>
  args.map((arg, index) => {
    if (index === 0 && typeof arg === "string") {
      return redactLogString(arg.replaceAll(/[\r\n]+/gu, " ").slice(0, 200))
    }

    return isFullPayloadLoggingEnabled() ?
        redactDebugArg(arg)
      : summarizeLogArgument(arg)
  })

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!state.verbose) {
    return
  }

  logger.debug(
    ...(factory().map(redactDebugArg) as [unknown, ...Array<unknown>]),
  )
}

const redactDebugArg = (value: unknown): unknown =>
  typeof value === "string" ?
    redactLogString(value)
  : redactPayloadForDebug(value)

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
): void => {
  debugLazy(logger, () => [
    label,
    JSON.stringify(
      isFullPayloadLoggingEnabled() ?
        redactPayloadForDebug(value)
      : summarizePayloadForDebug(value),
    ),
  ])
}

export const debugJsonAsync = async (
  logger: DebugLogger,
  label: string,
  factory: AsyncDebugValueFactory,
): Promise<void> => {
  if (!state.verbose) {
    return
  }

  debugJson(logger, label, await factory())
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [
    label,
    redactLogString(JSON.stringify(redactPayloadForDebug(value))).slice(
      -tailLength,
    ),
  ])
}

export const createHandlerLogger = (
  name: string,
  options: { mirrorToConsole?: boolean } = {},
): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  if (!options.mirrorToConsole) {
    instance.setReporters([])
  }

  instance.addReporter({
    log(logObj) {
      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(LOG_DIR, `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(
        prepareFileLogArguments(logObj.args as Array<unknown>),
      )
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      appendLine(filePath, line)
    },
  })

  return instance
}
