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
import {
  createCoverageAttestation,
  type CoverageDomain,
  writeCoverageAttestation,
} from "../scripts/coverage/coverage-attestation"
import { runDiffCoverageCli } from "../scripts/check-diff-coverage"

const temporaryDirectories: string[] = []
const hostileFilenameTest = process.platform === "win32" ? test.skip : test

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

function createAddedProductionFile(
  source: string,
  productionPath = "src/value.ts",
): {
  base: string
  lcovPath: string
  repository: string
} {
  const repository = mkdtempSync(join(tmpdir(), "diff-coverage-added-"))
  temporaryDirectories.push(repository)

  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFileSync(join(repository, "README.md"), "fixture\n")
  runGit(repository, "add", "README.md")
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")

  const absoluteProductionPath = join(repository, productionPath)
  mkdirSync(dirname(absoluteProductionPath), { recursive: true })
  writeFileSync(absoluteProductionPath, source)
  runGit(repository, "--literal-pathspecs", "add", productionPath)
  runGit(repository, "commit", "--quiet", "-m", "add production file")

  return {
    base,
    lcovPath: join(repository, "root.lcov.info"),
    repository,
  }
}

function createModifiedProductionFile(
  beforeSource: string,
  afterSource: string,
  productionPath = "src/value.ts",
): {
  base: string
  lcovPath: string
  repository: string
} {
  const repository = mkdtempSync(join(tmpdir(), "diff-coverage-modified-"))
  temporaryDirectories.push(repository)
  const absoluteProductionPath = join(repository, productionPath)
  mkdirSync(dirname(absoluteProductionPath), { recursive: true })

  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFileSync(absoluteProductionPath, beforeSource)
  runGit(repository, "--literal-pathspecs", "add", productionPath)
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")

  writeFileSync(absoluteProductionPath, afterSource)
  runGit(repository, "--literal-pathspecs", "add", productionPath)
  runGit(repository, "commit", "--quiet", "-m", "change")

  return {
    base,
    lcovPath: join(repository, "root.lcov.info"),
    repository,
  }
}

function writeLcovLines(
  path: string,
  source: string,
  lines: ReadonlyArray<readonly [line: number, hits: number]>,
  domain: CoverageDomain = "root",
): void {
  writeFileSync(
    path,
    [
      "TN:",
      `SF:${source}`,
      ...lines.map(([line, hits]) => `DA:${line},${hits}`),
      `LF:${lines.length}`,
      `LH:${lines.filter(([, hits]) => hits > 0).length}`,
      "end_of_record",
      "",
    ].join("\n"),
  )
  const repository = dirname(path)
  writeCoverageAttestation(
    join(repository, "attestation.json"),
    createCoverageAttestation(repository, domain, path),
  )
}

