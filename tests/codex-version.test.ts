import { describe, expect, test } from "bun:test"

import {
  normalizeCodexVersion,
  parseInstalledCodexVersion,
} from "../src/services/codex/version"

describe("Codex versions", () => {
  test("normalizes supported semantic versions", () => {
    expect(normalizeCodexVersion(" 0.144.1-beta.2 ")).toBe("0.144.1-beta.2")
    expect(normalizeCodexVersion("invalid")).toBeNull()
    expect(normalizeCodexVersion(`0.144.1-${"a".repeat(100)}`)).toBeNull()
  })

  test("parses Windows-style executable output", () => {
    expect(parseInstalledCodexVersion("codex-cli 0.144.1\r\n")).toBe("0.144.1")
    expect(parseInstalledCodexVersion("unexpected output")).toBeNull()
  })
})
