import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  mergeLcovFiles,
  mergeLcovFilesSync,
  runMergeLcovCli,
} from "../scripts/coverage/merge-lcov"

const roots: string[] = []
const mergeLcovCli = path.join(
  import.meta.dir,
  "../scripts/coverage/merge-lcov.ts",
)

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  )
})

describe("LCOV merge helper", () => {
  test("rejects empty async and synchronous input sets", () => {
    expect(mergeLcovFiles("unused.info", [])).rejects.toThrow(
      "merge-lcov requires at least one input file",
    )
    expect(() => mergeLcovFilesSync("unused.info", [])).toThrow(
      "merge-lcov requires at least one input file",
    )
  })

  test("reads every input before replacing an output that is also an input", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-lcov-"))
    roots.push(root)
    const output = path.join(root, "main.info")
    const boundary = path.join(root, "boundary.info")
    await fs.writeFile(output, "SF:main.ts\nDA:1,1\nend_of_record\n")
    await fs.writeFile(boundary, "SF:boundary.ts\nDA:2,1\nend_of_record\n")

    await mergeLcovFiles(output, [output, boundary])

    expect(await fs.readFile(output, "utf8")).toBe(
      "SF:main.ts\nDA:1,1\nend_of_record\nSF:boundary.ts\nDA:2,1\nend_of_record\n",
    )
  })

  test("filters the final input to isolated boundary sources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-lcov-filter-"))
    roots.push(root)
    const output = path.join(root, "main.info")
    const boundary = path.join(root, "boundary.info")
    await fs.writeFile(output, "SF:main.ts\nDA:1,1\nend_of_record\n")
    await fs.writeFile(
      boundary,
      [
        "SF:boundary.ts\nDA:2,1\nend_of_record",
        "SF:unrelated.ts\nDA:3,0\nend_of_record",
        "",
      ].join("\n"),
    )

    await mergeLcovFiles(output, [output, boundary], new Set(["boundary.ts"]))

    const merged = await fs.readFile(output, "utf8")
    expect(merged).toContain("SF:main.ts")
    expect(merged).toContain("SF:boundary.ts")
    expect(merged).not.toContain("SF:unrelated.ts")
  })

  test("synchronously filters all non-allowlisted boundary records before replacing the output", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "merge-lcov-sync-filter-"),
    )
    roots.push(root)
    const output = path.join(root, "main.info")
    const boundary = path.join(root, "boundary.info")
    await fs.writeFile(output, "SF:main.ts\nDA:1,1\nend_of_record\n")
    await fs.writeFile(
      boundary,
      [
        "SF:allowed.ts\nDA:2,1\nend_of_record",
        "SF:outside.ts\nDA:3,1\nend_of_record",
        "",
      ].join("\n"),
    )

    mergeLcovFilesSync(output, [output, boundary], new Set(["allowed.ts"]))

    expect(await fs.readFile(output, "utf8")).toBe(
      "SF:main.ts\nDA:1,1\nend_of_record\nSF:allowed.ts\nDA:2,1\nend_of_record\n",
    )
  })

  test("CLI filters the final input through the explicit allowlist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-lcov-cli-"))
    roots.push(root)
    const output = path.join(root, "merged.info")
    const main = path.join(root, "main.info")
    const boundary = path.join(root, "boundary.info")
    await fs.writeFile(main, "SF:main.ts\nDA:1,1\nend_of_record\n")
    await fs.writeFile(
      boundary,
      [
        "SF:allowed.ts\nDA:2,1\nend_of_record",
        "SF:outside.ts\nDA:3,1\nend_of_record",
        "",
      ].join("\n"),
    )

    await runMergeLcovCli([
      output,
      main,
      boundary,
      "--include-from-last",
      "allowed.ts",
    ])

    expect(await fs.readFile(output, "utf8")).toBe(
      "SF:main.ts\nDA:1,1\nend_of_record\nSF:allowed.ts\nDA:2,1\nend_of_record\n",
    )

    const subprocessOutput = path.join(root, "subprocess.info")
    const subprocess = Bun.spawnSync([
      process.execPath,
      mergeLcovCli,
      subprocessOutput,
      main,
      boundary,
      "--include-from-last",
      "allowed.ts",
    ])
    expect(subprocess.exitCode).toBe(0)
    expect(await fs.readFile(subprocessOutput, "utf8")).toBe(
      "SF:main.ts\nDA:1,1\nend_of_record\nSF:allowed.ts\nDA:2,1\nend_of_record\n",
    )
  })
})
