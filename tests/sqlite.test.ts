import { describe, expect, test } from "bun:test"

import {
  isNodeSqliteSupportedVersion,
  isSqliteRuntimeSupported,
  iterateSqliteStatement,
  SqliteDbStore,
  type SqliteDatabase,
  type SqliteStatement,
} from "~/lib/sqlite"

describe("sqlite runtime support", () => {
  test("detects the minimum Node.js version for node:sqlite", () => {
    expect(isNodeSqliteSupportedVersion("22.12.0")).toBe(false)
    expect(isNodeSqliteSupportedVersion("22.13.0")).toBe(true)
    expect(isNodeSqliteSupportedVersion("23.0.0")).toBe(true)
  })

  test("disables SQLite on older Node.js versions while allowing Bun", () => {
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.12.0" }),
    ).toBe(false)
    expect(
      isSqliteRuntimeSupported({ isBun: false, nodeVersion: "22.13.0" }),
    ).toBe(true)
    expect(
      isSqliteRuntimeSupported({ isBun: true, nodeVersion: "20.0.0" }),
    ).toBe(true)
  })
})

describe("sqlite statement iteration", () => {
  test("uses streaming iteration when the runtime exposes it", () => {
    const values: Array<number> = []
    const statement: SqliteStatement = {
      all: () => {
        throw new Error("all should not run")
      },
      get: () => undefined,
      iterate: function* (start, end) {
        expect(start).toBe(10)
        expect(end).toBe(20)
        yield 1
        yield 2
      },
      run: () => undefined,
    }

    for (const value of iterateSqliteStatement(statement, 10, 20)) {
      values.push(value as number)
    }
    expect(values).toEqual([1, 2])
  })

  test("falls back to materialized rows for compatible test doubles", () => {
    const statement: SqliteStatement = {
      all: (...values) => values,
      get: () => undefined,
      run: () => undefined,
    }
    expect([...iterateSqliteStatement(statement, 3, 4)]).toEqual([3, 4])
  })
})

describe("SqliteDbStore open recovery", () => {
  const createDatabase = (): SqliteDatabase => ({
    close: () => undefined,
    exec: () => undefined,
    prepare: () => ({
      all: () => [],
      get: () => undefined,
      run: () => undefined,
    }),
  })

  // Sequencing matters in these tests, so each rejection is awaited explicitly
  // rather than through `expect(...).rejects`.
  const expectRejection = async (
    promise: Promise<unknown>,
    expected: string,
  ): Promise<void> => {
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(expected)
  }

  test("retries the open after a transient failure", async () => {
    let attempts = 0
    const database = createDatabase()
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(new Error("EBUSY: database is locked"))
        }
        return Promise.resolve(database)
      },
      retryCooldownMs: 0,
    })

    await expectRejection(store.getDb(), "EBUSY")
    // `??=` used to cache the rejected promise forever, permanently disabling
    // every read for the process lifetime.
    expect(await store.getDb()).toBe(database)
    expect(attempts).toBe(2)
  })

  test("caches a successful open", async () => {
    let attempts = 0
    const database = createDatabase()
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: () => {
        attempts += 1
        return Promise.resolve(database)
      },
    })

    await store.getDb()
    await store.getDb()

    expect(attempts).toBe(1)
  })

  test("does not reopen once per caller while a file stays unusable", async () => {
    let attempts = 0
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: () => {
        attempts += 1
        return Promise.reject(new Error("ENOSPC: no space left on device"))
      },
      retryCooldownMs: 60_000,
    })

    for (let index = 0; index < 25; index += 1) {
      await expectRejection(store.getDb(), "ENOSPC")
    }

    expect(attempts).toBe(1)
  })

  test("shares a single in-flight open across concurrent callers", async () => {
    let attempts = 0
    const database = createDatabase()
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: async () => {
        attempts += 1
        await Promise.resolve()
        return database
      },
    })

    const results = await Promise.all([
      store.getDb(),
      store.getDb(),
      store.getDb(),
    ])

    expect(results).toEqual([database, database, database])
    expect(attempts).toBe(1)
  })

  test("close tolerates a failed open and clears the cooldown", async () => {
    let attempts = 0
    const database = createDatabase()
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(new Error("EACCES: permission denied"))
        }
        return Promise.resolve(database)
      },
      retryCooldownMs: 60_000,
    })

    await expectRejection(store.getDb(), "EACCES")
    await store.close()
    expect(await store.getDb()).toBe(database)
  })

  test("close runs beforeClose and closes an opened database", async () => {
    const closed: Array<string> = []
    const database: SqliteDatabase = {
      close: () => closed.push("close"),
      exec: () => undefined,
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: () => undefined,
      }),
    }
    const store = new SqliteDbStore({
      getPath: () => ":memory:",
      openDatabase: () => Promise.resolve(database),
    })

    await store.getDb()
    await store.close({ beforeClose: () => closed.push("beforeClose") })

    expect(closed).toEqual(["beforeClose", "close"])
  })
})
