import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import {
  PRIVATE_FILE_MODE,
  supportsPosixPermissionModes,
} from "./file-protection"

export const LEGACY_LOG_CLEANUP_CONFIRMATION = "CONFIRM_LEGACY_LOG_CLEANUP"

const LEGACY_LOG_FILENAME_PATTERN =
  /^(?<logger>[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-\d{4}-\d{2}-\d{2}\.log$/u
const KNOWN_LEGACY_LOGGERS = new Set([
  "alpha-search-handler",
  "chat-completions-handler",
  "images-handler",
  "messages-handler",
  "models-handler",
  "prepared-messages-generation",
  "provider-chat-completions-handler",
  "provider-count-tokens-handler",
  "provider-messages-handler",
  "provider-models-handler",
  "provider-responses-handler",
  "responses-diagnostics",
  "responses-handler",
  "stream-lifecycle",
])
const DEFAULT_RETENTION_DAYS = 7

export interface LegacyLogCleanupCandidate {
  action: "delete" | "repair_permissions"
  currentMode: number
  filename: string
  mtimeMs: number
  size: number
}

export interface LegacyLogCleanupPreview {
  candidates: Array<LegacyLogCleanupCandidate>
  previewId: string
  retentionDays: number
}

export interface LegacyLogCleanupOptions {
  logDirectory: string
  now?: () => number
  retentionDays?: number
}

const normalizeRetentionDays = (value: number | undefined): number =>
  Number.isSafeInteger(value) && (value ?? 0) > 0 ?
    (value as number)
  : DEFAULT_RETENTION_DAYS

const createPreviewId = (
  logDirectory: string,
  retentionDays: number,
  candidates: Array<LegacyLogCleanupCandidate>,
): string =>
  createHash("sha256")
    .update(JSON.stringify({ candidates, logDirectory, retentionDays }))
    .digest("hex")

export const previewLegacyLogCleanup = async (
  options: LegacyLogCleanupOptions,
): Promise<LegacyLogCleanupPreview> => {
  const retentionDays = normalizeRetentionDays(options.retentionDays)
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const now = options.now ?? Date.now
  const candidates: Array<LegacyLogCleanupCandidate> = []
  let entries: Array<string>
  try {
    entries = await fs.readdir(options.logDirectory)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        candidates,
        previewId: createPreviewId(
          options.logDirectory,
          retentionDays,
          candidates,
        ),
        retentionDays,
      }
    }
    throw error
  }

  for (const filename of entries.sort()) {
    const match = LEGACY_LOG_FILENAME_PATTERN.exec(filename)
    if (
      !match?.groups?.logger
      || !KNOWN_LEGACY_LOGGERS.has(match.groups.logger)
    ) {
      continue
    }
    const filePath = path.join(options.logDirectory, filename)
    let stats: Awaited<ReturnType<typeof fs.lstat>> | null
    try {
      stats = await fs.lstat(filePath)
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) {
        stats = null
      } else {
        throw error
      }
    }
    if (!stats?.isFile()) continue

    const currentMode = stats.mode & 0o777
    const action =
      now() - stats.mtimeMs > retentionMs ? "delete"
      : supportsPosixPermissionModes() && currentMode !== PRIVATE_FILE_MODE ?
        "repair_permissions"
      : null
    if (!action) continue
    candidates.push({
      action,
      currentMode,
      filename,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    })
  }

  return {
    candidates,
    previewId: createPreviewId(options.logDirectory, retentionDays, candidates),
    retentionDays,
  }
}

export const applyLegacyLogCleanup = async (
  options: LegacyLogCleanupOptions & {
    confirmation: string
    previewId: string
  },
): Promise<{ deleted: number; permissionsRepaired: number }> => {
  if (options.confirmation !== LEGACY_LOG_CLEANUP_CONFIRMATION) {
    throw new Error(
      `Legacy log cleanup requires confirmation '${LEGACY_LOG_CLEANUP_CONFIRMATION}'`,
    )
  }

  const preview = await previewLegacyLogCleanup(options)
  if (preview.previewId !== options.previewId) {
    throw new Error("Legacy log cleanup preview is stale; preview again")
  }

  const verified = await Promise.all(
    preview.candidates.map(async (candidate) => {
      const filePath = path.join(options.logDirectory, candidate.filename)
      const stats = await fs.lstat(filePath)
      if (
        !stats.isFile()
        || stats.mtimeMs !== candidate.mtimeMs
        || stats.size !== candidate.size
      ) {
        throw new Error("Legacy log cleanup preview is stale; preview again")
      }
      return { candidate, filePath }
    }),
  )

  let deleted = 0
  let permissionsRepaired = 0
  for (const { candidate, filePath } of verified) {
    if (candidate.action === "delete") {
      await fs.unlink(filePath)
      deleted += 1
    } else {
      await fs.chmod(filePath, PRIVATE_FILE_MODE)
      permissionsRepaired += 1
    }
  }
  return { deleted, permissionsRepaired }
}
