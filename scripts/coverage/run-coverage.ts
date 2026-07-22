#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"

import { resolveGitCommit } from "../lib/git"
import {
  assertCoverageSourcesClean,
  assertCoveragePathHasNoSymlinks,
  createCoverageAttestation,
  defaultCoverageDirectory,
  invalidateCoverageArtifactSafely,
  type CoverageDomain,
  writeCoverageAttestation,
  verifyCoverageAttestation,
} from "./coverage-attestation"
import { filterLcovSources, mergeLcovFilesSync } from "./merge-lcov"

const DESKTOP_BOUNDARY_COVERAGE_SOURCES = new Set([
  "electron/ipc-handlers.ts",
  "electron/main.ts",
  "electron/preload.ts",
  "electron/server-manager-runtime.ts",
  "src/types/ipc.ts",
])

export interface CoverageRunnerContext {
  attestationPath: string
  coverageDirectory: string
  domain: CoverageDomain
  lcovPath: string
  repository: string
}

export interface CoverageRunnerHooks {
  afterTestRun?: (context: CoverageRunnerContext) => void
  afterVerification?: (context: CoverageRunnerContext) => void
  beforeAttestation?: (context: CoverageRunnerContext) => void
}

function parseDomain(value: string | undefined): CoverageDomain {
  if (value === "desktop" || value === "root") {
    return value
  }
  throw new Error("--domain must be root or desktop")
}

function assertCoverageRunStillCurrent(
  repository: string,
  domain: CoverageDomain,
  initialCommit: string,
): void {
  assertCoverageSourcesClean(repository, domain)
  if (resolveGitCommit(repository) !== initialCommit) {
    throw new Error("HEAD changed while coverage was running")
  }
}

function readRealLcovReport(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`${label} was not produced`)
  }
  if (!lstatSync(path).isFile()) {
    throw new Error(`${label} must be a regular file: ${JSON.stringify(path)}`)
  }
  const contents = readFileSync(path, "utf8")
  if (!/^SF:.+$/m.test(contents) || !/^DA:\d+,\d+/m.test(contents)) {
    throw new Error(`${label} must contain SF and DA records`)
  }
  return contents
}

