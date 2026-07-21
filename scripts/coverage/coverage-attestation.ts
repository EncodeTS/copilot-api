import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { atomicWriteProtectedFileSync } from "../../src/lib/file-protection"
import { resolveGitCommit, runGit } from "../lib/git"

export type CoverageDomain = "desktop" | "root"

export interface CoverageAttestationV1 {
  bunVersion: string
  commit: string
  domain: CoverageDomain
  lcovPath: string
  lcovSha256: string
  schema: "copilot-api-coverage-attestation-v1"
  sourceTree: string
}

export type VerifiedCoverageArtifact =
  | { failure: string; ok: false }
  | { lcov: string; ok: true }

export interface CoverageArtifactReadHooks {
  beforeOpen?: (context: { label: string; path: string }) => void
}

export interface CoverageArtifactInvalidationHooks {
  beforeInvalidate?: (context: { label: string; path: string }) => void
}

export const COVERAGE_ARTIFACT_INVALIDATION_MARKER =
  "copilot-api coverage artifact invalidated\n"

const productionPathsByDomain: Record<CoverageDomain, string[]> = {
  desktop: ["desktop/electron", "desktop/src"],
  root: [
    "src",
    "scripts/check-diff-coverage.ts",
    "scripts/coverage",
    "scripts/lib/git.ts",
    "scripts/release",
    "shared-types",
  ],
}

