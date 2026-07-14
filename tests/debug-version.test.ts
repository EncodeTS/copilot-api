import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { resolvePackageVersion } from "../src/debug"

const tempDirs: Array<string> = []

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-version-"))
  tempDirs.push(dir)
  return dir
}

const writePackageVersion = (dir: string, version: string): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ version })}\n`,
  )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { force: true, recursive: true })
  }
})

test("resolves the package version beside a packaged server bundle", async () => {
  const root = createTempDir()
  const serverDir = path.join(root, "server")
  writePackageVersion(root, "parent-version")
  writePackageVersion(serverDir, "packaged-version")

  const entryUrl = pathToFileURL(path.join(serverDir, "main.js"))
  expect(await resolvePackageVersion(entryUrl)).toBe("packaged-version")
})

test("falls back to the parent package during source development", async () => {
  const root = createTempDir()
  const sourceDir = path.join(root, "src")
  fs.mkdirSync(sourceDir)
  writePackageVersion(root, "source-version")

  const entryUrl = pathToFileURL(path.join(sourceDir, "debug.ts"))
  expect(await resolvePackageVersion(entryUrl)).toBe("source-version")
})

test("keeps the packaged server manifest version synchronized", () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
  const serverPackage = JSON.parse(
    fs.readFileSync(
      new URL("../desktop/build/server-package.json", import.meta.url),
      "utf8",
    ),
  ) as { version?: string }

  expect(serverPackage.version).toBe(rootPackage.version)
})