function runDesktopBoundaryCoverage(
  repository: string,
  lcovPath: string,
): number {
  const probePath = resolve(
    repository,
    "desktop/tests/desktop-shared-boundaries.probe.ts",
  )
  if (!existsSync(probePath)) return 0

  readRealLcovReport(lcovPath, "coverage LCOV")
  const boundaryDirectory = resolve(repository, "coverage/desktop-boundary")
  const boundaryLcovPath = resolve(boundaryDirectory, "lcov.info")
  assertCoveragePathHasNoSymlinks(
    repository,
    boundaryDirectory,
    "Desktop boundary coverage output directory",
  )
  if (
    existsSync(boundaryDirectory)
    && !lstatSync(boundaryDirectory).isDirectory()
  ) {
    throw new Error(
      `Desktop boundary coverage output path must be a directory: ${JSON.stringify(boundaryDirectory)}`,
    )
  }
  mkdirSync(boundaryDirectory, { recursive: true })
  assertCoveragePathHasNoSymlinks(
    repository,
    boundaryLcovPath,
    "Desktop boundary coverage LCOV path",
  )
  if (existsSync(boundaryLcovPath)) {
    if (!lstatSync(boundaryLcovPath).isFile()) {
      throw new Error(
        `Desktop boundary coverage LCOV path must be a regular file: ${JSON.stringify(boundaryLcovPath)}`,
      )
    }
    if (
      !invalidateCoverageArtifactSafely(
        repository,
        boundaryLcovPath,
        "Desktop boundary coverage LCOV path",
      )
    ) {
      throw new Error(
        `Desktop boundary coverage LCOV could not be invalidated safely: ${JSON.stringify(boundaryLcovPath)}`,
      )
    }
  }

  const result = spawnSync(
    process.execPath,
    [
      "test",
      "./tests/desktop-shared-boundaries.probe.ts",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${boundaryDirectory}`,
    ],
    {
      cwd: resolve(repository, "desktop"),
      stdio: process.env.NODE_ENV === "test" ? "pipe" : "inherit",
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1

  assertCoveragePathHasNoSymlinks(
    repository,
    boundaryLcovPath,
    "Desktop boundary coverage LCOV path",
  )
  const boundaryLcov = readRealLcovReport(
    boundaryLcovPath,
    "Desktop boundary coverage LCOV",
  )
  const admittedBoundaryLcov = filterLcovSources(
    boundaryLcov,
    DESKTOP_BOUNDARY_COVERAGE_SOURCES,
  )
  if (
    !/^SF:.+$/m.test(admittedBoundaryLcov)
    || !/^DA:\d+,\d+/m.test(admittedBoundaryLcov)
  ) {
    throw new Error(
      "Desktop boundary coverage produced no allowlisted SF and DA records",
    )
  }

  mergeLcovFilesSync(
    lcovPath,
    [lcovPath, boundaryLcovPath],
    DESKTOP_BOUNDARY_COVERAGE_SOURCES,
  )
  readRealLcovReport(lcovPath, "merged Desktop coverage LCOV")
  return 0
}

export function runCoverageCli(
  arguments_: string[],
  hooks: CoverageRunnerHooks = {},
): number {
  let attestationPath: string | undefined
  let repository: string | undefined
  try {
    const { values } = parseArgs({
      args: arguments_,
      options: {
        domain: { type: "string" },
        repository: { type: "string" },
      },
      strict: true,
    })
    const domain = parseDomain(values.domain)
    repository = resolve(values.repository ?? process.cwd())
    const coverageDirectory = defaultCoverageDirectory(repository, domain)
    const lcovPath = resolve(coverageDirectory, "lcov.info")
    attestationPath = resolve(coverageDirectory, "attestation.json")
    const initialCommit = resolveGitCommit(repository)

    assertCoveragePathHasNoSymlinks(
      repository,
      coverageDirectory,
      "coverage output directory",
    )
    if (
      existsSync(coverageDirectory)
      && !lstatSync(coverageDirectory).isDirectory()
    ) {
      throw new Error(
        `coverage output path must be a directory: ${JSON.stringify(coverageDirectory)}`,
      )
    }
    mkdirSync(coverageDirectory, { recursive: true })
    assertCoveragePathHasNoSymlinks(
      repository,
      coverageDirectory,
      "coverage output directory",
    )
    for (const [path, label] of [
      [attestationPath, "coverage attestation path"],
      [lcovPath, "coverage LCOV path"],
    ] as const) {
      assertCoveragePathHasNoSymlinks(repository, path, label)
      if (existsSync(path)) {
        if (!lstatSync(path).isFile()) {
          throw new Error(
            `${label} must be a regular file: ${JSON.stringify(path)}`,
          )
        }
        if (!invalidateCoverageArtifactSafely(repository, path, label)) {
          throw new Error(
            `${label} could not be invalidated safely: ${JSON.stringify(path)}`,
          )
        }
      }
    }

    assertCoverageSourcesClean(repository, domain)
    const result = spawnSync(
      process.execPath,
      [
        "test",
        "tests",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coverageDirectory}`,
      ],
      {
        cwd: domain === "desktop" ? resolve(repository, "desktop") : repository,
        stdio: process.env.NODE_ENV === "test" ? "pipe" : "inherit",
      },
    )
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      return result.status ?? 1
    }
    assertCoverageRunStillCurrent(repository, domain, initialCommit)
    if (domain === "desktop") {
      const boundaryStatus = runDesktopBoundaryCoverage(repository, lcovPath)
      if (boundaryStatus !== 0) return boundaryStatus
      assertCoverageRunStillCurrent(repository, domain, initialCommit)
    }
    const context: CoverageRunnerContext = {
      attestationPath,
      coverageDirectory,
      domain,
      lcovPath,
      repository,
    }
    hooks.afterTestRun?.(context)

    assertCoverageRunStillCurrent(repository, domain, initialCommit)
    if (!existsSync(lcovPath)) {
      throw new Error("coverage run completed without producing LCOV")
    }
    assertCoveragePathHasNoSymlinks(repository, lcovPath, "coverage LCOV path")
    if (!lstatSync(lcovPath).isFile()) {
      throw new Error(
        `coverage LCOV path must be a regular file: ${JSON.stringify(lcovPath)}`,
      )
    }
    hooks.beforeAttestation?.(context)
    const attestation = createCoverageAttestation(
      repository,
      domain,
      lcovPath,
      initialCommit,
    )
    assertCoverageRunStillCurrent(repository, domain, initialCommit)
    writeCoverageAttestation(attestationPath, attestation)
    assertCoverageRunStillCurrent(repository, domain, initialCommit)
    const verificationFailure = verifyCoverageAttestation(
      repository,
      domain,
      lcovPath,
      attestationPath,
      initialCommit,
    )
    if (verificationFailure) {
      throw new Error(
        `generated coverage attestation failed self-verification: ${verificationFailure}`,
      )
    }
    hooks.afterVerification?.(context)
    assertCoverageRunStillCurrent(repository, domain, initialCommit)
    return 0
  } catch (error) {
    if (repository && attestationPath) {
      invalidateCoverageArtifactSafely(
        repository,
        attestationPath,
        "coverage attestation path",
      )
    }
    console.error(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runCoverageCli(Bun.argv.slice(2))
}