function writeLcov(
  path: string,
  source: string,
  hits: number,
  domain: CoverageDomain = "root",
): void {
  writeLcovLines(path, source, [[1, hits]], domain)
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

function writeEmptyLcov(
  path: string,
  source: string,
  domain: CoverageDomain = "root",
): void {
  writeFileSync(
    path,
    [
      "TN:",
      `SF:${source}`,
      "end_of_record",
      "SF:tests/coverage-control.ts",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "",
    ].join("\n"),
  )
  const repository = dirname(path)
  writeCoverageAttestation(
    join(repository, "attestation.json"),
    createCoverageAttestation(repository, domain, path),
  )
}

function writeAdditionalAttestation(
  lcovPath: string,
  domain: CoverageDomain,
): string {
  const repository = dirname(lcovPath)
  const attestationPath = join(repository, `${domain}-attestation.json`)
  writeCoverageAttestation(
    attestationPath,
    createCoverageAttestation(repository, domain, lcovPath),
  )
  return attestationPath
}

describe("differential coverage gate", () => {
  test("treats release scripts as root production without widening other scripts", () => {
    expect(isProductionSource("scripts/release/quality.ts")).toBe(true)
    expect(isProductionSource("scripts/release/smoke-docker-image.mjs")).toBe(
      true,
    )
    expect(isProductionSource("scripts/check-diff-coverage.ts")).toBe(true)
    expect(isProductionSource("scripts/coverage/diff-coverage.ts")).toBe(true)
    expect(isProductionSource("scripts/lib/git.ts")).toBe(true)
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

  test("rejects an added runtime module with an empty LCOV record", () => {
    const fixture = createAddedProductionFile("export const value = 1\n")
    writeEmptyLcov(fixture.lcovPath, "src/value.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has an LCOV SF record but no instrumented DA lines: "src/value.ts"',
    )
  })

  test("admits an added runtime module with instrumented covered lines", () => {
    const fixture = createAddedProductionFile("export const value = 1\n")
    writeLcov(fixture.lcovPath, "src/value.ts", 1)

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
        file: "src/value.ts",
        instrumentedLines: 1,
        percentage: 100,
      },
    ])
  })

  test("rejects an added runtime module whose DA lines do not belong to the file", () => {
    const fixture = createAddedProductionFile("export const value = 1\n")
    writeLcovLines(fixture.lcovPath, "src/value.ts", [[999, 1]])

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has no LCOV DA lines within the current source: "src/value.ts"',
    )
    expect(result.failures).toContain(
      'whole-file production target has no instrumented changed lines: "src/value.ts"',
    )
  })

  test("rejects an added mixed type and runtime module with an empty LCOV record", () => {
    const fixture = createAddedProductionFile(
      [
        "export interface FixtureType { value: string }",
        "export const value: FixtureType = { value: 'runtime' }",
        "",
      ].join("\n"),
      "src/mixed-types.ts",
    )
    writeEmptyLcov(fixture.lcovPath, "src/mixed-types.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has an LCOV SF record but no instrumented DA lines: "src/mixed-types.ts"',
    )
  })

  test("does not admit an import-only TypeScript module through an empty LCOV record", () => {
    const fixture = createAddedProductionFile(
      'import "./runtime-side-effect"\n',
      "src/import-only.ts",
    )
    writeEmptyLcov(fixture.lcovPath, "src/import-only.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has an LCOV SF record but no instrumented DA lines: "src/import-only.ts"',
    )
  })

  test("rejects a modified executable module with an empty LCOV record", () => {
    const fixture = createChangedProductionFile()
    writeEmptyLcov(fixture.lcovPath, "src/value.ts")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has an LCOV SF record but no instrumented DA lines: "src/value.ts"',
    )
  })

  test("allows a non-instrumented changed line when the file has valid instrumentation", () => {
    const productionPath = "src/value.ts"
    const fixture = createModifiedProductionFile(
      "export const value = 1\nexport type Label = string\n",
      "export const value = 1\nexport type Label = string | number\n",
    )
    writeLcov(fixture.lcovPath, productionPath, 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([
      {
        coveredLines: 0,
        file: productionPath,
        instrumentedLines: 0,
        percentage: 100,
      },
    ])
  })

  test("does not charge a type-only hunk beside a covered runtime edit", () => {
    const fixture = createModifiedProductionFile(
      [
        "export function identity(value: string) { return value }",
        "export const runtimeValue = 1",
        "",
      ].join("\n"),
      [
        "export function identity(value: string | number) { return value }",
        "export const runtimeValue = 2",
        "",
      ].join("\n"),
    )
    writeLcovLines(fixture.lcovPath, "src/value.ts", [[2, 1]])

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
        file: "src/value.ts",
        instrumentedLines: 1,
        percentage: 100,
      },
    ])
  })

  test("does not treat normalized runtime syntax as a type-only edit", () => {
    const fixture = createModifiedProductionFile(
      "export const value = Math.max(1,)\n",
      "export const value = Math.max(1)\n",
    )
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

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
        file: "src/value.ts",
        instrumentedLines: 1,
        percentage: 0,
      },
    ])
  })

  test("charges a Desktop parameter property as emitted runtime", () => {
    const productionPath = "desktop/src/value.ts"
    const fixture = createModifiedProductionFile(
      "export class Fixture { constructor(value: number) {} }\n",
      "export class Fixture { constructor(public value: number) {} }\n",
      productionPath,
    )
    writeLcov(fixture.lcovPath, productionPath, 0, "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.instrumentedLines).toBe(1)
    expect(result.percentage).toBe(0)
  })

  test("charges class members whose erased modifiers change runtime emission", () => {
    const cases = [
      [
        "export class Fixture { declare value: number }\n",
        "export class Fixture { value: number }\n",
      ],
      [
        "export abstract class Fixture { abstract value: number }\n",
        "export class Fixture { value: number }\n",
      ],
      [
        "export class Fixture { declare static value: number }\n",
        "export class Fixture { static value: number }\n",
      ],
      [
        "export abstract class Fixture { abstract accessor value: number }\n",
        "export class Fixture { accessor value: number }\n",
      ],
    ] as const

    for (const [before, after] of cases) {
      const productionPath = "desktop/src/value.ts"
      const fixture = createModifiedProductionFile(
        before,
        after,
        productionPath,
      )
      writeLcov(fixture.lcovPath, productionPath, 0, "desktop")

      const result = checkDiffCoverage({
        base: fixture.base,
        coverage: [
          {
            domain: "desktop",
            path: fixture.lcovPath,
            sourcePrefix: ".",
          },
        ],
        repository: fixture.repository,
        threshold: 85,
      })

      expect(result.passed).toBe(false)
      expect(result.instrumentedLines).toBe(1)
      expect(result.percentage).toBe(0)
    }
  })

  test("keeps added type annotations neutral when runtime tokens are unchanged", () => {
    const fixture = createModifiedProductionFile(
      "export const value = 1\n",
      "export const value: number = 1\n",
    )
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("keeps a runtime-to-type line neutral beside retained runtime", () => {
    const fixture = createModifiedProductionFile(
      "export const removed = 1\nexport const retained = 1\n",
      "export type Removed = number\nexport const retained = 1\n",
    )
    writeLcovLines(fixture.lcovPath, "src/value.ts", [
      [1, 0],
      [2, 1],
    ])

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("keeps comment-only edits neutral when runtime tokens are unchanged", () => {
    const fixture = createModifiedProductionFile(
      "export const value = 1\n",
      "// explanation\nexport const value = 1\n",
    )
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("charges tooling directive comments as runtime-significant edits", () => {
    const fixture = createModifiedProductionFile(
      'export const load = () => import("./module")\n',
      'export const load = () => import(/* @vite-ignore */ "./module")\n',
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

  test("keeps inline type-only import and export specifiers neutral", () => {
    for (const [before, after] of [
      [
        'import { value } from "./dependency"',
        'import { type Value, value } from "./dependency"',
      ],
      [
        'import { value } from "./dependency"',
        'import { value, type Value } from "./dependency"',
      ],
      [
        'export { value } from "./dependency"',
        'export { type Value, value } from "./dependency"',
      ],
    ] as const) {
      const fixture = createModifiedProductionFile(
        `${before}\nexport const result = 1\n`,
        `${after}\nexport const result = 1\n`,
      )
      writeLcovLines(fixture.lcovPath, "src/value.ts", [
        [1, 0],
        [2, 1],
      ])

      const result = checkDiffCoverage({
        base: fixture.base,
        coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
        repository: fixture.repository,
        threshold: 85,
      })

      expect(result.passed).toBe(true)
      expect(result.files[0]?.instrumentedLines).toBe(0)
    }
  })

  test("keeps a sole Desktop inline type import neutral", () => {
    const productionPath = "desktop/src/value.ts"
    const fixture = createModifiedProductionFile(
      "export const runtime = 1\nexport type Local = string\n",
      [
        'import { type Value } from "./dependency"',
        "export const runtime = 1",
        "export type Local = Value",
        "",
      ].join("\n"),
      productionPath,
    )
    writeLcovLines(
      fixture.lcovPath,
      productionPath,
      [
        [1, 0],
        [2, 1],
      ],
      "desktop",
    )

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("keeps ordinary JSDoc edits neutral", () => {
    const fixture = createModifiedProductionFile(
      "export function identity(value: string) { return value }\n",
      [
        "/** @param value explanatory prose */",
        "export function identity(value: string) { return value }",
        "",
      ].join("\n"),
    )
    writeLcov(fixture.lcovPath, "src/value.ts", 0)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("keeps a type-only namespace neutral", () => {
    const fixture = createModifiedProductionFile(
      "export const retained = 1\n",
      [
        "namespace Types { export interface Value {} }",
        "export const retained = 1",
        "",
      ].join("\n"),
    )
    writeLcovLines(fixture.lcovPath, "src/value.ts", [
      [1, 0],
      [2, 1],
    ])

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("rejects a type-only edit when every DA line is outside the current source", () => {
    const fixture = createModifiedProductionFile(
      "export const value = 1\nexport type Label = string\n",
      "export const value = 1\nexport type Label = string | number\n",
    )
    writeLcovLines(fixture.lcovPath, "src/value.ts", [[999, 1]])

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production file has no LCOV DA lines within the current source: "src/value.ts"',
    )
    expect(result.failures).not.toContain(
      'runtime-emitting production change has no instrumented changed lines: "src/value.ts"',
    )
  })

  test("rejects an added declaration-only ordinary TypeScript module even with DA", () => {
    const fixture = createAddedProductionFile(
      "export interface FixtureType { value: string }\n",
      "src/types.ts",
    )
    writeLcov(fixture.lcovPath, "src/types.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      'changed production source emits no runtime; use a declaration file: "src/types.ts"',
    )
  })

  test("excludes an added declaration file without requiring an LCOV record", () => {
    const fixture = createAddedProductionFile(
      "export interface FixtureType { value: string }\n",
      "src/types.d.ts",
    )
    writeLcov(fixture.lcovPath, "src/other.ts", 1)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([])
    expect(result.failures).toEqual([])
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
    writeLcov(fixture.lcovPath, "electron/server-manager.ts", 1, "desktop")

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

  test("does not let a root-attested LCOV record cover Desktop production", () => {
    const productionPath = "desktop/electron/server-manager.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, productionPath, 1, "root")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "root",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `changed production file is missing from coverage: ${JSON.stringify(productionPath)}`,
    )
  })

  test("does not let a Desktop-attested LCOV record cover root release production", () => {
    const productionPath = "scripts/release/publish-artifact.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, `../${productionPath}`, 1, "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: "desktop",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `changed production file is missing from coverage: ${JSON.stringify(productionPath)}`,
    )
  })

  test("does not merge duplicate production SF records across coverage domains", () => {
    const productionPath = "desktop/electron/server-manager.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, productionPath, 1, "root")
    const rootAttestation = writeAdditionalAttestation(fixture.lcovPath, "root")
    const desktopLcov = join(fixture.repository, "desktop.lcov.info")
    writeLcov(desktopLcov, "electron/server-manager.ts", 0, "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          attestationPath: rootAttestation,
          domain: "root",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
        {
          domain: "desktop",
          path: desktopLcov,
          sourcePrefix: "desktop",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.coveredLines).toBe(0)
    expect(result.instrumentedLines).toBe(1)
    expect(result.failures).toContain(
      "diff coverage 0.00% is below required 85.00%",
    )
  })

  hostileFilenameTest(
    "cannot bypass changed-line coverage with non-ASCII control characters in a path",
    () => {
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
    },
  )

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

  hostileFilenameTest(
    "counts only edited lines when a production file is renamed",
    () => {
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
      writeLcovLines(fixture.lcovPath, newPath, [
        [1, 0],
        [2, 1],
        [3, 0],
      ])

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
    },
  )

  test("allows a type-only edit across a history-preserving production rename", () => {
    const oldPath = "src/old-value.ts"
    const newPath = "src/new-value.ts"
    const fixture = createFileTransition(
      oldPath,
      newPath,
      [
        "export const value = 1",
        "export const other = 2",
        "export type Label = string",
      ],
      [
        "export const value = 1",
        "export const other = 2",
        "export type Label = string | number",
      ],
    )
    writeLcovLines(fixture.lcovPath, newPath, [
      [1, 1],
      [2, 1],
    ])

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.files).toEqual([
      {
        coveredLines: 0,
        file: newPath,
        instrumentedLines: 0,
        percentage: 100,
      },
    ])
  })

  test("admits twenty thousand covered changed lines without anchor cross-products", () => {
    const beforeLines: string[] = []
    const afterLines: string[] = []
    const coverageLines: Array<readonly [number, number]> = []
    for (let index = 0; index < 20_000; index += 1) {
      beforeLines.push(`export const value${index} = 0`)
      afterLines.push(`export const value${index} = 1`)
      coverageLines.push([index + 1, 1])
    }
    const fixture = createModifiedProductionFile(
      `${beforeLines.join("\n")}\n`,
      `${afterLines.join("\n")}\n`,
    )
    writeLcovLines(fixture.lcovPath, "src/value.ts", coverageLines)

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [{ path: fixture.lcovPath, sourcePrefix: "." }],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.coveredLines).toBe(20_000)
    expect(result.instrumentedLines).toBe(20_000)
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
    writeLcovLines(fixture.lcovPath, newPath, [[999, 1]])

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
    writeLcovLines(fixture.lcovPath, "src/helper.ts", [[999, 1]])

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
    writeEmptyLcov(fixture.lcovPath, "desktop/src/helper.ts", "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
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
    writeEmptyLcov(fixture.lcovPath, "desktop/src/helper.ts", "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
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
    expect(isProductionSource("shared-types/token-usage.ts")).toBe(true)
    expect(isProductionSource("desktop/src/App.tsx")).toBe(true)
    expect(isProductionSource("src/protocol.d.ts")).toBe(false)
    expect(isProductionSource("src/protocol.generated.ts")).toBe(false)
    expect(isProductionSource("src/generated/protocol.ts")).toBe(false)
  })

  test("assigns shared runtime sources to the root coverage domain", () => {
    const productionPath = "shared-types/runtime-values.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, productionPath, 1, "root")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "root",
          path: fixture.lcovPath,
          sourcePrefix: ".",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.coveredLines).toBe(1)
    expect(result.instrumentedLines).toBe(1)
  })

  test("does not let Desktop coverage vouch for shared runtime sources", () => {
    const productionPath = "shared-types/runtime-values.ts"
    const fixture = createChangedProductionFile(productionPath)
    writeLcov(fixture.lcovPath, `../${productionPath}`, 1, "desktop")

    const result = checkDiffCoverage({
      base: fixture.base,
      coverage: [
        {
          domain: "desktop",
          path: fixture.lcovPath,
          sourcePrefix: "desktop",
        },
      ],
      repository: fixture.repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `changed production file is missing from coverage: ${JSON.stringify(productionPath)}`,
    )
  })

  test("exposes the stable CLI contract with explicit coverage inputs", () => {
    const fixture = createChangedProductionFile()
    writeLcov(fixture.lcovPath, "src/value.ts", 1)
    const desktopAttestation = writeAdditionalAttestation(
      fixture.lcovPath,
      "desktop",
    )
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
        "--root-attestation",
        join(fixture.repository, "attestation.json"),
        "--desktop-lcov",
        fixture.lcovPath,
        "--desktop-attestation",
        desktopAttestation,
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
      "Diff coverage: 100.00% (1/1 changed runtime lines; required 85.00%)",
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
    const desktopAttestation = writeAdditionalAttestation(
      fixture.lcovPath,
      "desktop",
    )
    expect(
      runDiffCoverageCli(
        [
          "--base",
          fixture.base,
          "--repository",
          fixture.repository,
          "--root-lcov",
          fixture.lcovPath,
          "--root-attestation",
          join(fixture.repository, "attestation.json"),
          "--desktop-lcov",
          fixture.lcovPath,
          "--desktop-attestation",
          desktopAttestation,
        ],
        output,
      ),
    ).toBe(1)
    expect(standardError).toContain(
      "ERROR: diff coverage 0.00% is below required 85.00%",
    )
  })

  hostileFilenameTest(
    "JSON-escapes PR-controlled filenames in every CLI log",
    () => {
      const escapedPath = "src/escape\u001b[31m.ts"
      const coveredFixture = createChangedProductionFile(escapedPath)
      writeLcov(coveredFixture.lcovPath, escapedPath, 1)
      const coveredDesktopAttestation = writeAdditionalAttestation(
        coveredFixture.lcovPath,
        "desktop",
      )
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
            "--root-attestation",
            join(coveredFixture.repository, "attestation.json"),
            "--desktop-lcov",
            coveredFixture.lcovPath,
            "--desktop-attestation",
            coveredDesktopAttestation,
          ],
          output,
        ),
      ).toBe(0)
      expect(standardOutput[0]).toContain(JSON.stringify(escapedPath))
      expect(standardOutput.join("")).not.toContain("\u001b")

      const newlinePath = "src/newline\nbreak.ts"
      const missingFixture = createChangedProductionFile(newlinePath)
      writeLcov(missingFixture.lcovPath, "src/other.ts", 1)
      const missingDesktopAttestation = writeAdditionalAttestation(
        missingFixture.lcovPath,
        "desktop",
      )
      expect(
        runDiffCoverageCli(
          [
            "--base",
            missingFixture.base,
            "--repository",
            missingFixture.repository,
            "--root-lcov",
            missingFixture.lcovPath,
            "--root-attestation",
            join(missingFixture.repository, "attestation.json"),
            "--desktop-lcov",
            missingFixture.lcovPath,
            "--desktop-attestation",
            missingDesktopAttestation,
          ],
          output,
        ),
      ).toBe(1)
      expect(standardError).toContain(
        `ERROR: changed production file is missing from coverage: ${JSON.stringify(newlinePath)}`,
      )
      expect(standardError.join("")).not.toContain(newlinePath)
    },
  )
})
