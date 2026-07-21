#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync } from "node:fs"
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
