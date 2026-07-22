import { describe, expect, test } from "bun:test"

import {
  isNodeSqliteSupportedVersion,
  isSqliteRuntimeSupported,
  iterateSqliteStatement,
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
