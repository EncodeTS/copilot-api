import { afterEach, describe, expect, test } from "bun:test"
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { spawnSync } from "node:child_process"

import { checkDiffCoverage } from "../scripts/coverage/diff-coverage"
import {
  COVERAGE_ARTIFACT_INVALIDATION_MARKER,
  createCoverageAttestation,
  invalidateCoverageArtifactSafely,
  readVerifiedCoverageArtifact,
} from "../scripts/coverage/coverage-attestation"
import {
  type CoverageRunnerHooks,
  runCoverageCli,
} from "../scripts/coverage/run-coverage"

const temporaryDirectories: string[] = []
const symlinkTest = process.platform === "win32" ? test.skip : test
const coverageRunner = join(
  import.meta.dir,
  "../scripts/coverage/run-coverage.ts",
)

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

function writeFixtureFile(
  repository: string,
  path: string,
  contents: string,
): void {
  const absolutePath = join(repository, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, contents)
}

function createCoverageRepository(
  source: string,
  testSource: string,
): { base: string; repository: string } {
  const repository = mkdtempSync(join(tmpdir(), "coverage-attestation-"))
  temporaryDirectories.push(repository)
  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFixtureFile(repository, "README.md", "coverage fixture\n")
  runGit(repository, "add", "README.md")
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")
  writeFixtureFile(repository, "src/value.ts", source)
  writeFixtureFile(repository, "tests/value.test.ts", testSource)
  runGit(repository, "add", "src/value.ts", "tests/value.test.ts")
  runGit(repository, "commit", "--quiet", "-m", "fixture")
  return { base, repository }
}

function createDesktopBoundaryCoverageRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "coverage-attestation-"))
  temporaryDirectories.push(repository)
  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFixtureFile(
    repository,
    "desktop/electron/main.ts",
    "export const mainValue = (): number => 1\n",
  )
  writeFixtureFile(
    repository,
    "desktop/electron/preload.ts",
    "export const boundaryValue = (): number => 2\n",
  )
  writeFixtureFile(
    repository,
    "desktop/electron/not-allowlisted.ts",
    "export const excludedBoundaryValue = (): number => 3\n",
  )
  writeFixtureFile(
    repository,
    "desktop/tests/main.test.ts",
    [
      'import { expect, test } from "bun:test"',
      'import { mainValue } from "../electron/main"',
      'test("covers main", () => expect(mainValue()).toBe(1))',
      "",
    ].join("\n"),
  )
  writeFixtureFile(
    repository,
    "desktop/tests/desktop-shared-boundaries.probe.ts",
    [
      'import { expect, test } from "bun:test"',
      'import { boundaryValue } from "../electron/preload"',
      'import { excludedBoundaryValue } from "../electron/not-allowlisted"',
      'test("covers isolated boundaries", () => {',
      "  expect(boundaryValue()).toBe(2)",
      "  expect(excludedBoundaryValue()).toBe(3)",
      "})",
      "",
    ].join("\n"),
  )
  runGit(repository, "add", "desktop")
  runGit(repository, "commit", "--quiet", "-m", "desktop fixture")
  return repository
}

function createModifiedCoverageRepository(
  beforeSource: string,
  afterSource: string,
  testSource: string,
  additionalFiles: Readonly<Record<string, string>> = {},
): { base: string; repository: string } {
  const repository = mkdtempSync(join(tmpdir(), "coverage-attestation-"))
  temporaryDirectories.push(repository)
  runGit(repository, "init", "--quiet")
  runGit(repository, "config", "user.email", "coverage@example.invalid")
  runGit(repository, "config", "user.name", "Coverage Test")
  writeFixtureFile(repository, "src/value.ts", beforeSource)
  writeFixtureFile(repository, "tests/value.test.ts", testSource)
  for (const [path, contents] of Object.entries(additionalFiles)) {
    writeFixtureFile(repository, path, contents)
  }
  runGit(
    repository,
    "add",
    "src/value.ts",
    "tests/value.test.ts",
    ...Object.keys(additionalFiles),
  )
  runGit(repository, "commit", "--quiet", "-m", "base")
  const base = runGit(repository, "rev-parse", "HEAD")
  writeFixtureFile(repository, "src/value.ts", afterSource)
  runGit(repository, "add", "src/value.ts")
  runGit(repository, "commit", "--quiet", "-m", "change")
  return { base, repository }
}

