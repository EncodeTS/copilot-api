import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  atomicWriteProtectedFile,
  atomicWriteProtectedFileSync,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixPermissionModes,
} from "~/lib/file-protection"
import {
  openSqliteDatabase,
  SqliteDbStore,
  type SqliteDatabase,
} from "~/lib/sqlite"

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

const mode = (filePath: string): number => fs.statSync(filePath).mode & 0o777

describe("protected local state", () => {
  test("atomic sync and async writes replace content with private modes", async () => {
    const directory = createTempDirectory("copilot-api-protected-write-")
    const syncPath = path.join(directory, "config.json")
    const asyncPath = path.join(directory, "desktop-config.json")
    fs.chmodSync(directory, 0o755)

    atomicWriteProtectedFileSync(syncPath, "first\n")
    atomicWriteProtectedFileSync(syncPath, "second\n")
    await atomicWriteProtectedFile(asyncPath, "desktop\n")

    expect(fs.readFileSync(syncPath, "utf8")).toBe("second\n")
    expect(fs.readFileSync(asyncPath, "utf8")).toBe("desktop\n")
    expect(
      fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([])
    if (supportsPosixPermissionModes()) {
      expect(mode(directory)).toBe(PRIVATE_DIRECTORY_MODE)
      expect(mode(syncPath)).toBe(PRIVATE_FILE_MODE)
      expect(mode(asyncPath)).toBe(PRIVATE_FILE_MODE)
    }
  })

  test("reports Windows permission semantics truthfully", () => {
    expect(supportsPosixPermissionModes("win32")).toBe(false)
    expect(supportsPosixPermissionModes("linux")).toBe(true)
    expect(supportsPosixPermissionModes("darwin")).toBe(true)
  })

  test("refuses to follow a symlink at a sensitive state path", async () => {
    if (process.platform === "win32") return
    const directory = createTempDirectory("copilot-api-private-symlink-")
    const target = path.join(directory, "target")
    const sensitivePath = path.join(directory, "config.json")
    fs.writeFileSync(target, "outside", { mode: 0o644 })
    fs.symlinkSync(target, sensitivePath)

    const { repairPrivateFile } = await import("~/lib/file-protection")
    let rejection: unknown
    try {
      await repairPrivateFile(sensitivePath)
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain("not a regular file")
    expect(fs.readFileSync(target, "utf8")).toBe("outside")
    expect(mode(target)).toBe(0o644)
  })

  test("repairs SQLite database, WAL, and SHM modes after initialization", async () => {
    const directory = createTempDirectory("copilot-api-private-sqlite-")
    const dbPath = path.join(directory, "usage.sqlite")
    const store = new SqliteDbStore({
      getPath: () => dbPath,
      initialize(db) {
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("CREATE TABLE private_fixture (id INTEGER PRIMARY KEY)")
      },
    })

    const db = await store.getDb()
    db.prepare("INSERT INTO private_fixture DEFAULT VALUES").run()

    if (supportsPosixPermissionModes()) {
      expect(mode(directory)).toBe(PRIVATE_DIRECTORY_MODE)
      expect(mode(dbPath)).toBe(PRIVATE_FILE_MODE)
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`
        if (fs.existsSync(sidecar))
          expect(mode(sidecar)).toBe(PRIVATE_FILE_MODE)
      }
    }

    await store.close()
  })

  test("rejects preexisting SQLite database and sidecar symlinks before open", async () => {
    if (process.platform === "win32") return
    const directory = createTempDirectory("copilot-api-sqlite-symlink-")
    const target = path.join(directory, "outside")
    fs.writeFileSync(target, "outside")
    const database: SqliteDatabase = {
      close: () => {},
      exec: () => undefined,
      prepare: () => ({ all: () => [], get: () => null, run: () => null }),
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const dbPath = path.join(directory, `usage-${suffix || "db"}.sqlite`)
      if (suffix) fs.writeFileSync(dbPath, "")
      fs.symlinkSync(target, `${dbPath}${suffix}`)
      let opened = 0

      let rejection: unknown
      try {
        await openSqliteDatabase(dbPath, {
          openDatabase: () => {
            opened += 1
            return Promise.resolve(database)
          },
        })
      } catch (error) {
        rejection = error
      }
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toContain("not a regular file")
      expect(opened).toBe(0)
      expect(fs.readFileSync(target, "utf8")).toBe("outside")
    }
  })

  test("closes a newly opened database when post-initialize sidecar validation fails", async () => {
    if (process.platform === "win32") return
    const directory = createTempDirectory("copilot-api-sqlite-close-")
    const dbPath = path.join(directory, "usage.sqlite")
    const target = path.join(directory, "outside")
    fs.writeFileSync(target, "outside")
    const closed: Array<boolean> = []
    const database: SqliteDatabase = {
      close: () => {
        closed.push(true)
      },
      exec: () => undefined,
      prepare: () => ({ all: () => [], get: () => null, run: () => null }),
    }
    const store = new SqliteDbStore({
      getPath: () => dbPath,
      openDatabase: () => {
        fs.writeFileSync(dbPath, "")
        return Promise.resolve(database)
      },
      initialize() {
        fs.symlinkSync(target, `${dbPath}-wal`)
      },
    })

    let rejection: unknown
    try {
      await store.getDb()
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain("not a regular file")
    expect(closed).toEqual([true])
  })

  test("closes the raw SQLite handle when a sidecar appears during open", async () => {
    if (process.platform === "win32") return
    const directory = createTempDirectory("copilot-api-sqlite-open-close-")
    const dbPath = path.join(directory, "usage.sqlite")
    const target = path.join(directory, "outside")
    fs.writeFileSync(target, "outside")
    const closed: Array<boolean> = []
    const database: SqliteDatabase = {
      close: () => {
        closed.push(true)
      },
      exec: () => undefined,
      prepare: () => ({ all: () => [], get: () => null, run: () => null }),
    }

    let rejection: unknown
    try {
      await openSqliteDatabase(dbPath, {
        openDatabase: () => {
          fs.writeFileSync(dbPath, "")
          fs.symlinkSync(target, `${dbPath}-shm`)
          return Promise.resolve(database)
        },
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain("not a regular file")
    expect(closed).toEqual([true])
  })
})
