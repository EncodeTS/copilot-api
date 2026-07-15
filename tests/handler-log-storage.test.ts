import { expect, test } from "bun:test"
import fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createHandlerLogStorage,
  type HandlerLogFileSystem,
} from "../src/lib/handler-log-storage"

test("handler log append only buffers until an async flush", async () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-buffering-"),
  )
  const logDirectory = path.join(parentDirectory, "logs")
  const storage = createHandlerLogStorage({
    logDirectory,
    startTimers: false,
  })

  try {
    storage.append(
      path.join(logDirectory, "buffer-handler-2026-07-15.log"),
      "buffer.event",
    )
    expect(fs.existsSync(logDirectory)).toBeFalse()

    await storage.flush()
    expect(
      fs.existsSync(
        path.join(logDirectory, "buffer-handler-2026-07-15.part-0.log"),
      ),
    ).toBeTrue()
  } finally {
    await storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})

test("handler log storage makes its directory and opened files private", async () => {
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
    await storage.flush()

    expect(fs.statSync(logDirectory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(existingSegmentPath).mode & 0o777).toBe(0o600)
    const newSegmentPath = path.join(
      logDirectory,
      `new-handler-${dateKey}.part-0.log`,
    )
    expect(fs.statSync(newSegmentPath).mode & 0o777).toBe(0o600)
  } finally {
    await storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})

test("handler log storage resumes the latest segment and rotates on UTF-8 boundaries", async () => {
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
    await storage.flush()

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
    await storage.close()
    fs.rmSync(logDirectory, { force: true, recursive: true })
  }
})

test("handler log storage applies retention and budget only to managed files", async () => {
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
    await storage.cleanup()
    const remaining = fs.readdirSync(logDirectory)

    expect(remaining).not.toContain(expiredManaged)
    expect(remaining).not.toContain(recentFiles[0])
    expect(remaining).toContain(recentFiles[1])
    expect(remaining).toContain(recentFiles[2])
    expect(remaining).toContain(legacyLog)
    expect(remaining).toContain(privateAudit)
    expect(remaining).toContain("directory-handler-2026-07-15.part-0.log")
  } finally {
    await storage.close()
    fs.rmSync(logDirectory, { force: true, recursive: true })
  }
})

test("handler log cleanup reports a permission failure and rebuilds a deleted directory", async () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-rebuild-"),
  )
  const logDirectory = path.join(parentDirectory, "logs")
  const errors: Array<{ message: string; error: unknown }> = []
  let failNextChmod = false
  const fileSystem: HandlerLogFileSystem = {
    ...fsPromises,
    chmod: async (...args) => {
      if (failNextChmod) {
        failNextChmod = false
        throw new Error("test chmod failure")
      }
      await fsPromises.chmod(...args)
    },
  }
  const storage = createHandlerLogStorage({
    fileSystem,
    logDirectory,
    onError: (message, error) => errors.push({ error, message }),
    startTimers: false,
  })
  const basePath = path.join(logDirectory, "rebuild-handler-2026-07-15.log")

  try {
    storage.append(basePath, "before-delete")
    await storage.flush()
    await fsPromises.rm(logDirectory, { force: true, recursive: true })
    failNextChmod = true

    await storage.cleanup()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe("Failed to clean handler logs")

    storage.append(basePath, "after-delete")
    await storage.flush()
    expect(errors.map(({ message }) => message)).toEqual([
      "Failed to clean handler logs",
      "Failed to initialize handler logs",
    ])
    const rebuiltLog = path.join(
      logDirectory,
      "rebuild-handler-2026-07-15.part-0.log",
    )
    expect(fs.readFileSync(rebuiltLog, "utf8")).toContain("after-delete")
  } finally {
    await storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})

test("handler log flush reports a write failure and retries buffered lines", async () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-write-error-"),
  )
  const logDirectory = path.join(parentDirectory, "logs")
  const errors: Array<{ message: string; error: unknown }> = []
  let failNextOpen = true
  const open = (async (
    filePath: Parameters<typeof fsPromises.open>[0],
    flags: Parameters<typeof fsPromises.open>[1],
    mode?: Parameters<typeof fsPromises.open>[2],
  ) => {
    if (failNextOpen) {
      failNextOpen = false
      throw new Error("test open failure")
    }
    return await fsPromises.open(filePath, flags, mode)
  }) as HandlerLogFileSystem["open"]
  const storage = createHandlerLogStorage({
    fileSystem: { ...fsPromises, open },
    logDirectory,
    onError: (message, error) => errors.push({ error, message }),
    startTimers: false,
  })
  const basePath = path.join(logDirectory, "write-error-handler-2026-07-15.log")

  try {
    storage.append(basePath, "retry-this-line")
    await storage.flush()
    expect(errors[0]?.message).toBe("Failed to write handler log")

    await storage.flush()
    const logPath = path.join(
      logDirectory,
      "write-error-handler-2026-07-15.part-0.log",
    )
    expect(fs.readFileSync(logPath, "utf8")).toBe("retry-this-line\n")
  } finally {
    await storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})

test("handler log storage bounds its in-memory buffer during disk stalls", async () => {
  const parentDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-storage-buffer-limit-"),
  )
  const logDirectory = path.join(parentDirectory, "logs")
  const errors: Array<string> = []
  const storage = createHandlerLogStorage({
    logDirectory,
    maxBufferedBytes: 12,
    maxBufferSize: 2,
    onError: (message) => errors.push(message),
    startTimers: false,
  })
  const basePath = path.join(
    logDirectory,
    "buffer-limit-handler-2026-07-15.log",
  )

  try {
    storage.append(basePath, "first")
    storage.append(basePath, "second")
    storage.append(basePath, "third")
    expect(errors).toEqual([
      "Handler log buffer limit reached; dropping new log entries",
    ])

    await storage.flush()
    storage.append(basePath, "fourth")
    await storage.flush()

    const logPath = path.join(
      logDirectory,
      "buffer-limit-handler-2026-07-15.part-0.log",
    )
    expect(fs.readFileSync(logPath, "utf8")).toBe("first\nthird\nfourth\n")
    expect(errors).toHaveLength(1)
  } finally {
    await storage.close()
    fs.rmSync(parentDirectory, { force: true, recursive: true })
  }
})
