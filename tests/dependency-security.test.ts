import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

interface PackageManifest {
  dependencies?: Record<string, string>
  overrides?: Record<string, string>
  packageManager?: string
  scripts?: Record<string, string>
}

test("security-sensitive runtime dependencies stay pinned to audited versions", () => {
  const root = path.resolve(import.meta.dir, "..")
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as PackageManifest
  const lockfile = fs.readFileSync(path.join(root, "bun.lock"), "utf8")
  const desktopManifest = JSON.parse(
    fs.readFileSync(path.join(root, "desktop", "package.json"), "utf8"),
  ) as PackageManifest
  const desktopLockfile = fs.readFileSync(
    path.join(root, "desktop", "bun.lock"),
    "utf8",
  )

  expect(manifest.packageManager).toBe("bun@1.3.14")
  expect(manifest.dependencies?.hono).toBe("4.12.31")
  expect(manifest.overrides?.hono).toBe("4.12.31")
  expect(manifest.dependencies?.undici).toBe("7.28.0")
  expect(manifest.scripts?.["audit:production"]).toBe(
    "bun audit --production --audit-level=high",
  )
  expect(lockfile).toContain('"hono": ["hono@4.12.31"')
  expect(lockfile).toContain('"undici": ["undici@7.28.0"')
  expect(lockfile).not.toMatch(/"hono": \["hono@(?!4\.12\.31)/u)
  expect(lockfile).not.toMatch(/"undici": \["undici@(?!7\.28\.0)/u)
  expect(desktopManifest.packageManager).toBe("bun@1.3.14")
  expect(desktopManifest.overrides?.["js-yaml"]).toBe("4.3.0")
  expect(desktopLockfile).toContain('"js-yaml": ["js-yaml@4.3.0"')
})