function runRootCoverage(repository: string): void {
  expect(runCoverageCli(["--domain", "root", "--repository", repository])).toBe(
    0,
  )
}

function runCoverageWithSuppressedError(
  arguments_: string[],
  hooks?: CoverageRunnerHooks,
): number {
  const originalError = console.error
  console.error = () => {}
  try {
    return runCoverageCli(arguments_, hooks)
  } finally {
    console.error = originalError
  }
}

function checkRootCoverage(base: string, repository: string) {
  return checkDiffCoverage({
    base,
    coverage: [
      {
        path: join(repository, "coverage/root/lcov.info"),
        sourcePrefix: ".",
      },
    ],
    repository,
    threshold: 85,
  })
}

function rewriteRootAttestation(
  repository: string,
  update: (attestation: Record<string, unknown>) => void,
): void {
  const path = join(repository, "coverage/root/attestation.json")
  const attestation = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >
  update(attestation)
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`)
}

function expectRootAttestationInvalidated(repository: string): void {
  const path = join(repository, "coverage/root/attestation.json")
  if (!existsSync(path)) return
  expect(readFileSync(path, "utf8")).toBe(COVERAGE_ARTIFACT_INVALIDATION_MARKER)
}

describe("coverage attestation", () => {
  test("merges only allowlisted isolated Desktop coverage before attestation", () => {
    const repository = createDesktopBoundaryCoverageRepository()
    let inspectedBeforeAttestation = false

    const result = runCoverageCli(
      ["--domain", "desktop", "--repository", repository],
      {
        beforeAttestation: ({ attestationPath, lcovPath }) => {
          inspectedBeforeAttestation = true
          expect(existsSync(attestationPath)).toBe(false)
          const merged = readFileSync(lcovPath, "utf8")
          expect(merged).toContain("SF:electron/main.ts")
          expect(merged).toContain("SF:electron/preload.ts")
          expect(merged).not.toContain("SF:electron/not-allowlisted.ts")
        },
      },
    )

    expect(result).toBe(0)
    expect(inspectedBeforeAttestation).toBe(true)
    const rawBoundaryCoverage = readFileSync(
      join(repository, "coverage/desktop-boundary/lcov.info"),
      "utf8",
    )
    expect(rawBoundaryCoverage.replaceAll(sep, "/")).toContain(
      "SF:electron/not-allowlisted.ts",
    )
    expect(
      readVerifiedCoverageArtifact(
        repository,
        "desktop",
        join(repository, "coverage/desktop/lcov.info"),
        join(repository, "coverage/desktop/attestation.json"),
      ).ok,
    ).toBe(true)
  })

  test("runs real Bun coverage and records a fresh root attestation", () => {
    const { repository } = createCoverageRepository(
      [
        "export function choose(value: number): string {",
        "  switch (value) {",
        '    case 1: return "one"',
        '    default: return "other"',
        "  }",
        "}",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { choose } from "../src/value"',
        'test("covers switch", () => {',
        '  expect(choose(1)).toBe("one")',
        '  expect(choose(2)).toBe("other")',
        "})",
        "",
      ].join("\n"),
    )

    runRootCoverage(repository)
    expect(existsSync(join(repository, "coverage/root/lcov.info"))).toBe(true)
    expect(existsSync(join(repository, "coverage/root/attestation.json"))).toBe(
      true,
    )
    const attestation = JSON.parse(
      readFileSync(join(repository, "coverage/root/attestation.json"), "utf8"),
    ) as Record<string, unknown>
    expect(attestation).toMatchObject({
      bunVersion: Bun.version,
      commit: runGit(repository, "rev-parse", "HEAD"),
      domain: "root",
      lcovPath: "coverage/root/lcov.info",
      schema: "copilot-api-coverage-attestation-v1",
      sourceTree: runGit(repository, "rev-parse", "HEAD^{tree}"),
    })
    expect(attestation.lcovSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("refuses to attest uncommitted production sources", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    writeFixtureFile(repository, "src/value.ts", "export const value = 2\n")

    const result = spawnSync(
      process.execPath,
      [coverageRunner, "--domain", "root", "--repository", repository],
      { encoding: "utf8" },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "root production sources must be committed before coverage generation",
    )
  })

  test("refuses to attest a dirty LCOV merge helper", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    writeFixtureFile(
      repository,
      "scripts/coverage/merge-lcov.ts",
      "export const merge = 1\n",
    )
    runGit(repository, "add", "scripts/coverage/merge-lcov.ts")
    runGit(repository, "commit", "--quiet", "-m", "add merge helper")
    writeFixtureFile(
      repository,
      "scripts/coverage/merge-lcov.ts",
      "export const merge = 2\n",
    )

    const result = spawnSync(
      process.execPath,
      [coverageRunner, "--domain", "root", "--repository", repository],
      { encoding: "utf8" },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "root production sources must be committed before coverage generation",
    )
  })

  test("treats shared runtime sources as root production for cleanliness", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    writeFixtureFile(
      repository,
      "shared-types/runtime-values.ts",
      "export const values = ['one'] as const\n",
    )

    expect(
      runCoverageWithSuppressedError([
        "--domain",
        "root",
        "--repository",
        repository,
      ]),
    ).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("invalidates root attestation when the coverage checker is dirty", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    writeFixtureFile(
      repository,
      "scripts/check-diff-coverage.ts",
      "export const dirtyChecker = true\n",
    )

    expect(
      runCoverageWithSuppressedError([
        "--domain",
        "root",
        "--repository",
        repository,
      ]),
    ).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("rejects an invalid domain through the public runner", () => {
    expect(runCoverageWithSuppressedError(["--domain", "invalid"])).toBe(1)
  })

  test("rejects a non-directory coverage output path", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    mkdirSync(join(repository, "coverage"), { recursive: true })
    writeFileSync(join(repository, "coverage/root"), "not a directory\n")

    expect(
      runCoverageWithSuppressedError([
        "--domain",
        "root",
        "--repository",
        repository,
      ]),
    ).toBe(1)
  })

  test("rejects a non-file attestation artifact", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    mkdirSync(join(repository, "coverage/root/attestation.json"), {
      recursive: true,
    })

    expect(
      runCoverageWithSuppressedError([
        "--domain",
        "root",
        "--repository",
        repository,
      ]),
    ).toBe(1)
  })

  test("invalidates the old attestation when the child test run fails", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    writeFixtureFile(
      repository,
      "tests/value.test.ts",
      [
        'import { expect, test } from "bun:test"',
        'test("fails", () => expect(1).toBe(2))',
        "",
      ].join("\n"),
    )

    expect(
      runCoverageCli(["--domain", "root", "--repository", repository]),
    ).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("invalidates generated artifacts when HEAD changes during coverage", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'test("advances HEAD", () => {',
        '  const result = Bun.spawnSync(["git", "commit", "--allow-empty", "--quiet", "-m", "advance during coverage"])',
        "  expect(result.exitCode).toBe(0)",
        "})",
        "",
      ].join("\n"),
    )

    expect(
      runCoverageWithSuppressedError([
        "--domain",
        "root",
        "--repository",
        repository,
      ]),
    ).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("removes attestation when production changes after self-verification", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )

    const result = runCoverageWithSuppressedError(
      ["--domain", "root", "--repository", repository],
      {
        afterVerification: () => {
          writeFixtureFile(
            repository,
            "src/value.ts",
            "export const value = 2\n",
          )
        },
      },
    )

    expect(result).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("fails closed when a successful child produces no LCOV", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = runCoverageWithSuppressedError(
      ["--domain", "root", "--repository", repository],
      {
        afterTestRun: ({ lcovPath }) => rmSync(lcovPath),
      },
    )

    expect(result).toBe(1)
    expect(existsSync(join(repository, "coverage/root/lcov.info"))).toBe(false)
    expectRootAttestationInvalidated(repository)
  })

  test("validates SF and DA on the snapshot used for attestation", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )

    const result = runCoverageWithSuppressedError(
      ["--domain", "root", "--repository", repository],
      {
        beforeAttestation: ({ lcovPath }) => writeFileSync(lcovPath, "TN:\n"),
      },
    )

    expect(result).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  test("accepts a fully covered switch from real Bun LCOV", () => {
    const { base, repository } = createCoverageRepository(
      [
        "export function choose(value: number): string {",
        "  switch (value) {",
        '    case 1: return "one"',
        '    default: return "other"',
        "  }",
        "}",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { choose } from "../src/value"',
        'test("covers switch", () => {',
        '  expect(choose(1)).toBe("one")',
        '  expect(choose(2)).toBe("other")',
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkDiffCoverage({
      base,
      coverage: [
        {
          path: join(repository, "coverage/root/lcov.info"),
          sourcePrefix: ".",
        },
      ],
      repository,
      threshold: 85,
    })

    expect(result.passed).toBe(true)
    expect(result.percentage).toBe(100)
  })

  test("rejects LCOV changed after attestation generation", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const lcovPath = join(repository, "coverage/root/lcov.info")
    appendFileSync(lcovPath, "# tampered\n")

    const result = checkDiffCoverage({
      base,
      coverage: [{ path: lcovPath, sourcePrefix: "." }],
      repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation LCOV hash mismatch: ${JSON.stringify(lcovPath)}`,
    )
  })

  test("rejects a missing same-run attestation", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const attestationPath = join(repository, "coverage/root/attestation.json")
    rmSync(attestationPath)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation file does not exist: ${JSON.stringify(attestationPath)}`,
    )
  })

  test("rejects coverage after the attested HEAD advances", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    writeFixtureFile(repository, "README.md", "HEAD advanced\n")
    runGit(repository, "add", "README.md")
    runGit(repository, "commit", "--quiet", "-m", "advance")

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation commit mismatch: ${JSON.stringify(
        join(repository, "coverage/root/attestation.json"),
      )}`,
    )
  })

  test("creates an attestation from the runner's captured commit", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const capturedCommit = runGit(repository, "rev-parse", "HEAD")
    const capturedTree = runGit(repository, "rev-parse", "HEAD^{tree}")
    writeFixtureFile(repository, "README.md", "HEAD advanced\n")
    runGit(repository, "add", "README.md")
    runGit(repository, "commit", "--quiet", "-m", "advance")

    const attestation = createCoverageAttestation(
      repository,
      "root",
      join(repository, "coverage/root/lcov.info"),
      capturedCommit,
    )

    expect(attestation.commit).toBe(capturedCommit)
    expect(attestation.sourceTree).toBe(capturedTree)
    expect(attestation.commit).not.toBe(runGit(repository, "rev-parse", "HEAD"))
    const verified = readVerifiedCoverageArtifact(
      repository,
      "root",
      join(repository, "coverage/root/lcov.info"),
      join(repository, "coverage/root/attestation.json"),
      capturedCommit,
    )
    expect(verified.ok).toBe(true)
  })

  test("returns the exact verified LCOV byte snapshot used for hashing", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const lcovPath = join(repository, "coverage/root/lcov.info")
    const result = readVerifiedCoverageArtifact(
      repository,
      "root",
      lcovPath,
      join(repository, "coverage/root/attestation.json"),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.failure)

    appendFileSync(lcovPath, "# replaced after verification\n")

    expect(result.lcov).not.toContain("replaced after verification")
  })

  test("rejects a regular-file replacement between validation and open", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const lcovPath = join(repository, "coverage/root/lcov.info")
    const originalPath = join(repository, "coverage/root/lcov-original.info")
    let replaced = false

    const result = readVerifiedCoverageArtifact(
      repository,
      "root",
      lcovPath,
      join(repository, "coverage/root/attestation.json"),
      runGit(repository, "rev-parse", "HEAD"),
      {
        beforeOpen: ({ label, path }) => {
          if (replaced || label !== "coverage LCOV path") return
          replaced = true
          renameSync(path, originalPath)
          copyFileSync(originalPath, path)
        },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("replacement was not rejected")
    expect(result.failure).toContain("changed between path validation and open")
  })

  test("rejects an ancestor replacement even when files keep their inodes", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const coverageDirectory = join(repository, "coverage/root")
    const originalDirectory = join(repository, "coverage/root-original")
    let replaced = false

    const result = readVerifiedCoverageArtifact(
      repository,
      "root",
      join(coverageDirectory, "lcov.info"),
      join(coverageDirectory, "attestation.json"),
      runGit(repository, "rev-parse", "HEAD"),
      {
        beforeOpen: ({ label }) => {
          if (replaced || label !== "coverage LCOV path") return
          replaced = true
          renameSync(coverageDirectory, originalDirectory)
          mkdirSync(coverageDirectory)
          linkSync(
            join(originalDirectory, "lcov.info"),
            join(coverageDirectory, "lcov.info"),
          )
          linkSync(
            join(originalDirectory, "attestation.json"),
            join(coverageDirectory, "attestation.json"),
          )
        },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("ancestor replacement was not rejected")
    expect(result.failure).toContain("path identity changed while being read")
  })

  test("rejects a tampered attested source tree", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    rewriteRootAttestation(repository, (attestation) => {
      attestation.sourceTree = "0".repeat(40)
    })

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation source tree mismatch: ${JSON.stringify(
        join(repository, "coverage/root/attestation.json"),
      )}`,
    )
  })

  test("rejects an attestation for another coverage domain", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    rewriteRootAttestation(repository, (attestation) => {
      attestation.domain = "desktop"
    })

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation domain mismatch: ${JSON.stringify(
        join(repository, "coverage/root/attestation.json"),
      )}`,
    )
  })

  test("rejects an attestation from another Bun runtime", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    rewriteRootAttestation(repository, (attestation) => {
      attestation.bunVersion = "0.0.0-stale"
    })

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation Bun version mismatch: ${JSON.stringify(
        join(repository, "coverage/root/attestation.json"),
      )}`,
    )
  })

  test("binds the attestation to the repository-relative LCOV path", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const relocatedLcovPath = join(repository, "coverage/root/relocated.info")
    copyFileSync(join(repository, "coverage/root/lcov.info"), relocatedLcovPath)

    const result = checkDiffCoverage({
      base,
      coverage: [{ path: relocatedLcovPath, sourcePrefix: "." }],
      repository,
      threshold: 85,
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation LCOV path mismatch: ${JSON.stringify(relocatedLcovPath)}`,
    )
  })

  test("rejects verification when production sources become dirty", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    writeFixtureFile(repository, "src/value.ts", "export const value = 2\n")

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      "root production sources must be committed before coverage verification",
    )
  })

  test("invalidates the old attestation before a failed coverage run", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    writeFixtureFile(repository, "src/value.ts", "export const value = 2\n")

    const result = spawnSync(
      process.execPath,
      [coverageRunner, "--domain", "root", "--repository", repository],
      { encoding: "utf8" },
    )

    expect(result.status).toBe(1)
    expectRootAttestationInvalidated(repository)
  })

  symlinkTest("rejects an LCOV symlink even when its bytes still match", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const lcovPath = join(repository, "coverage/root/lcov.info")
    const targetPath = join(repository, "coverage/root/lcov-real.info")
    renameSync(lcovPath, targetPath)
    symlinkSync(targetPath, lcovPath)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage LCOV path must not contain symbolic links: ${JSON.stringify(lcovPath)}`,
    )
  })

  symlinkTest("rejects an attestation symlink", () => {
    const { base, repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)
    const attestationPath = join(repository, "coverage/root/attestation.json")
    const targetPath = join(repository, "coverage/root/attestation-real.json")
    renameSync(attestationPath, targetPath)
    symlinkSync(targetPath, attestationPath)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.failures).toContain(
      `coverage attestation path must not contain symbolic links: ${JSON.stringify(attestationPath)}`,
    )
  })

  symlinkTest("refuses a symlinked coverage output directory", () => {
    const { repository } = createCoverageRepository(
      "export const value = 1\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(1))',
        "",
      ].join("\n"),
    )
    const outsideDirectory = mkdtempSync(
      join(tmpdir(), "coverage-attestation-outside-"),
    )
    temporaryDirectories.push(outsideDirectory)
    mkdirSync(join(repository, "coverage"), { recursive: true })
    symlinkSync(outsideDirectory, join(repository, "coverage/root"), "dir")

    const result = spawnSync(
      process.execPath,
      [coverageRunner, "--domain", "root", "--repository", repository],
      { encoding: "utf8" },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "coverage output directory must not contain symbolic links",
    )
    expect(existsSync(join(outsideDirectory, "attestation.json"))).toBe(false)
  })

  symlinkTest(
    "never cleans root attestation through a replaced parent symlink",
    () => {
      for (const targetKind of ["desktop", "outside"] as const) {
        const { repository } = createCoverageRepository(
          "export const value = 1\n",
          [
            'import { expect, test } from "bun:test"',
            'import { value } from "../src/value"',
            'test("covers value", () => expect(value).toBe(1))',
            "",
          ].join("\n"),
        )
        const targetDirectory =
          targetKind === "desktop" ?
            join(repository, "coverage/desktop")
          : mkdtempSync(join(tmpdir(), "coverage-cleanup-outside-"))
        if (targetKind === "outside") temporaryDirectories.push(targetDirectory)
        mkdirSync(targetDirectory, { recursive: true })
        const sentinelPath = join(targetDirectory, "attestation.json")
        writeFileSync(sentinelPath, `${targetKind} sentinel\n`)
        const rootDirectory = join(repository, "coverage/root")
        const retiredRoot = join(repository, "coverage/root-retired")

        const result = runCoverageWithSuppressedError(
          ["--domain", "root", "--repository", repository],
          {
            afterVerification: () => {
              renameSync(rootDirectory, retiredRoot)
              symlinkSync(targetDirectory, rootDirectory, "dir")
              writeFixtureFile(
                repository,
                "src/value.ts",
                "export const value = 2\n",
              )
            },
          },
        )

        expect(result).toBe(1)
        expect(readFileSync(sentinelPath, "utf8")).toBe(
          `${targetKind} sentinel\n`,
        )
      }
    },
  )

  symlinkTest(
    "invalidates the held file when its parent changes at the final boundary",
    () => {
      const { repository } = createCoverageRepository(
        "export const value = 1\n",
        [
          'import { expect, test } from "bun:test"',
          'import { value } from "../src/value"',
          'test("covers value", () => expect(value).toBe(1))',
          "",
        ].join("\n"),
      )
      runRootCoverage(repository)
      const rootDirectory = join(repository, "coverage/root")
      const retiredRoot = join(repository, "coverage/root-retired")
      const outsideDirectory = mkdtempSync(
        join(tmpdir(), "coverage-final-cleanup-outside-"),
      )
      temporaryDirectories.push(outsideDirectory)
      const outsideSentinel = join(outsideDirectory, "attestation.json")
      writeFileSync(outsideSentinel, "outside sentinel\n")

      const invalidated = invalidateCoverageArtifactSafely(
        repository,
        join(rootDirectory, "attestation.json"),
        "coverage attestation path",
        {
          beforeInvalidate: () => {
            renameSync(rootDirectory, retiredRoot)
            symlinkSync(outsideDirectory, rootDirectory, "dir")
          },
        },
      )

      expect(invalidated).toBe(true)
      expect(readFileSync(outsideSentinel, "utf8")).toBe("outside sentinel\n")
      expect(readFileSync(join(retiredRoot, "attestation.json"), "utf8")).toBe(
        COVERAGE_ARTIFACT_INVALIDATION_MARKER,
      )
    },
  )

  test("runs root and Desktop coverage concurrently without artifact crossover", async () => {
    const repository = mkdtempSync(join(tmpdir(), "coverage-concurrent-"))
    temporaryDirectories.push(repository)
    runGit(repository, "init", "--quiet")
    runGit(repository, "config", "user.email", "coverage@example.invalid")
    runGit(repository, "config", "user.name", "Coverage Test")
    writeFixtureFile(repository, "README.md", "coverage fixture\n")
    runGit(repository, "add", "README.md")
    runGit(repository, "commit", "--quiet", "-m", "base")
    const base = runGit(repository, "rev-parse", "HEAD")

    writeFixtureFile(
      repository,
      "src/root-value.ts",
      "export const rootValue = 1\n",
    )
    writeFixtureFile(
      repository,
      "tests/root-value.test.ts",
      [
        'import { expect, test } from "bun:test"',
        'import { rootValue } from "../src/root-value"',
        'test("covers root", () => expect(rootValue).toBe(1))',
        "",
      ].join("\n"),
    )
    writeFixtureFile(
      repository,
      "desktop/electron/desktop-value.ts",
      "export const desktopValue = 2\n",
    )
    writeFixtureFile(
      repository,
      "desktop/tests/desktop-value.test.ts",
      [
        'import { expect, test } from "bun:test"',
        'import { desktopValue } from "../electron/desktop-value"',
        'test("covers Desktop", () => expect(desktopValue).toBe(2))',
        "",
      ].join("\n"),
    )
    runGit(repository, "add", "src", "tests", "desktop")
    runGit(repository, "commit", "--quiet", "-m", "add both domains")

    const rootProcess = Bun.spawn(
      [
        process.execPath,
        coverageRunner,
        "--domain",
        "root",
        "--repository",
        repository,
      ],
      { stderr: "pipe", stdout: "pipe" },
    )
    const desktopProcess = Bun.spawn(
      [
        process.execPath,
        coverageRunner,
        "--domain",
        "desktop",
        "--repository",
        repository,
      ],
      { stderr: "pipe", stdout: "pipe" },
    )
    const [rootExit, desktopExit] = await Promise.all([
      rootProcess.exited,
      desktopProcess.exited,
    ])

    expect(rootExit).toBe(0)
    expect(desktopExit).toBe(0)
    const result = checkDiffCoverage({
      base,
      coverage: [
        {
          domain: "root",
          path: join(repository, "coverage/root/lcov.info"),
          sourcePrefix: ".",
        },
        {
          domain: "desktop",
          path: join(repository, "coverage/desktop/lcov.info"),
          sourcePrefix: "desktop",
        },
      ],
      repository,
      threshold: 85,
    })
    expect(result.passed).toBe(true)
    expect(result.files.map(({ file }) => file).sort()).toEqual([
      "desktop/electron/desktop-value.ts",
      "src/root-value.ts",
    ])

    const rootAttestation = JSON.parse(
      readFileSync(join(repository, "coverage/root/attestation.json"), "utf8"),
    ) as Record<string, unknown>
    const desktopAttestation = JSON.parse(
      readFileSync(
        join(repository, "coverage/desktop/attestation.json"),
        "utf8",
      ),
    ) as Record<string, unknown>
    expect(rootAttestation.domain).toBe("root")
    expect(rootAttestation.lcovPath).toBe("coverage/root/lcov.info")
    expect(desktopAttestation.domain).toBe("desktop")
    expect(desktopAttestation.lcovPath).toBe("coverage/desktop/lcov.info")
  })

  test("accepts fully covered destructuring defaults from real Bun LCOV", () => {
    const { base, repository } = createCoverageRepository(
      [
        "export function total(",
        "  { first = 1,",
        "    second = 2 } = {},",
        "): number {",
        "  return first + second",
        "}",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { total } from "../src/value"',
        'test("covers defaults", () => {',
        "  expect(total()).toBe(3)",
        "  expect(total({ first: 3, second: 4 })).toBe(7)",
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(true)
    expect(result.percentage).toBe(100)
  })

  test("keeps an emit-equivalent type edit neutral despite a zero-hit DA", () => {
    const { base, repository } = createModifiedCoverageRepository(
      [
        "export class FixtureClass {",
        "  identity(value: string): string { return value }",
        "}",
        "",
      ].join("\n"),
      [
        "export class FixtureClass {",
        "  identity(value: string | number): string | number { return value }",
        "}",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { FixtureClass } from "../src/value"',
        'test("loads class without calling method", () => {',
        '  expect(typeof FixtureClass).toBe("function")',
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })

  test("excludes a zero-hit type line beside a covered runtime change", () => {
    const { base, repository } = createModifiedCoverageRepository(
      [
        "export class FixtureClass {",
        "  identity(value: string): string { return value }",
        "}",
        "export function runtimeValue(): number { return 1 }",
        "",
      ].join("\n"),
      [
        "export class FixtureClass {",
        "  identity(value: string | number): string | number { return value }",
        "}",
        "export function runtimeValue(): number { return 2 }",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { FixtureClass, runtimeValue } from "../src/value"',
        'test("covers only the runtime change", () => {',
        '  expect(typeof FixtureClass).toBe("function")',
        "  expect(runtimeValue()).toBe(2)",
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(true)
    expect(result.coveredLines).toBe(1)
    expect(result.instrumentedLines).toBe(1)
  })

  test("charges an uncovered parameter property from real Bun LCOV", () => {
    const { base, repository } = createModifiedCoverageRepository(
      [
        "export function makeFixture() {",
        "  class Fixture {",
        "    constructor(value: number) {}",
        "  }",
        "  return Fixture",
        "}",
        "export const marker = 1",
        "",
      ].join("\n"),
      [
        "export function makeFixture() {",
        "  class Fixture {",
        "    constructor(public value: number) {}",
        "  }",
        "  return Fixture",
        "}",
        "export const marker = 1",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { marker } from "../src/value"',
        'test("does not enter the factory", () => {',
        "  expect(marker).toBe(1)",
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.instrumentedLines).toBe(1)
    expect(result.percentage).toBe(0)
  })

  test("charges a concrete class field added inside an uncalled factory", () => {
    const { base, repository } = createModifiedCoverageRepository(
      [
        "export function makeFixture() {",
        "  class Fixture {",
        "    declare value: number",
        "  }",
        "  return Fixture",
        "}",
        "export const marker = 1",
        "",
      ].join("\n"),
      [
        "export function makeFixture() {",
        "  class Fixture {",
        "    value: number",
        "  }",
        "  return Fixture",
        "}",
        "export const marker = 1",
        "",
      ].join("\n"),
      [
        'import { expect, test } from "bun:test"',
        'import { marker } from "../src/value"',
        'test("does not enter the factory", () => {',
        "  expect(marker).toBe(1)",
        "})",
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(false)
    expect(result.instrumentedLines).toBe(1)
    expect(result.percentage).toBe(0)
  })

  test("trusts a real multiline statement-start DA for a continuation edit", () => {
    const { base, repository } = createModifiedCoverageRepository(
      "export const value = (\n  1\n)\n",
      "export const value = (\n  2\n)\n",
      [
        'import { expect, test } from "bun:test"',
        'import { value } from "../src/value"',
        'test("covers value", () => expect(value).toBe(2))',
        "",
      ].join("\n"),
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(1)
    expect(result.files[0]?.percentage).toBe(100)
  })

  test("treats a runtime-to-type replacement like removal from coverage", () => {
    const { base, repository } = createModifiedCoverageRepository(
      "export const value = 1\n",
      "export type Value = number\n",
      [
        'import { expect, test } from "bun:test"',
        'import { control } from "../src/control"',
        'import type { Value } from "../src/value"',
        'test("uses erased type", () => {',
        "  const value: Value = 1",
        "  expect(control).toBe(1)",
        "  expect(value).toBe(1)",
        "})",
        "",
      ].join("\n"),
      { "src/control.ts": "export const control = 1\n" },
    )
    runRootCoverage(repository)

    const result = checkRootCoverage(base, repository)

    expect(result.passed).toBe(true)
    expect(result.files[0]?.instrumentedLines).toBe(0)
  })
})