export function defaultCoverageDirectory(
  repository: string,
  domain: CoverageDomain,
): string {
  return join(repository, "coverage", domain)
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function isOutsideRepository(relativePath: string): boolean {
  return (
    relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  )
}

export function assertCoveragePathHasNoSymlinks(
  repository: string,
  path: string,
  label: string,
): void {
  const repositoryPath = resolve(repository)
  const artifactPath = resolve(path)
  const relativePath = relative(repositoryPath, artifactPath)
  if (relativePath === "" || isOutsideRepository(relativePath)) {
    throw new Error(
      `${label} must be inside the repository: ${JSON.stringify(artifactPath)}`,
    )
  }

  let currentPath = repositoryPath
  for (const component of relativePath.split(sep)) {
    currentPath = join(currentPath, component)
    if (!existsSync(currentPath)) {
      break
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(
        `${label} must not contain symbolic links: ${JSON.stringify(artifactPath)}`,
      )
    }
  }
}

interface CoveragePathComponentIdentity {
  dev: number
  ino: number
  path: string
}

interface CoveragePathIdentity {
  artifactPath: string
  components: CoveragePathComponentIdentity[]
  repositoryPath: string
}

function hasSameCoveragePathIdentity(
  before: CoveragePathIdentity,
  after: CoveragePathIdentity,
): boolean {
  return (
    before.repositoryPath === after.repositoryPath
    && before.components.length === after.components.length
    && before.components.every((component, index) => {
      const current = after.components[index]
      return (
        current !== undefined
        && component.path === current.path
        && component.dev === current.dev
        && component.ino === current.ino
      )
    })
  )
}

function captureCoveragePathIdentity(
  repository: string,
  path: string,
  label: string,
): CoveragePathIdentity {
  const repositoryPath = resolve(repository)
  const artifactPath = resolve(path)
  const relativeArtifactPath = relative(repositoryPath, artifactPath)
  if (
    relativeArtifactPath === ""
    || isOutsideRepository(relativeArtifactPath)
  ) {
    throw new Error(
      `${label} must be inside the repository: ${JSON.stringify(artifactPath)}`,
    )
  }

  const componentPaths = [repositoryPath]
  let currentPath = repositoryPath
  for (const component of relativeArtifactPath.split(sep)) {
    currentPath = join(currentPath, component)
    componentPaths.push(currentPath)
  }
  const components = componentPaths.map((componentPath, index) => {
    const stats = lstatSync(componentPath)
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${label} must not contain symbolic links: ${JSON.stringify(artifactPath)}`,
      )
    }
    const isFinal = index === componentPaths.length - 1
    if ((isFinal && !stats.isFile()) || (!isFinal && !stats.isDirectory())) {
      throw new Error(
        `${label} must be a regular repository file: ${JSON.stringify(artifactPath)}`,
      )
    }
    return { dev: stats.dev, ino: stats.ino, path: componentPath }
  })

  const realRepositoryPath = realpathSync(repositoryPath)
  const realArtifactPath = realpathSync(artifactPath)
  const relativePath = relative(realRepositoryPath, realArtifactPath)
  if (relativePath === "" || isOutsideRepository(relativePath)) {
    throw new Error(
      `${label} must be inside the repository: ${JSON.stringify(artifactPath)}`,
    )
  }
  return {
    artifactPath,
    components,
    repositoryPath: relativePath.split(sep).join("/"),
  }
}

interface OpenedCoverageFile {
  bytes: Buffer
  repositoryPath: string
}

function readRegularCoverageFile(
  repository: string,
  path: string,
  label: string,
  hooks?: CoverageArtifactReadHooks,
): OpenedCoverageFile {
  const initialIdentity = captureCoveragePathIdentity(repository, path, label)
  const artifactPath = initialIdentity.artifactPath
  hooks?.beforeOpen?.({ label, path: artifactPath })
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW
  const descriptor = openSync(artifactPath, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) {
      throw new Error(
        `${label} must be a regular file: ${JSON.stringify(artifactPath)}`,
      )
    }
    const expectedFile = initialIdentity.components.at(-1)
    if (
      !expectedFile
      || expectedFile.dev !== before.dev
      || expectedFile.ino !== before.ino
    ) {
      throw new Error(
        `${label} changed between path validation and open: ${JSON.stringify(artifactPath)}`,
      )
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalIdentity = captureCoveragePathIdentity(
      repository,
      artifactPath,
      label,
    )
    if (
      !hasSameCoveragePathIdentity(initialIdentity, finalIdentity)
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.size !== bytes.byteLength
    ) {
      throw new Error(
        `${label} path identity changed while being read: ${JSON.stringify(artifactPath)}`,
      )
    }
    return { bytes, repositoryPath: finalIdentity.repositoryPath }
  } finally {
    closeSync(descriptor)
  }
}

export function invalidateCoverageArtifactSafely(
  repository: string,
  path: string,
  label: string,
  hooks?: CoverageArtifactInvalidationHooks,
): boolean {
  if (!existsSync(path)) return true
  let descriptor: number | undefined
  try {
    const before = captureCoveragePathIdentity(repository, path, label)
    const expectedFile = before.components.at(-1)
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW
    descriptor = openSync(path, constants.O_RDWR | noFollow)
    const opened = fstatSync(descriptor)
    if (
      !opened.isFile()
      || !expectedFile
      || expectedFile.dev !== opened.dev
      || expectedFile.ino !== opened.ino
    ) {
      return false
    }
    const after = captureCoveragePathIdentity(repository, path, label)
    if (!hasSameCoveragePathIdentity(before, after)) return false
    hooks?.beforeInvalidate?.({ label, path })
    ftruncateSync(descriptor, 0)
    writeFileSync(descriptor, COVERAGE_ARTIFACT_INVALIDATION_MARKER)
    fsyncSync(descriptor)
    return true
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function assertCoverageSourcesClean(
  repository: string,
  domain: CoverageDomain,
  purpose: "generation" | "verification" = "generation",
): void {
  const status = runGit(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...productionPathsByDomain[domain],
  ])
  if (status.trim().length > 0) {
    throw new Error(
      `${domain} production sources must be committed before coverage ${purpose}`,
    )
  }
}

export function createCoverageAttestation(
  repository: string,
  domain: CoverageDomain,
  lcovPath: string,
  commit = resolveGitCommit(repository),
): CoverageAttestationV1 {
  const lcov = readRegularCoverageFile(
    repository,
    lcovPath,
    "coverage LCOV path",
  )
  const lcovText = lcov.bytes.toString("utf8")
  if (!/^SF:.+$/m.test(lcovText) || !/^DA:\d+,\d+/m.test(lcovText)) {
    throw new Error("coverage LCOV must contain SF and DA records")
  }
  const sourceTree = runGit(repository, [
    "rev-parse",
    `${commit}^{tree}`,
  ]).trim()
  return {
    bunVersion: Bun.version,
    commit,
    domain,
    lcovPath: lcov.repositoryPath,
    lcovSha256: sha256Bytes(lcov.bytes),
    schema: "copilot-api-coverage-attestation-v1",
    sourceTree,
  }
}

export function writeCoverageAttestation(
  path: string,
  attestation: CoverageAttestationV1,
): void {
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        `coverage attestation destination must be a regular file: ${JSON.stringify(path)}`,
      )
    }
  }
  atomicWriteProtectedFileSync(
    path,
    `${JSON.stringify(attestation, null, 2)}\n`,
  )
}

function parseCoverageAttestation(
  contents: string,
  path: string,
): CoverageAttestationV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error(
      `coverage attestation is not valid JSON: ${JSON.stringify(path)}`,
    )
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("schema" in parsed)
    || parsed.schema !== "copilot-api-coverage-attestation-v1"
    || !("domain" in parsed)
    || (parsed.domain !== "desktop" && parsed.domain !== "root")
    || !("commit" in parsed)
    || typeof parsed.commit !== "string"
    || !/^[0-9a-f]{40}$/.test(parsed.commit)
    || !("sourceTree" in parsed)
    || typeof parsed.sourceTree !== "string"
    || !/^[0-9a-f]{40}$/.test(parsed.sourceTree)
    || !("lcovSha256" in parsed)
    || typeof parsed.lcovSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(parsed.lcovSha256)
    || !("lcovPath" in parsed)
    || typeof parsed.lcovPath !== "string"
    || parsed.lcovPath.length === 0
    || parsed.lcovPath.includes("\\")
    || parsed.lcovPath.startsWith("/")
    || parsed.lcovPath
      .split("/")
      .some(
        (component) =>
          component === "" || component === "." || component === "..",
      )
    || !("bunVersion" in parsed)
    || typeof parsed.bunVersion !== "string"
  ) {
    throw new Error(
      `coverage attestation has an invalid shape: ${JSON.stringify(path)}`,
    )
  }
  return parsed as CoverageAttestationV1
}

export function readVerifiedCoverageArtifact(
  repository: string,
  domain: CoverageDomain,
  lcovPath: string,
  attestationPath: string,
  expectedCommit = resolveGitCommit(repository),
  hooks?: CoverageArtifactReadHooks,
): VerifiedCoverageArtifact {
  if (!existsSync(attestationPath)) {
    return {
      failure: `coverage attestation file does not exist: ${JSON.stringify(attestationPath)}`,
      ok: false,
    }
  }
  try {
    const lcov = readRegularCoverageFile(
      repository,
      lcovPath,
      "coverage LCOV path",
      hooks,
    )
    const attestationFile = readRegularCoverageFile(
      repository,
      attestationPath,
      "coverage attestation path",
      hooks,
    )
    const attestation = parseCoverageAttestation(
      attestationFile.bytes.toString("utf8"),
      attestationPath,
    )
    if (attestation.domain !== domain) {
      return {
        failure: `coverage attestation domain mismatch: ${JSON.stringify(attestationPath)}`,
        ok: false,
      }
    }
    if (attestation.bunVersion !== Bun.version) {
      return {
        failure: `coverage attestation Bun version mismatch: ${JSON.stringify(attestationPath)}`,
        ok: false,
      }
    }
    if (attestation.lcovPath !== lcov.repositoryPath) {
      return {
        failure: `coverage attestation LCOV path mismatch: ${JSON.stringify(lcovPath)}`,
        ok: false,
      }
    }
    assertCoverageSourcesClean(repository, domain, "verification")
    if (attestation.commit !== expectedCommit) {
      return {
        failure: `coverage attestation commit mismatch: ${JSON.stringify(attestationPath)}`,
        ok: false,
      }
    }
    const sourceTree = runGit(repository, [
      "rev-parse",
      `${expectedCommit}^{tree}`,
    ]).trim()
    if (attestation.sourceTree !== sourceTree) {
      return {
        failure: `coverage attestation source tree mismatch: ${JSON.stringify(attestationPath)}`,
        ok: false,
      }
    }
    if (attestation.lcovSha256 !== sha256Bytes(lcov.bytes)) {
      return {
        failure: `coverage attestation LCOV hash mismatch: ${JSON.stringify(lcovPath)}`,
        ok: false,
      }
    }
    return { lcov: lcov.bytes.toString("utf8"), ok: true }
  } catch (error) {
    return {
      failure: error instanceof Error ? error.message : String(error),
      ok: false,
    }
  }
}

export function verifyCoverageAttestation(
  repository: string,
  domain: CoverageDomain,
  lcovPath: string,
  attestationPath: string,
  expectedCommit = resolveGitCommit(repository),
): string | undefined {
  const result = readVerifiedCoverageArtifact(
    repository,
    domain,
    lcovPath,
    attestationPath,
    expectedCommit,
  )
  return result.ok ? undefined : result.failure
}
