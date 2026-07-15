import consola, { type ConsolaInstance } from "consola"
import path from "node:path"
import util from "node:util"

import {
  createHandlerLogStorage,
  HANDLER_LOG_DEFAULTS,
  type HandlerLogStorage,
} from "./handler-log-storage"
import { PATHS } from "./paths"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"
import { state } from "./state"
import { redactLogString, redactPayloadForDebug } from "./log-redaction"

export { redactLogString, redactPayloadForDebug } from "./log-redaction"
export { HANDLER_LOG_DEFAULTS } from "./handler-log-storage"

const DEFAULT_LOG_DIR = path.join(PATHS.APP_DIR, "logs")
const LOG_DIR = process.env.COPILOT_API_LOG_DIR?.trim() || DEFAULT_LOG_DIR

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

const defaultHandlerLogStorage = createHandlerLogStorage({
  logDirectory: LOG_DIR,
  maxFileBytes: MAX_LOG_FILE_BYTES,
  maxTotalBytes: MAX_LOG_TOTAL_BYTES,
  onError: (message, error) => console.warn(message, error),
  registerCleanup: registerProcessCleanup,
})

export const getHandlerLogDirectory = (): string => LOG_DIR

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
  options: {
    mirrorToConsole?: boolean
    storage?: HandlerLogStorage
  } = {},
): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)
  const storage = options.storage ?? defaultHandlerLogStorage

  if (state.verbose) {
    instance.level = 5
  }
  if (!options.mirrorToConsole) {
    instance.setReporters([])
  }

  instance.addReporter({
    log(logObj) {
      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(
        storage.logDirectory,
        `${sanitizedName}-${dateKey}.log`,
      )
      const message = formatArgs(
        prepareFileLogArguments(logObj.args as Array<unknown>),
      )
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      storage.append(filePath, line)
    },
  })

  return instance
}
