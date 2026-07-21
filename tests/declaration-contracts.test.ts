import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const declarationModules = [
  "src/lib/token-manager-types.d.ts",
  "src/lib/zstd-worker-protocol.d.ts",
  "src/services/codex/provider-catalog-types.d.ts",
]
const repository = join(import.meta.dir, "..")
const consumer = join(
  import.meta.dir,
  "fixtures/declaration-contract/consumer.ts",
)

describe("shared declaration contracts", () => {
  test("remain declarations and compile through extensionless type imports", () => {
    for (const declaration of declarationModules) {
      expect(existsSync(join(repository, declaration))).toBe(true)
      expect(
        existsSync(join(repository, declaration.replace(/\.d\.ts$/, ".ts"))),
      ).toBe(false)
    }

    const result = spawnSync(
      process.execPath,
      [
        "x",
        "tsc",
        "--project",
        "tests/fixtures/declaration-contract/tsconfig.json",
        "--pretty",
        "false",
      ],
      { cwd: repository, encoding: "utf8" },
    )

    expect(`${result.stdout}${result.stderr}`).toBe("")
    expect(result.status).toBe(0)
  })

  test("erase completely from the runtime bundle", async () => {
    const result = await Bun.build({
      entrypoints: [consumer],
      format: "esm",
      target: "bun",
    })

    expect(result.logs).toEqual([])
    expect(result.success).toBe(true)
    expect(result.outputs).toHaveLength(1)
    const output = await result.outputs[0]?.text()
    expect(output).toBeDefined()
    expect(output).not.toMatch(
      /token-manager-types|zstd-worker-protocol|provider-catalog-types/,
    )
    expect(output).not.toMatch(/\b(?:import|require)\b/)
  })
})
