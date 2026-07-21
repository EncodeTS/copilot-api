import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  expectedDesktopAssetNames,
  runDesktopAssetsCli,
  stageDesktopAssets,
  verifyDesktopAssets,
} from "../scripts/release/desktop-assets"
import {
  runReleaseQualityCli,
  verifyReleaseInputs,
} from "../scripts/release/quality"

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-release-quality-"),
  )
  temporaryDirectories.push(directory)
  return directory
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeLockfile(
  filePath: string,
  manifest: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    name: string
  },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `{
  "lockfileVersion": 1,
  "configVersion": 0,
  "workspaces": {
    "": {
      "name": ${JSON.stringify(manifest.name)},
      "dependencies": ${JSON.stringify(manifest.dependencies ?? {})},
      "devDependencies": ${JSON.stringify(manifest.devDependencies ?? {})},
    },
  },
  "packages": {},
}\n`,
  )
}

function releaseFixture(version = "2.0.0-rc.14"): string {
  const repository = temporaryDirectory()
  const rootManifest = {
    name: "@encodets/copilot-api",
    version,
    packageManager: "bun@1.3.14",
    dependencies: { hono: "^4.9.9" },
    devDependencies: { typescript: "^5.9.3" },
  }
  const desktopManifest = {
    name: "copilot-api-desktop",
    version,
    packageManager: "bun@1.3.14",
    dependencies: { "electron-updater": "^6.3.4" },
    devDependencies: { electron: "^39.8.6" },
  }

  writeJson(path.join(repository, "package.json"), rootManifest)
  writeJson(path.join(repository, "desktop", "package.json"), desktopManifest)
  writeJson(path.join(repository, "desktop", "build", "server-package.json"), {
    name: "copilot-api-server",
    version,
    type: "module",
  })
  writeLockfile(path.join(repository, "bun.lock"), rootManifest)
  writeLockfile(path.join(repository, "desktop", "bun.lock"), desktopManifest)
  return repository
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("release identity quality contract", () => {
  test("accepts one immutable RC identity across manifests and locks", () => {
    const result = verifyReleaseInputs({
      repository: releaseFixture(),
      tag: "v2.0.0-rc.14",
    })

    expect(result).toEqual({
      isPrerelease: true,
      npmTag: "rc",
      tag: "v2.0.0-rc.14",
      version: "2.0.0-rc.14",
    })
  })

  test("fails before publication when any embedded manifest version differs", () => {
    const repository = releaseFixture()
    writeJson(
      path.join(repository, "desktop", "build", "server-package.json"),
      {
        name: "copilot-api-server",
        version: "2.0.0-rc.13",
      },
    )

    expect(() =>
      verifyReleaseInputs({ repository, tag: "v2.0.0-rc.14" }),
    ).toThrow("desktop/build/server-package.json version")
  })

  test("fails when a lock workspace no longer matches its manifest", () => {
    const repository = releaseFixture()
    writeLockfile(path.join(repository, "desktop", "bun.lock"), {
      name: "copilot-api-desktop",
      dependencies: { "electron-updater": "^6.3.3" },
      devDependencies: { electron: "^39.8.6" },
    })

    expect(() =>
      verifyReleaseInputs({ repository, tag: "v2.0.0-rc.14" }),
    ).toThrow("desktop/bun.lock dependencies")
  })

  test("rejects a tag that does not exactly encode the package version", () => {
    expect(() =>
      verifyReleaseInputs({
        repository: releaseFixture(),
        tag: "release-2.0.0-rc.14",
      }),
    ).toThrow("tag must be an immutable semantic version")

    expect(() =>
      verifyReleaseInputs({
        repository: releaseFixture("2.0.0+rebuilt"),
        tag: "v2.0.0+rebuilt",
      }),
    ).toThrow("must not contain build metadata")
  })

  test("publishes validated metadata to the GitHub Actions output contract", () => {
    const repository = releaseFixture()
    const githubOutput = path.join(temporaryDirectory(), "github-output")

    expect(
      runReleaseQualityCli([
        "--repository",
        repository,
        "--tag",
        "v2.0.0-rc.14",
        "--github-output",
        githubOutput,
      ]),
    ).toBe(0)
    expect(fs.readFileSync(githubOutput, "utf8")).toBe(
      "is_prerelease=true\nnpm_tag=rc\ntag=v2.0.0-rc.14\nversion=2.0.0-rc.14\n",
    )
  })

  test("binds the exact tag object, checked-out HEAD, and event SHA", () => {
    const repository = releaseFixture()
    execFileSync("git", ["init"], { cwd: repository })
    execFileSync("git", ["config", "user.email", "release@test.invalid"], {
      cwd: repository,
    })
    execFileSync("git", ["config", "user.name", "Release Test"], {
      cwd: repository,
    })
    execFileSync("git", ["add", "."], { cwd: repository })
    execFileSync("git", ["commit", "-m", "test: release identity"], {
      cwd: repository,
    })
    execFileSync("git", ["tag", "v2.0.0-rc.14"], { cwd: repository })
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim()

    expect(
      verifyReleaseInputs({
        commit,
        repository,
        tag: "v2.0.0-rc.14",
      }).version,
    ).toBe("2.0.0-rc.14")
    expect(() =>
      verifyReleaseInputs({
        commit: "0".repeat(40),
        repository,
        tag: "v2.0.0-rc.14",
      }),
    ).toThrow("release tag, checkout, and event commit differ")
  })

  test("rejects malformed manifests, unsupported locks, and Bun drift", () => {
    const badManifestRepository = releaseFixture()
    fs.writeFileSync(
      path.join(badManifestRepository, "desktop", "package.json"),
      "not-json",
    )
    expect(() =>
      verifyReleaseInputs({
        repository: badManifestRepository,
        tag: "v2.0.0-rc.14",
      }),
    ).toThrow("cannot parse")

    const lockRepository = releaseFixture()
    fs.writeFileSync(path.join(lockRepository, "bun.lock"), "{}")
    expect(() =>
      verifyReleaseInputs({ repository: lockRepository, tag: "v2.0.0-rc.14" }),
    ).toThrow("unsupported lockfileVersion")

    const bunRepository = releaseFixture()
    const desktopManifest = JSON.parse(
      fs.readFileSync(
        path.join(bunRepository, "desktop", "package.json"),
        "utf8",
      ),
    ) as Record<string, unknown>
    desktopManifest.packageManager = "bun@1.3.13"
    writeJson(
      path.join(bunRepository, "desktop", "package.json"),
      desktopManifest,
    )
    expect(() =>
      verifyReleaseInputs({ repository: bunRepository, tag: "v2.0.0-rc.14" }),
    ).toThrow("same exact Bun version")
  })
})

describe("Desktop release asset quality contract", () => {
  test("requires every platform payload and verifies every checksum", () => {
    const directory = temporaryDirectory()
    const tag = "v2.0.0-rc.14"
    const payloads = expectedDesktopAssetNames(tag).filter(
      (name) => !name.endsWith(".sha256.txt"),
    )

    for (const [index, name] of payloads.entries()) {
      fs.writeFileSync(path.join(directory, name), `payload-${index}`)
    }

    for (const checksumName of expectedDesktopAssetNames(tag).filter((name) =>
      name.endsWith(".sha256.txt"),
    )) {
      const prefix = checksumName.slice(0, -".sha256.txt".length)
      const covered = payloads.filter((name) => name.startsWith(prefix))
      const contents = covered
        .map((name) => {
          const hash = createHash("sha256")
            .update(fs.readFileSync(path.join(directory, name)))
            .digest("hex")
          return `${hash}  ${name}`
        })
        .join("\n")
      fs.writeFileSync(path.join(directory, checksumName), `${contents}\n`)
    }

    expect(verifyDesktopAssets({ directory, tag })).toEqual({
      assets: 8,
      checksums: 5,
      tag,
    })

    const checksumPath = path.join(
      directory,
      `Copilot-API-${tag}-arm64.sha256.txt`,
    )
    fs.writeFileSync(
      checksumPath,
      fs
        .readFileSync(checksumPath, "utf8")
        .replace(/^[0-9a-f]{64}/u, "0".repeat(64)),
    )
    expect(() => verifyDesktopAssets({ directory, tag })).toThrow(
      "checksum mismatch",
    )
  })

  test("fails closed on a missing platform asset or altered payload", () => {
    const directory = temporaryDirectory()
    const tag = "v2.0.0-rc.14"
    const names = expectedDesktopAssetNames(tag)
    for (const name of names) {
      fs.writeFileSync(path.join(directory, name), "placeholder")
    }

    expect(() => verifyDesktopAssets({ directory, tag })).toThrow(
      "does not cover every expected payload",
    )
    fs.rmSync(path.join(directory, names[0]))
    expect(() => verifyDesktopAssets({ directory, tag })).toThrow(
      "missing Desktop release asset",
    )
  })

  test("stages unambiguous native outputs under the immutable asset names", () => {
    const tag = "v2.0.0-rc.14"
    const combined = temporaryDirectory()
    const matrix = [
      { arch: "arm64" as const, platform: "mac" as const },
      { arch: "x64" as const, platform: "mac" as const },
      { arch: "x64" as const, platform: "windows" as const },
    ]

    for (const item of matrix) {
      const releaseDirectory = temporaryDirectory()
      if (item.platform === "mac") {
        fs.writeFileSync(path.join(releaseDirectory, "generated.dmg"), "dmg")
        fs.writeFileSync(
          path.join(releaseDirectory, "generated.dmg.blockmap"),
          "blockmap",
        )
      } else {
        fs.writeFileSync(path.join(releaseDirectory, "generated.exe"), "exe")
      }
      const output = temporaryDirectory()
      const staged = stageDesktopAssets({
        ...item,
        output,
        releaseDirectory,
        tag,
      })
      expect(staged.length).toBe(item.platform === "mac" ? 3 : 2)
      fs.cpSync(output, combined, { recursive: true })
    }

    expect(verifyDesktopAssets({ directory: combined, tag }).assets).toBe(8)
    expect(
      runDesktopAssetsCli(["verify", "--directory", combined, "--tag", tag]),
    ).toBe(0)
  })

  test("refuses ambiguous builders and unexpected release files", () => {
    expect(() => expectedDesktopAssetNames("latest")).toThrow(
      "semantic version beginning with v",
    )
    const releaseDirectory = temporaryDirectory()
    fs.writeFileSync(path.join(releaseDirectory, "first.exe"), "one")
    fs.writeFileSync(path.join(releaseDirectory, "second.exe"), "two")
    expect(() =>
      stageDesktopAssets({
        arch: "x64",
        output: temporaryDirectory(),
        platform: "windows",
        releaseDirectory,
        tag: "v2.0.0-rc.14",
      }),
    ).toThrow("expected exactly one Windows installer")

    expect(() =>
      stageDesktopAssets({
        arch: "x64",
        output: releaseDirectory,
        platform: "windows",
        releaseDirectory,
        tag: "v2.0.0-rc.14",
      }),
    ).toThrow("must differ")

    const complete = temporaryDirectory()
    for (const name of expectedDesktopAssetNames("v2.0.0-rc.14")) {
      fs.writeFileSync(path.join(complete, name), "placeholder")
    }
    fs.writeFileSync(path.join(complete, "unexpected.private"), "do not upload")
    expect(() =>
      verifyDesktopAssets({ directory: complete, tag: "v2.0.0-rc.14" }),
    ).toThrow("asset set differs from contract")
  })
})

describe("unified release workflow contract", () => {
  test("uses an ORAS CLI version embedded by the pinned setup action", async () => {
    const repository = path.join(import.meta.dir, "..")
    const workflowPath = path.join(
      repository,
      ".github",
      "workflows",
      "release.yml",
    )
    const workflow = Bun.YAML.parse(await Bun.file(workflowPath).text()) as {
      jobs: Record<
        string,
        { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }
      >
    }
    const pinnedSetupOras =
      "oras-project/setup-oras@22ce207df3b08e061f537244349aac6ae1d214f6"
    // This pinned upstream commit embeds releases.json through ORAS CLI 1.3.0.
    // A newer CLI tag requires a separately reviewed setup-action repin.
    const embeddedVersions = new Map([[pinnedSetupOras, new Set(["1.3.0"])]])
    const setupSteps = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter((step) => step.uses?.startsWith("oras-project/setup-oras@"))
        .map((step) => ({ jobName, step })),
    )

    expect(setupSteps.map(({ jobName }) => jobName)).toEqual([
      "build-docker",
      "publish-docker",
    ])
    for (const { jobName, step } of setupSteps) {
      expect(step.uses, jobName).toBe(pinnedSetupOras)
      expect(
        embeddedVersions.get(step.uses ?? "")?.has(String(step.with?.version)),
        jobName,
      ).toBe(true)
    }
  })

  test("makes every publication edge wait for quality and runtime smoke", async () => {
    const repository = path.join(import.meta.dir, "..")
    const workflowPath = path.join(
      repository,
      ".github",
      "workflows",
      "release.yml",
    )
    const workflowText = await Bun.file(workflowPath).text()
    const workflow = Bun.YAML.parse(workflowText) as {
      jobs: Record<
        string,
        {
          if?: string
          needs?: string | string[]
          permissions?: Record<string, string>
          steps?: Array<{ uses?: string; with?: Record<string, unknown> }>
        }
      >
      on: Record<string, unknown>
      permissions: Record<string, string>
    }

    expect(workflow.on).toEqual({ push: { tags: ["v*"] } })
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(workflow.jobs["publish-npm"].needs).toBe("quality")
    expect(workflow.jobs["publish-npm"].if).toContain("ENABLE_NPM_PUBLISH")
    expect(workflow.jobs["publish-desktop"].needs).toEqual([
      "quality",
      "build-desktop",
    ])
    expect(workflow.jobs["build-docker"].needs).toBe("quality")
    expect(workflow.jobs["docker-artifact-quality"].needs).toEqual([
      "quality",
      "build-docker",
    ])
    expect(workflow.jobs["publish-docker"].needs).toEqual([
      "quality",
      "docker-artifact-quality",
    ])
    expect(workflow.jobs["publish-npm"].permissions).toEqual({
      contents: "read",
      "id-token": "write",
    })
    expect(workflow.jobs["publish-desktop"].permissions).toEqual({
      contents: "write",
    })
    expect(workflow.jobs["publish-docker"].permissions).toEqual({
      contents: "read",
      packages: "write",
    })

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"], jobName).toBe(false)
        }
        if (step.uses) {
          expect(step.uses, jobName).toMatch(/@[0-9a-f]{40}$/u)
        }
      }
    }

    expect(workflowText).not.toContain("--clobber")
    expect(workflowText).not.toContain("cosign")
    expect(workflowText).not.toContain("handlers/VERSION")
    expect(workflowText).toContain(
      "Refuse to replace an existing Docker version tag",
    )
    expect(workflowText).toContain(
      "Cannot prove that the Docker version tag is absent",
    )
    expect(workflowText).toContain("type=oci")
    expect(workflowText).not.toContain("type=docker")
    expect(workflowText).toContain("oras cp --from-oci-layout")
    expect(workflowText).toContain("exact_image=")
    expect(workflowText).toContain("verify-published")
    expect(workflowText).not.toContain("docker/build-push-action")
    expect(workflowText).toMatch(
      /Build npm publication artifact[\s\S]*?bun run build[\s\S]*?npm pack/u,
    )
    const dockerfile = await Bun.file(
      path.join(repository, "Dockerfile"),
    ).text()
    expect(
      dockerfile.match(
        /^FROM oven\/bun:1\.3\.14-alpine@sha256:[0-9a-f]{64}/gmu,
      ),
    ).toHaveLength(2)
    expect(
      fs.existsSync(
        path.join(repository, ".github", "workflows", "release-docker.yml"),
      ),
    ).toBe(false)
    expect(
      fs.existsSync(
        path.join(repository, ".github", "workflows", "release-desktop.yml"),
      ),
    ).toBe(false)
  })
})
