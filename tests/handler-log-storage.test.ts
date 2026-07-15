import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createHandlerLogStorage } from "../src/lib/handler-log-storage"

test("handler log storage makes its directory and opened files private", () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-permissions-"),
  )
  const logDirectory = path.join(parentDirectory, "logs")
  fs.mkdirSync(logDirectory, { mode: 0o755 })

  const dateKey = "2026-07-15"
  const existingBasePath = path.join(
    logDirectory,
    `existing-handler-${dateKey}.log`,
  )
  const existingSegmentPath = path.join(
    logDirectory,
    `existing-handler-${dateKey}.part-0.log`,
  )
  fs.writeFileSync(existingSegmentPath, "existing\n", { mode: 0o644 })

  const storage = createHandlerLogStorage({
    logDirectory,
    startTimers: false,
  })

  try {
    storage.append(existingBasePath, "existing.event")
    storage.append(
      path.join(logDirectory, `new-handler-${dateKey}.log`),
      "new.event",
    )
    storage.flush()

    expect(fs.statSync(logDirectory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(existingSegmentPath).mode & 0o777).toBe(0o600)
    const newSegmentPath = path.join(
      logDirectory,
      `new-handler-${dateKey}.part-0.log`,
    )
    expect(fs.statSync(newSegmentPath).mode & 0o777).toBe(0o600)
  } finally {
    storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})

test("handler log storage resumes the latest segment and rotates on UTF-8 boundaries", () => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-rotation-"),
  )
  const basePath = path.join(logDirectory, "resume-handler-2026-07-15.log")
  const oldSegment = path.join(
    logDirectory,
    "resume-handler-2026-07-15.part-0.log",
  )
  const latestSegment = path.join(
    logDirectory,
    "resume-handler-2026-07-15.part-2.log",
  )
  fs.writeFileSync(oldSegment, "old")
  fs.writeFileSync(latestSegment, "x".repeat(63))
  fs.writeFileSync(
    path.join(logDirectory, "resume-handler-2026-07-15.part-x.log"),
    "ignored",
  )

  const storage = createHandlerLogStorage({
    logDirectory,
    maxFileBytes: 64,
    maxTotalBytes: 4096,
    startTimers: false,
  })
  const payload = "你".repeat(80)

  try {
    storage.append(basePath, payload)
    storage.flush()

    expect(fs.readFileSync(oldSegment, "utf8")).toBe("old")
    expect(fs.statSync(latestSegment).size).toBe(63)
    const rotatedFiles = fs
      .readdirSync(logDirectory)
      .filter((entry) => /^resume-handler-.*\.part-\d+\.log$/u.test(entry))
    expect(rotatedFiles).toContain("resume-handler-2026-07-15.part-3.log")
    for (const file of rotatedFiles) {
      const bytes = fs.readFileSync(path.join(logDirectory, file))
      expect(bytes.length).toBeLessThanOrEqual(64)
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ).not.toThrow()
    }
    const resumedContent = rotatedFiles
      .filter((file) => !file.endsWith("part-0.log"))
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      )
      .map((file) => fs.readFileSync(path.join(logDirectory, file), "utf8"))
      .join("")
    expect(resumedContent).toBe(`${"x".repeat(63)}${payload}\n`)
  } finally {
    storage.close()
    fs.rmSync(logDirectory, { force: true, recursive: true })
  }
})

test("handler log storage applies retention and budget only to managed files", () => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-cleanup-"),
  )
  const now = Date.UTC(2026, 6, 15, 12)
  const recentFiles = [
    "oldest-handler-2026-07-15.part-0.log",
    "middle-handler-2026-07-15.part-0.log",
    "newest-handler-2026-07-15.part-0.log",
  ]
  for (const [index, filename] of recentFiles.entries()) {
    const filePath = path.join(logDirectory, filename)
    fs.writeFileSync(filePath, "x".repeat(400))
    const modifiedAt = new Date(now - (3 - index) * 60_000)
    fs.utimesSync(filePath, modifiedAt, modifiedAt)
  }

  const expiredManaged = "expired-handler-2026-07-01.part-0.log"
  const legacyLog = "legacy-handler-2026-07-01.log"
  const privateAudit = "private-audit.log"
  const oldDate = new Date(now - 30 * 24 * 60 * 60 * 1000)
  for (const filename of [expiredManaged, legacyLog, privateAudit]) {
    const filePath = path.join(logDirectory, filename)
    fs.writeFileSync(filePath, "old".repeat(200))
    fs.utimesSync(filePath, oldDate, oldDate)
  }
  fs.mkdirSync(
    path.join(logDirectory, "directory-handler-2026-07-15.part-0.log"),
  )

  const storage = createHandlerLogStorage({
    logDirectory,
    maxFileBytes: 512,
    maxTotalBytes: 1024,
    now: () => now,
    startTimers: false,
  })

  try {
    storage.cleanup()
    const remaining = fs.readdirSync(logDirectory)

    expect(remaining).not.toContain(expiredManaged)
    expect(remaining).not.toContain(recentFiles[0])
    expect(remaining).toContain(recentFiles[1])
    expect(remaining).toContain(recentFiles[2])
    expect(remaining).toContain(legacyLog)
    expect(remaining).toContain(privateAudit)
    expect(remaining).toContain("directory-handler-2026-07-15.part-0.log")
  } finally {
    storage.close()
    fs.rmSync(logDirectory, { force: true, recursive: true })
  }
})
