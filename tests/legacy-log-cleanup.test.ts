import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  applyLegacyLogCleanup,
  LEGACY_LOG_CLEANUP_CONFIRMATION,
  previewLegacyLogCleanup,
} from "~/lib/legacy-log-cleanup"
import { supportsPosixPermissionModes } from "~/lib/file-protection"

const tempDirectories: Array<string> = []

const createTempDirectory = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

const createFixture = () => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-legacy-preview-"),
  )
  tempDirectories.push(logDirectory)
  const files = {
    arbitrary: path.join(logDirectory, "private-audit-2026-07-01.log"),
    managed: path.join(logDirectory, "responses-handler-2026-07-20.part-0.log"),
    oldLegacy: path.join(logDirectory, "responses-handler-2026-07-01.log"),
    recentLegacy: path.join(logDirectory, "responses-handler-2026-07-20.log"),
  }
  for (const filePath of Object.values(files)) {
    fs.writeFileSync(filePath, path.basename(filePath), { mode: 0o644 })
    fs.chmodSync(filePath, 0o644)
  }
  fs.utimesSync(files.oldLegacy, new Date("2026-07-01"), new Date("2026-07-01"))
  fs.utimesSync(
    files.recentLegacy,
    new Date("2026-07-20"),
    new Date("2026-07-20"),
  )
  return { files, logDirectory }
}

describe("legacy handler log cleanup", () => {
  test("returns a stable empty preview when the log directory is absent", async () => {
    const logDirectory = path.join(
      createTempDirectory("copilot-api-missing-log-parent-"),
      "missing",
    )
    const preview = await previewLegacyLogCleanup({ logDirectory })

    expect(preview.candidates).toEqual([])
    expect(preview.previewId).toMatch(/^[a-f0-9]{64}$/u)
    expect(preview.retentionDays).toBe(7)
  })
  test("previews only exact legacy candidates before changing anything", async () => {
    const { files, logDirectory } = createFixture()
    const preview = await previewLegacyLogCleanup({
      logDirectory,
      now: () => new Date("2026-07-21T00:00:00Z").getTime(),
      retentionDays: 7,
    })

    expect(preview.candidates[0]).toMatchObject({
      action: "delete",
      filename: path.basename(files.oldLegacy),
    })
    if (supportsPosixPermissionModes()) {
      expect(preview.candidates[1]).toMatchObject({
        action: "repair_permissions",
        filename: path.basename(files.recentLegacy),
      })
    }
    expect(preview.candidates.map(({ filename }) => filename)).not.toContain(
      path.basename(files.managed),
    )
    expect(preview.candidates.map(({ filename }) => filename)).not.toContain(
      path.basename(files.arbitrary),
    )
    expect(fs.existsSync(files.oldLegacy)).toBe(true)
    expect(fs.statSync(files.recentLegacy).mode & 0o777).toBe(0o644)
  })

  test("requires the exact confirmation and matching preview before cleanup", async () => {
    const { files, logDirectory } = createFixture()
    const options = {
      logDirectory,
      now: () => new Date("2026-07-21T00:00:00Z").getTime(),
      retentionDays: 7,
    }
    const preview = await previewLegacyLogCleanup(options)

    let confirmationError: unknown
    try {
      await applyLegacyLogCleanup({
        ...options,
        confirmation: "yes",
        previewId: preview.previewId,
      })
    } catch (error) {
      confirmationError = error
    }
    expect(confirmationError).toBeInstanceOf(Error)
    expect((confirmationError as Error).message).toContain("confirmation")
    expect(fs.existsSync(files.oldLegacy)).toBe(true)

    const result = await applyLegacyLogCleanup({
      ...options,
      confirmation: LEGACY_LOG_CLEANUP_CONFIRMATION,
      previewId: preview.previewId,
    })
    expect(result).toEqual({
      deleted: 1,
      permissionsRepaired: supportsPosixPermissionModes() ? 1 : 0,
    })
    expect(fs.existsSync(files.oldLegacy)).toBe(false)
    if (supportsPosixPermissionModes()) {
      expect(fs.statSync(files.recentLegacy).mode & 0o777).toBe(0o600)
    }
    expect(fs.existsSync(files.managed)).toBe(true)
    expect(fs.existsSync(files.arbitrary)).toBe(true)
  })

  test("rejects a stale preview instead of deleting a changed candidate set", async () => {
    const { logDirectory } = createFixture()
    const options = {
      logDirectory,
      now: () => new Date("2026-07-21T00:00:00Z").getTime(),
      retentionDays: 7,
    }
    const preview = await previewLegacyLogCleanup(options)
    fs.writeFileSync(
      path.join(logDirectory, "messages-handler-2026-06-01.log"),
      "new",
    )

    let stalePreviewError: unknown
    try {
      await applyLegacyLogCleanup({
        ...options,
        confirmation: LEGACY_LOG_CLEANUP_CONFIRMATION,
        previewId: preview.previewId,
      })
    } catch (error) {
      stalePreviewError = error
    }
    expect(stalePreviewError).toBeInstanceOf(Error)
    expect((stalePreviewError as Error).message).toContain("stale")
  })
})
