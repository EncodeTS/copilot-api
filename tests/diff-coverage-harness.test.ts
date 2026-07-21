import { afterEach, describe, expect, test } from "bun:test"
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

import {
  checkDiffCoverage,
  isProductionSource,
} from "../scripts/coverage/diff-coverage"
import { runDiffCoverageCli } from "../scripts/check-diff-coverage"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function runGit(repository: string, ...arguments_: string[]): string {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout)
  }

  return result.stdout.trim()
}

function createChangedProductionFile(
  productionPath = "src/value.ts",
  attributes?: string,
): {
  base: string
  lcovPath: string
  repository: string
} {
  const repository = mkdtempSync(join(tmpdir(), "diff-coverage-"))
  temporaryDirectories.push(repository)
  const absoluteProductionPath = join(repository, productionPath)
  mkdirSync(dirname(absoluteProductionPath), { recursive: true })

  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")

  if (attributes !== undefined) {
    writeFileSync(join(repository, ".gitattributes"), attributes)
  }
  writeFileSync(absoluteProductionPath, "export const value = 1\n")
  runGit(
    repository,
    "--literal-pathspecs",
    "add",
    productionPath,
    ...(attributes === undefined ? [] : [".gitattributes"]),
  )
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")

  writeFileSync(absoluteProductionPath, "export const value = 2\n")
  runGit(repository, "--literal-pathspecs", "add", productionPath)
  runGit(repository, "commit", "--quiet", "-m", "change")

  const lcovPath = join(repository, "root.lcov.info")
  return { base, lcovPath, repository }
}

function writeLcov(path: string, source: string, hits: number): void {
  writeFileSync(
    path,
    [
      "TN:",
      `SF:${source}`,
      `DA:1,${hits}`,
      "LF:1",
      `LH:${hits > 0 ? 1 : 0}`,
      "end_of_record",
      "",
    ].join("\n"),
  )
}

function createFileTransition(
  oldPath: string,
  newPath: string,
  beforeLines: string[],
  afterLines = beforeLines,
  operation: "copy" | "rename" = "rename",
): {
  base: string
  lcovPath: string
  repository: string
} {
  const repository = mkdtempSync(join(tmpdir(), "diff-coverage-rename-"))
  temporaryDirectories.push(repository)
  const absoluteOldPath = join(repository, oldPath)
  const absoluteNewPath = join(repository, newPath)
  mkdirSync(dirname(absoluteOldPath), { recursive: true })
  mkdirSync(dirname(absoluteNewPath), { recursive: true })

  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFileSync(absoluteOldPath, [...beforeLines, ""].join("\n"))
  runGit(repository, "--literal-pathspecs", "add", oldPath)
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")

  if (operation === "copy") {
    copyFileSync(absoluteOldPath, absoluteNewPath)
  } else {
    renameSync(absoluteOldPath, absoluteNewPath)
  }
  writeFileSync(absoluteNewPath, [...afterLines, ""].join("\n"))
  runGit(repository, "add", "--all")
  runGit(repository, "commit", "--quiet", "-m", "rename")

  return {
    base,
    lcovPath: join(repository, "root.lcov.info"),
    repository,
  }
}

function writeEmptyLcov(path: string, source: string): void {
  writeFileSync(path, ["TN:", `SF:${source}`, "end_of_record", ""].join("\n"))
}

