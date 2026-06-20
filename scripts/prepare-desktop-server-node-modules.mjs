#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  collectInstalledPackageClosure,
  copyPackageClosureToNodeModules,
  writePackageClosureManifest,
} from "./lib/package-closure.mjs"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entryPackages = ["sharp"]
const rootPackageJson = path.join(repoRoot, "package.json")
const nodeModulesRoot = path.join(repoRoot, "node_modules")
const desktopBuildDir = path.join(repoRoot, "desktop", "build")
const destinationNodeModules = path.join(desktopBuildDir, "server-node_modules")
const manifestPath = path.join(
  desktopBuildDir,
  "server-node_modules.manifest.json",
)

if (!fs.existsSync(path.join(nodeModulesRoot, "sharp"))) {
  console.error(
    `Cannot package sharp for desktop: ${path.join(nodeModulesRoot, "sharp")} does not exist. Run bun install first.`,
  )
  process.exit(1)
}

const { packages, skippedOptionalPackages } = collectInstalledPackageClosure({
  entryPackages,
  nodeModulesRoot,
  rootPackageJson,
})

copyPackageClosureToNodeModules(packages, destinationNodeModules)
writePackageClosureManifest({
  destination: manifestPath,
  entryPackages,
  packages,
  skippedOptionalPackages,
})

console.log(
  `desktopServerNodeModules=${path.relative(repoRoot, destinationNodeModules)}`,
)
console.log(
  `desktopServerNodeModulesPackages=${packages.map((item) => item.name).join(",")}`,
)
if (skippedOptionalPackages.length > 0) {
  console.log(
    `desktopServerNodeModulesSkippedOptional=${skippedOptionalPackages
      .map((item) => `${item.name}:${item.reason}`)
      .join(",")}`,
  )
}
