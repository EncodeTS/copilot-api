#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { collectInstalledPackageClosure } from "./lib/package-closure.mjs"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaultServerDir = path.join(
  repoRoot,
  "desktop",
  "release",
  "mac-arm64",
  "Copilot API.app",
  "Contents",
  "Resources",
  "server",
)
const sourceServerDir = path.resolve(process.argv[2] ?? defaultServerDir)
const sourcePackageJson = path.join(sourceServerDir, "package.json")

if (!fs.existsSync(sourcePackageJson)) {
  console.error(`Packaged server package.json not found: ${sourcePackageJson}`)
  process.exit(1)
}

const isolatedDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "copilot-api-server-sharp-smoke-"),
)
fs.cpSync(sourceServerDir, isolatedDir, { recursive: true })

const isolatedPackageJson = path.join(isolatedDir, "package.json")
const isolatedNodeModulesRoot = path.join(isolatedDir, "node_modules")

console.log(`isolatedServer=${isolatedDir}`)

try {
  const { packages, skippedOptionalPackages } = collectInstalledPackageClosure({
    entryPackages: ["sharp"],
    nodeModulesRoot: isolatedNodeModulesRoot,
    rootPackageJson: isolatedPackageJson,
  })

  for (const packageInfo of packages) {
    console.log(
      `${packageInfo.name}=${path.join(isolatedNodeModulesRoot, packageInfo.relativePath)}`,
    )
  }
  if (skippedOptionalPackages.length > 0) {
    console.log(
      `skippedOptional=${skippedOptionalPackages
        .map((item) => `${item.name}:${item.reason}`)
        .join(",")}`,
    )
  }
} catch (error) {
  console.error(error)
  console.error("sharpDependencyClosureOk=false")
  process.exit(1)
}

const smokeModulePath = path.join(isolatedDir, "sharp-smoke.mjs")
fs.writeFileSync(
  smokeModulePath,
  `
const sharp = (await import("sharp")).default
const output = await sharp({
  create: {
    width: 8,
    height: 8,
    channels: 3,
    background: "#336699",
  },
}).jpeg({ quality: 70 }).toBuffer()
console.log("sharpImportOk=true")
console.log("jpegBytes=" + output.length)
`,
)

const result = spawnSync(process.execPath, [smokeModulePath], {
  cwd: isolatedDir,
  encoding: "utf8",
})

if (result.stdout) {
  process.stdout.write(result.stdout)
}
if (result.stderr) {
  process.stderr.write(result.stderr)
}
if (result.status !== 0) {
  console.error(`sharpSmokeExit=${result.status}`)
  process.exit(result.status ?? 1)
}