describe("differential coverage gate", () => {
  test("treats release scripts as root production without widening other scripts", () => {
    expect(isProductionSource("scripts/release/quality.ts")).toBe(true)
    expect(isProductionSource("scripts/release/smoke-docker-image.mjs")).toBe(
      true,
    )
    expect(isProductionSource("scripts/benchmarks/runner.ts")).toBe(false)
  })

  test("fails when a changed release script is absent from root LCOV", () => {
    const fixture = createChangedProductionFile(
      "scripts/release/publish-artifact.ts",
    )
    writeLcov(fixture.lcovPath, "src/other.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file is missing from coverage: "scripts/release/publish-artifact.ts"',
    )
  })

  test("passes a covered changed production line", () => {
    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/value.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.coveredLines).toBe(1)
    expect(result.instrumentedLines).toBe(1)
    expect(result.percentage).toBe(100)
  })

  test("fails a deliberately uncovered changed production line", () => {
    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.percentage).toBe(0)
    expect(result.failures).toContain(
      "diff coverage 0.00% is below required 85.00%",
    )
  })

  test("allows an ordinary added type-only module with an empty LCOV record", () => {
    const repository = mkdtempSync(join(tmpdir(), "diff-coverage-added-type-"))
    temporaryDirectories.push(repository)
    runGit(repository, "init", "--quiet")
    runGit(repository, "config", "user.email", "coverage@example.invalid")
    runGit(repository, "config", "user.name", "Coverage Test")
    writeFileSync(join(repository, "README.md"), "fixture\n")
    runGit(repository, "add", "README.md")
    runGit(repository, "commit", "--quiet", "-m", "base")
    const base = runGit(repository, "rev-parse", "HEAD")

    mkdirSync(join(repository, "src"), { recursive: true })
    writeFileSync(
      join(repository, "src/types.ts"),
      "export interface FixtureType { value: string }\n",
    )
    runGit(repository, "add", "src/types.ts")
    runGit(repository, "commit", "--quiet", "-m", "add type module")
    const lcovPath = join(repository, "root.lcov.info")
    writeEmptyLcov(lcovPath, "src/types.ts")

    const result = checkDiffCoverage({
      base,
      coverage: [{ path: lcovPath, sourcePrefix: "." }],
      repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([
      {
        coveredLines: 0,
        file: "src/types.ts",
        instrumentedLines: 0,
        percentage: 100,
      },
    ])
  })

  test("fails when the LCOV file is missing", () => {
    const fixture = createChangedProductionFile()

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage file does not exist: ${fixture.lcovPath}`,
    )
  })

  test("fails when a changed production file has no LCOV record", () => {
    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/other.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file is missing from coverage: "src/value.ts"',
    )
  })

  test("maps Desktop LCOV sources into the repository namespace", () => {
    const fixture = createChangedProductionFile(
      "desktop/electron/server-manager.ts",
    )
    writeLcov(fixture.lcovPath, "electron/server-manager.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "desktop" }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([
      {
        coveredLines: 1,
        file: "desktop/electron/server-manager.ts",
        instrumentedLines: 1,
        percentage: 100,
      },
    ])
  })

  test("cannot bypass changed-line coverage with non-ASCII control characters in a path", () => {
    const productionPath = "src/控制\t[exact]*?.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, productionPath, 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.files).toEqual([
      {
        coveredLines: 0,
        file: productionPath,
        instrumentedLines: 1,
        percentage: 0,
      },
    ])
    expect(result.failures).toContain(
      "diff coverage 0.00% is below required 85.00%",
    )
  })

  test("cannot bypass changed-line coverage by marking TypeScript as binary", () => {
    const fixture = createChangedProductionFile(
      "src/value.ts",
      "src/*.ts binary\n",
    )
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.instrumentedLines).toBe(1)
    expect(result.percentage).toBe(0)
  })

  test("counts only edited lines when a production file is renamed", () => {
    const oldPath = "src/旧\t[old]*?.ts"
    const newPath = "src/新\t[new]*?.ts"
    const fixture = createFileTransition(
      oldPath,
      newPath,
      [
        "export const unchangedBefore = 1",
        "export const changed = 1",
        "export const unchangedAfter = 1",
      ],
      [
        "export const unchangedBefore = 1",
        "export const changed = 2",
        "export const unchangedAfter = 1",
      ],
    )
    writeFileSync(
      fixture.lcovPath,
      [
        "TN:",
        `SF:${newPath}`,
        "DA:1,0",
        "DA:2,1",
        "DA:3,0",
        "LF:3",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    )

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([
      {
        coveredLines: 1,
        file: newPath,
        instrumentedLines: 1,
        percentage: 100,
      },
    ])
  })

  test("treats a same-domain production copy as a whole-file target", () => {
    const newPath = "src/copied.ts"
    const sourceLines = [
      "export const unchangedBefore = 1",
      "export const unchangedAfter = 1",
    ]
    const fixture = createFileTransition(
      "src/original.ts",
      newPath,
      sourceLines,
      sourceLines,
      "copy",
    )
    writeEmptyLcov(fixture.lcovPath, newPath)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'whole-file production target has no instrumented changed lines: "src/copied.ts"',
    )
  })

  test("treats tests-to-root-production rename as an added file", () => {
    const fixture = createFileTransition("tests/helper.ts", "src/helper.ts", [
      "export const helper = 1",
    ])
    writeEmptyLcov(fixture.lcovPath, "src/helper.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'whole-file production target has no instrumented changed lines: "src/helper.ts"',
    )
  })

  test("treats scripts-to-Desktop-production rename as an added file", () => {
    const fixture = createFileTransition(
      "scripts/helper.ts",
      "desktop/src/helper.ts",
      ["export const helper = 1"],
    )
    writeEmptyLcov(fixture.lcovPath, "desktop/src/helper.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'whole-file production target has no instrumented changed lines: "desktop/src/helper.ts"',
    )
  })

  test("treats cross-domain production rename as an added file", () => {
    const fixture = createFileTransition(
      "src/helper.ts",
      "desktop/src/helper.ts",
      ["export const helper = 1"],
    )
    writeEmptyLcov(fixture.lcovPath, "desktop/src/helper.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'whole-file production target has no instrumented changed lines: "desktop/src/helper.ts"',
    )
  })

  test("treats generated and declaration renames into production as added files", () => {
    for (const oldPath of ["src/generated/helper.ts", "src/helper.d.ts"]) {
      const fixture = createFileTransition(oldPath, "src/helper.ts", [
        "export const helper = 1",
      ])
      writeEmptyLcov(fixture.lcovPath, "src/helper.ts")

      const result = checkDiffCoverage({
        base: fixture.base,
        coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
        repository: fixture.repository,
        threshold: 85,
      })

      expect(result.passed).toBe(false)
      expect(result.failures).toContain(
        'whole-file production target has no instrumented changed lines: "src/helper.ts"',
      )
    }
  })

  test("excludes only generated and declaration variants inside production roots", () => {
    expect(isProductionSource("src/route.ts")).toBe(true)
    expect(isProductionSource("desktop/src/App.tsx")).toBe(true)
    expect(isProductionSource("src/protocol.d.ts")).toBe(false)
    expect(isProductionSource("src/protocol.generated.ts")).toBe(false)
    expect(isProductionSource("src/generated/protocol.ts")).toBe(false)
  })

  test("exposes the stable CLI contract with explicit coverage inputs", () => {
    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/value.ts", 1)
    const standardOutput: string[] = []
    const standardError: string[] = []

    const exitCode = runDiffCoverageCli(
      [
        "--base",
        fixture.base,
        "--repository",
        fixture.repository,
        "--root-lcov",
        fixture.lcovPath,
        "--desktop-lcov",
        fixture.lcovPath,
        "--threshold",
        "85",
      ],
      {
        error: (message) => standardError.push(message),
        log: (message) => standardOutput.push(message),
      },
    )

    expect(exitCode).toBe(0)
    expect(standardError).toEqual([])
    expect(standardOutput.at(-1)).toBe(
      "Diff coverage: 100.00% (1/1 changed instrumented lines; required 85.00%)",
    )
  })

  test("returns CLI failures without terminating the caller", () => {
    const standardOutput: string[] = []
    const standardError: string[] = []
    const output = {
      error: (message: string) => standardError.push(message),
      log: (message: string) => standardOutput.push(message),
    }

    expect(runDiffCoverageCli(["--help"], output)).toBe(0)
    expect(standardOutput[0]).toContain("--base <sha>")

    expect(runDiffCoverageCli([], output)).toBe(1)
    expect(standardError).toContain(
      "ERROR: --base is required and must be an explicit merge-base SHA",
    )

    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/value.ts", 0)
    expect(
      runDiffCoverageCli(
        [
          "--base",
          fixture.base,
          "--repository",
          fixture.repository,
          "--root-lcov",
          fixture.lcovPath,
          "--desktop-lcov",
          fixture.lcovPath,
        ],
        output,
      ),
    ).toBe(1)
    expect(standardError).toContain(
      "ERROR: diff coverage 0.00% is below required 85.00%",
    )
  })

  test("JSON-escapes PR-controlled filenames in every CLI log", () => {
    const escapedPath = "src/escape\u001b[31m.ts"
    const coveredFixture = createChangedProductionFile(escapedPath)
    writeLcov(coveredFixture.lcovPath, escapedPath, 1)
    const standardOutput: string[] = []
    const standardError: string[] = []
    const output = {
      error: (message: string) => standardError.push(message),
      log: (message: string) => standardOutput.push(message),
    }

    expect(
      runDiffCoverageCli(
        [
          "--base",
          coveredFixture.base,
          "--repository",
          coveredFixture.repository,
          "--root-lcov",
          coveredFixture.lcovPath,
          "--desktop-lcov",
          coveredFixture.lcovPath,
        ],
        output,
      ),
    ).toBe(0)
    expect(standardOutput[0]).toContain(JSON.stringify(escapedPath))
    expect(standardOutput.join("")).not.toContain("\u001b")

    const newlinePath = "src/newline\nbreak.ts"
    const missingFixture = createChangedProductionFile(newlinePath)
    writeLcov(missingFixture.lcovPath, "src/other.ts", 1)
    expect(
      runDiffCoverageCli(
        [
          "--base",
          missingFixture.base,
          "--repository",
          missingFixture.repository,
          "--root-lcov",
          missingFixture.lcovPath,
          "--desktop-lcov",
          missingFixture.lcovPath,
        ],
        output,
      ),
    ).toBe(1)
    expect(standardError).toContain(
      `ERROR: changed production file is missing from coverage: ${JSON.stringify(newlinePath)}`,
    )
    expect(standardError.join("")).not.toContain(newlinePath)
  })
})
