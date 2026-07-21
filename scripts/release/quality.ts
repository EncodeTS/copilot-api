#!/usr/bin/env bun

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  name?: string
  optionalDependencies?: Record<string, string>
  packageManager?: string
  peerDependencies?: Record<string, string>
  version?: string
}

interface BunLockfile {
  lockfileVersion?: number
  workspaces?: Record<string, PackageManifest>
}

export interface ReleaseIdentity {
  isPrerelease: boolean
  npmTag: string
  tag: string
  version: string
}

export interface VerifyReleaseInputsOptions {
  commit?: string
  repository: string
  tag: string
}

const manifestDependencyKeys = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

const semanticVersionPattern =
  /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z-]+)*)?)$/u

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
  } catch (error) {
    throw new Error(
      `cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function readBunLockfile(filePath: string): BunLockfile {
  try {
    const jsonc = (
      Bun as unknown as { JSONC: { parse: (contents: string) => unknown } }
    ).JSONC
    return jsonc.parse(fs.readFileSync(filePath, "utf8")) as BunLockfile
  } catch (error) {
    throw new Error(
      `cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function stableRecord(value: Record<string, string> | undefined): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
}

function verifyLockfile(
  repository: string,
  relativeLockfile: string,
  manifest: PackageManifest,
): void {
  const lockfile = readBunLockfile(path.join(repository, relativeLockfile))
  if (lockfile.lockfileVersion !== 1) {
    throw new Error(`${relativeLockfile} has an unsupported lockfileVersion`)
  }

  const workspace = lockfile.workspaces?.[""]
  if (!workspace) {
    throw new Error(`${relativeLockfile} has no root workspace`)
  }
  if (workspace.name !== manifest.name) {
    throw new Error(
      `${relativeLockfile} workspace name ${JSON.stringify(workspace.name)} does not match manifest ${JSON.stringify(manifest.name)}`,
    )
  }

  for (const dependencyKey of manifestDependencyKeys) {
    if (
      stableRecord(workspace[dependencyKey])
      !== stableRecord(manifest[dependencyKey])
    ) {
      throw new Error(
        `${relativeLockfile} ${dependencyKey} do not match the package manifest`,
      )
    }
  }
}

function verifyTagCommit(
  repository: string,
  tag: string,
  expectedCommit: string,
): void {
  if (!/^[0-9a-f]{40}$/iu.test(expectedCommit)) {
    throw new Error("release commit must be a full 40-character Git SHA")
  }
  const tagCommit = execFileSync(
    "git",
    ["rev-parse", `refs/tags/${tag}^{commit}`],
    { cwd: repository, encoding: "utf8" },
  ).trim()
  const headCommit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repository,
    encoding: "utf8",
  }).trim()

  if (tagCommit !== expectedCommit || headCommit !== expectedCommit) {
    throw new Error(
      `release tag, checkout, and event commit differ: tag=${tagCommit} checkout=${headCommit} event=${expectedCommit}`,
    )
  }
}

export function verifyReleaseInputs(
  options: VerifyReleaseInputsOptions,
): ReleaseIdentity {
  const repository = path.resolve(options.repository)
  const tagMatch = semanticVersionPattern.exec(options.tag)
  if (!tagMatch) {
    throw new Error(
      "release tag must be an immutable semantic version beginning with v",
    )
  }
  const version = tagMatch[1]
  if (version.includes("+")) {
    throw new Error(
      "release tag must not contain build metadata because Docker tags cannot preserve it exactly",
    )
  }
  const manifests = [
    [
      "package.json",
      readJson<PackageManifest>(path.join(repository, "package.json")),
    ],
    [
      "desktop/package.json",
      readJson<PackageManifest>(
        path.join(repository, "desktop", "package.json"),
      ),
    ],
    [
      "desktop/build/server-package.json",
      readJson<PackageManifest>(
        path.join(repository, "desktop", "build", "server-package.json"),
      ),
    ],
  ] as const

  for (const [manifestPath, manifest] of manifests) {
    if (manifest.version !== version) {
      throw new Error(
        `${manifestPath} version ${JSON.stringify(manifest.version)} does not match tag version ${version}`,
      )
    }
  }

  const rootManifest = manifests[0][1]
  const desktopManifest = manifests[1][1]
  if (
    !/^bun@\d+\.\d+\.\d+$/u.test(rootManifest.packageManager ?? "")
    || desktopManifest.packageManager !== rootManifest.packageManager
  ) {
    throw new Error(
      "root and Desktop packageManager fields must name the same exact Bun version",
    )
  }

  verifyLockfile(repository, "bun.lock", rootManifest)
  verifyLockfile(repository, "desktop/bun.lock", desktopManifest)

  if (options.commit) {
    verifyTagCommit(repository, options.tag, options.commit)
  }

  const prerelease = version.split("-", 2)[1]
  const npmTag = prerelease?.split(".", 1)[0] ?? "latest"
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(npmTag)) {
    throw new Error(`release tag has unsupported npm channel ${npmTag}`)
  }

  return {
    isPrerelease: prerelease !== undefined,
    npmTag,
    tag: options.tag,
    version,
  }
}

function appendGithubOutputs(
  filePath: string,
  identity: ReleaseIdentity,
): void {
  fs.appendFileSync(
    filePath,
    [
      `is_prerelease=${identity.isPrerelease}`,
      `npm_tag=${identity.npmTag}`,
      `tag=${identity.tag}`,
      `version=${identity.version}`,
      "",
    ].join("\n"),
  )
}

export function runReleaseQualityCli(arguments_: string[]): number {
  try {
    const { values } = parseArgs({
      args: arguments_,
      options: {
        commit: { type: "string" },
        "github-output": { type: "string" },
        repository: { type: "string", default: process.cwd() },
        tag: { type: "string" },
      },
      strict: true,
    })
    if (!values.tag) {
      throw new Error("--tag is required")
    }

    const identity = verifyReleaseInputs({
      commit: values.commit,
      repository: values.repository,
      tag: values.tag,
    })
    if (values["github-output"]) {
      appendGithubOutputs(values["github-output"], identity)
    }
    console.log(`releaseTag=${identity.tag}`)
    console.log(`releaseVersion=${identity.version}`)
    console.log(`releasePrerelease=${identity.isPrerelease}`)
    console.log(`releaseNpmTag=${identity.npmTag}`)
    console.log("releaseInputsOk=true")
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runReleaseQualityCli(Bun.argv.slice(2))
}
