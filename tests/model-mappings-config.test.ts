import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  ModelMappingsValidationError,
  validateModelMappings,
  validateModelMappingsOutcome,
} from "../src/lib/config"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { force: true, recursive: true })
  }
})

describe("model mapping configuration", () => {
  test("accepts an exact one-hop mapping snapshot without normalizing values", () => {
    const result = validateModelMappings({
      " gpt-source ": " gpt-target ",
      "gpt-role": "gpt-live",
    })

    expect(Object.entries(result)).toEqual([
      [" gpt-source ", " gpt-target "],
      ["gpt-role", "gpt-live"],
    ])
    expect(Object.getPrototypeOf(result)).toBeNull()
  })

  test("rejects malformed and ambiguous mapping sets as a whole", () => {
    const invalidMappings = [
      { " ": "gpt-target" },
      { "gpt-source": " " },
      { "gpt-source": "gpt-source" },
      { a: "b", b: "c" },
      { a: "b", b: "a" },
      JSON.parse('{"__proto__":"gpt-target"}') as Record<string, string>,
      { "gpt-source": "constructor" },
    ]

    for (const mappings of invalidMappings) {
      expect(() => validateModelMappings(mappings)).toThrow(
        ModelMappingsValidationError,
      )
    }
  })

  test("returns serializable diagnostics without losing model names", () => {
    expect(
      validateModelMappingsOutcome({
        chain: "target",
        target: "live",
        self: "self",
        safe: "constructor",
        " ": "blank-source-target",
        blankTarget: " ",
      }),
    ).toEqual({
      diagnostics: [
        { code: "chain", source: "chain", target: "target" },
        { code: "self_mapping", source: "self", target: "self" },
        { code: "unsafe_name", source: "safe", target: "constructor" },
        { code: "whitespace_source", source: " " },
        { code: "whitespace_target", source: "blankTarget", target: " " },
      ],
      ok: false,
    })

    const valid = validateModelMappingsOutcome({
      " alias with spaces ": "provider/model with spaces",
    })
    expect(valid.ok).toBeTrue()
    if (valid.ok) {
      expect(Object.entries(valid.modelMappings)).toEqual([
        [" alias with spaces ", "provider/model with spaces"],
      ])
      expect(Object.getPrototypeOf(valid.modelMappings)).toBeNull()
    }
  })

  test("disables an invalid on-disk mapping snapshot atomically", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-api-model-mappings-"),
    )
    tempDirs.push(tempDir)
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      `${JSON.stringify({
        modelMappings: {
          valid: "target",
          target: "valid",
        },
      })}\n`,
      "utf8",
    )

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        'const { getModelMappings } = await import("./src/lib/config"); process.stdout.write(`RESULT:${JSON.stringify(getModelMappings())}`);',
      ],
      cwd,
      env: {
        ...process.env,
        COPILOT_API_HOME: tempDir,
        COPILOT_API_ENTERPRISE_URL: "",
        COPILOT_API_OAUTH_APP: "",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(decoder.decode(result.stdout)).toEndWith("RESULT:{}")
  })
})
