import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { copyPackageClosureToNodeModules } from "../scripts/lib/package-closure.mjs"

/** @type {string[]} */
const tempDirs = []

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-closure-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe("copyPackageClosureToNodeModules", () => {
  test("omits package-manager .bin shims from copied runtime packages", () => {
    const root = makeTempDir()
    const sourcePackageDir = path.join(root, "node_modules", "sharp")
    const sourceBinDir = path.join(sourcePackageDir, "node_modules", ".bin")
    const sourceNestedPackageDir = path.join(
      sourcePackageDir,
      "node_modules",
      "semver",
      "bin",
    )
    const destinationNodeModules = path.join(root, "desktop-node_modules")

    fs.mkdirSync(sourceBinDir, { recursive: true })
    fs.mkdirSync(sourceNestedPackageDir, { recursive: true })
    fs.writeFileSync(
      path.join(sourcePackageDir, "package.json"),
      JSON.stringify({ name: "sharp", version: "0.0.0" }),
    )
    fs.writeFileSync(path.join(sourcePackageDir, "index.js"), "export {}\n")
    fs.writeFileSync(
      path.join(sourceBinDir, "semver"),
      "/Users/runner/work/copilot-api/copilot-api/node_modules/sharp/node_modules/semver/bin/semver.js\n",
    )
    fs.writeFileSync(
      path.join(sourceNestedPackageDir, "semver.js"),
      "console.log('semver')\n",
    )

    copyPackageClosureToNodeModules(
      [
        {
          dir: sourcePackageDir,
          relativePath: "sharp",
        },
      ],
      destinationNodeModules,
    )

    expect(
      fs.existsSync(
        path.join(destinationNodeModules, "sharp", "node_modules", ".bin"),
      ),
    ).toBe(false)
    expect(
      fs.existsSync(path.join(destinationNodeModules, "sharp", "index.js")),
    ).toBe(true)
    expect(
      fs.existsSync(
        path.join(
          destinationNodeModules,
          "sharp",
          "node_modules",
          "semver",
          "bin",
          "semver.js",
        ),
      ),
    ).toBe(true)
  })
})
