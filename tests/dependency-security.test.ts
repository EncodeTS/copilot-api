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
  expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.32.2")
  expect(manifest.dependencies?.hono).toBe("4.12.31")
  expect(manifest.dependencies?.zod).toBe("4.6.7")
  expect(manifest.overrides?.["body-parser"]).toBe("2.4.0")
  expect(manifest.overrides?.["fast-uri"]).toBe("3.1.8")
  expect(manifest.overrides?.hono).toBe("4.12.31")
  expect(manifest.overrides?.["ip-address"]).toBe("10.3.1")
  expect(manifest.overrides?.zod).toBe("4.6.7")
  expect(manifest.dependencies?.undici).toBe("7.30.1")
  expect(manifest.scripts?.["audit:production"]).toBe(
    "bun audit --production --audit-level=high",
  )
  expect(lockfile).toContain(
    '"@modelcontextprotocol/sdk": ["@modelcontextprotocol/sdk@1.32.2"',
  )
  expect(lockfile).toContain('"body-parser": ["body-parser@2.4.0"')
  expect(lockfile).toContain('"fast-uri": ["fast-uri@3.1.8"')
  expect(lockfile).toContain('"hono": ["hono@4.12.31"')
  expect(lockfile).toContain('"ip-address": ["ip-address@10.3.1"')
  expect(lockfile).toContain('"undici": ["undici@7.30.1"')
  expect(lockfile).toContain('"zod": ["zod@4.6.7"')
  expect(lockfile).not.toMatch(
    /"(?:[^"\n]+\/)?@modelcontextprotocol\/sdk": \["@modelcontextprotocol\/sdk@(?!1\.32\.2")/u,
  )
  expect(lockfile).not.toMatch(
    /"(?:[^"\n]+\/)?body-parser": \["body-parser@(?!2\.4\.0")/u,
  )
  expect(lockfile).not.toContain("fast-uri@3.1.2")
  expect(lockfile).not.toMatch(/"fast-uri": \["fast-uri@(?!3\.1\.8)/u)
  expect(lockfile).not.toMatch(/"hono": \["hono@(?!4\.12\.31)/u)
  expect(lockfile).not.toMatch(/"ip-address": \["ip-address@(?!10\.3\.1)/u)
  expect(lockfile).not.toMatch(/"undici": \["undici@(?!7\.30\.1)/u)
  expect(lockfile).not.toMatch(/"(?:[^"\n]+\/)?zod": \["zod@(?!4\.6\.7")/u)
  expect(desktopManifest.packageManager).toBe("bun@1.3.14")
  expect(desktopManifest.overrides?.["fast-uri"]).toBe("3.1.8")
  expect(desktopLockfile).toContain('"fast-uri": ["fast-uri@3.1.8"')
  expect(desktopLockfile).not.toMatch(/"fast-uri": \["fast-uri@(?!3\.1\.8)/u)
  expect(desktopManifest.overrides?.["js-yaml"]).toBe("4.3.2")
  expect(desktopLockfile).toContain('"js-yaml": ["js-yaml@4.3.2"')
  expect(desktopLockfile).not.toMatch(/"js-yaml": \["js-yaml@(?!4\.3\.2)/u)
})
