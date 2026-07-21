#!/usr/bin/env bun

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

interface VerifyDesktopAssetsOptions {
  directory: string
  tag: string
}

export interface VerifiedDesktopAssets {
  assets: number
  checksums: number
  tag: string
}

const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z-]+)*)?$/u

function assertTag(tag: string): void {
  if (!tagPattern.test(tag)) {
    throw new Error(
      "Desktop asset tag must be a semantic version beginning with v",
    )
  }
}

export function expectedDesktopAssetNames(tag: string): string[] {
  assertTag(tag)
  return [
    `Copilot-API-${tag}-arm64.dmg`,
    `Copilot-API-${tag}-arm64.dmg.blockmap`,
    `Copilot-API-${tag}-arm64.sha256.txt`,
    `Copilot-API-${tag}-x64.dmg`,
    `Copilot-API-${tag}-x64.dmg.blockmap`,
    `Copilot-API-${tag}-x64.sha256.txt`,
    `Copilot-API-${tag}-windows-x64.exe`,
    `Copilot-API-${tag}-windows-x64.sha256.txt`,
  ]
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function checksumPayloadsFor(checksumName: string): string[] {
  const prefix = checksumName.slice(0, -".sha256.txt".length)
  return checksumName.includes("windows-x64") ?
      [`${prefix}.exe`]
    : [`${prefix}.dmg`, `${prefix}.dmg.blockmap`]
}

export function verifyDesktopAssets(
  options: VerifyDesktopAssetsOptions,
): VerifiedDesktopAssets {
  const directory = path.resolve(options.directory)
  const expectedNames = expectedDesktopAssetNames(options.tag)
  for (const name of expectedNames) {
    const filePath = path.join(directory, name)
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`missing Desktop release asset: ${name}`)
    }
  }

  const actualNames = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  if (
    JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())
  ) {
    throw new Error(
      `Desktop release asset set differs from contract: ${JSON.stringify(actualNames)}`,
    )
  }

  let checksums = 0
  for (const checksumName of expectedNames.filter((name) =>
    name.endsWith(".sha256.txt"),
  )) {
    const lines = fs
      .readFileSync(path.join(directory, checksumName), "utf8")
      .trim()
      .split(/\r?\n/u)
    const expectedPayloads = checksumPayloadsFor(checksumName)
    if (lines.length !== expectedPayloads.length) {
      throw new Error(`${checksumName} does not cover every expected payload`)
    }

    const covered = new Set<string>()
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/u.exec(line)
      if (!match) {
        throw new Error(`invalid checksum line in ${checksumName}`)
      }
      const [, expectedHash, payloadName] = match
      if (!expectedPayloads.includes(payloadName) || covered.has(payloadName)) {
        throw new Error(`${checksumName} covers an unexpected payload`)
      }
      if (sha256(path.join(directory, payloadName)) !== expectedHash) {
        throw new Error(`checksum mismatch for ${payloadName}`)
      }
      covered.add(payloadName)
      checksums += 1
    }
  }

  return { assets: expectedNames.length, checksums, tag: options.tag }
}

function immediateFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
}

function exactlyOne(files: string[], description: string): string {
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one ${description}, found ${files.length}`,
    )
  }
  return files[0]
}

export function stageDesktopAssets(options: {
  arch: "arm64" | "x64"
  output: string
  platform: "mac" | "windows"
  releaseDirectory: string
  tag: string
}): string[] {
  assertTag(options.tag)
  if (options.platform === "windows" && options.arch !== "x64") {
    throw new Error("Windows release assets support x64 only")
  }
  const releaseDirectory = path.resolve(options.releaseDirectory)
  const output = path.resolve(options.output)
  if (output === releaseDirectory) {
    throw new Error("Desktop asset output and release directory must differ")
  }
  const releaseFiles = immediateFiles(releaseDirectory)
  fs.rmSync(output, { force: true, recursive: true })
  fs.mkdirSync(output, { recursive: true })

  const base =
    options.platform === "windows" ?
      `Copilot-API-${options.tag}-windows-x64`
    : `Copilot-API-${options.tag}-${options.arch}`
  const sourcePayloads =
    options.platform === "windows" ?
      [
        exactlyOne(
          releaseFiles.filter((file) => file.endsWith(".exe")),
          "Windows installer",
        ),
      ]
    : (() => {
        const dmg = exactlyOne(
          releaseFiles.filter((file) => file.endsWith(".dmg")),
          "macOS DMG",
        )
        const blockmap = `${dmg}.blockmap`
        if (!fs.statSync(blockmap, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`missing blockmap for ${path.basename(dmg)}`)
        }
        return [dmg, blockmap]
      })()

  const stagedPayloads = sourcePayloads.map((source) => {
    const suffix =
      options.platform === "windows" ? ".exe"
      : source.endsWith(".blockmap") ? ".dmg.blockmap"
      : ".dmg"
    const name = `${base}${suffix}`
    fs.copyFileSync(source, path.join(output, name), fs.constants.COPYFILE_EXCL)
    return name
  })
  const checksumName = `${base}.sha256.txt`
  fs.writeFileSync(
    path.join(output, checksumName),
    `${stagedPayloads
      .map((name) => `${sha256(path.join(output, name))}  ${name}`)
      .join("\n")}\n`,
  )
  return [...stagedPayloads, checksumName]
}

export function runDesktopAssetsCli(arguments_: string[]): number {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: arguments_,
      options: {
        arch: { type: "string" },
        directory: { type: "string" },
        output: { type: "string" },
        platform: { type: "string" },
        "release-directory": { type: "string" },
        tag: { type: "string" },
      },
      strict: true,
    })
    const command = positionals[0]
    if (!values.tag) throw new Error("--tag is required")

    if (command === "verify") {
      if (!values.directory) throw new Error("--directory is required")
      const result = verifyDesktopAssets({
        directory: values.directory,
        tag: values.tag,
      })
      console.log(`desktopAssets=${result.assets}`)
      console.log(`desktopChecksums=${result.checksums}`)
      console.log("desktopAssetsOk=true")
      return 0
    }
    if (command === "stage") {
      if (
        !values.arch
        || !values.output
        || !values.platform
        || !values["release-directory"]
      ) {
        throw new Error(
          "stage requires --arch, --platform, --release-directory, and --output",
        )
      }
      const staged = stageDesktopAssets({
        arch: values.arch as "arm64" | "x64",
        output: values.output,
        platform: values.platform as "mac" | "windows",
        releaseDirectory: values["release-directory"],
        tag: values.tag,
      })
      for (const name of staged) console.log(`stagedAsset=${name}`)
      return 0
    }
    throw new Error("command must be stage or verify")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runDesktopAssetsCli(Bun.argv.slice(2))
}
