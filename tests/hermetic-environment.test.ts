import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getHandlerLogDirectory } from "../src/lib/logger"
import { PATHS } from "../src/lib/paths"
import {
  createHermeticSentinels,
  createHermeticTestEnvironment,
  createHermeticTestPaths,
  getHermeticTestPaths,
  isInsideHermeticRoot,
  type HermeticSentinel,
} from "./fixtures/hermetic-paths"

interface HermeticProbeResult {
  createdFiles: Array<string>
  deviceId?: string
  root: string
}

test("Bun tests keep persistent and platform state in one isolated root", () => {
  const paths = getHermeticTestPaths()

  expect(path.resolve(paths.root)).toStartWith(path.resolve(os.tmpdir()))
  expect(PATHS.APP_DIR).toBe(paths.appHome)
  expect(PATHS.CONFIG_PATH).toBe(paths.config)
  expect(PATHS.CODEX_MODEL_CATALOG_PATH).toBe(paths.catalog)
  expect(PATHS.REASONING_RECOVERY_PATH).toBe(paths.recovery)
  expect(getHandlerLogDirectory()).toBe(paths.logs)
})

test("hermetic test environments clear caller auth-routing overrides", () => {
  const paths = createHermeticTestPaths("copilot-api-hostile-env-")
  try {
    const environment = createHermeticTestEnvironment(paths, {
      COPILOT_API_ENTERPRISE_URL: "https://example.invalid",
      COPILOT_API_OAUTH_APP: "opencode",
    })
    expect(environment.COPILOT_API_ENTERPRISE_URL).toBe("")
    expect(environment.COPILOT_API_OAUTH_APP).toBe("")
  } finally {
    fs.rmSync(paths.root, { force: true, recursive: true })
  }
})

test("a caller-owned application and device-id home remains untouched", () => {
  const callerPaths = createHermeticTestPaths("copilot-api-caller-home-")
  const sentinels = createHermeticSentinels(callerPaths)
  writeSentinels(sentinels)
  const before = snapshotSentinels(sentinels)
  const entriesBefore = snapshotEntries(callerPaths.root)

  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--preload",
        "./tests/preload.ts",
        "./tests/fixtures/hermetic-state-probe.ts",
      ],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...createHermeticTestEnvironment(callerPaths),
        COPILOT_API_CALLER_ROOT: callerPaths.root,
      },
    })

    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)
    if (result.exitCode !== 0) {
      throw new Error(
        `Hermetic probe failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }

    const probe = JSON.parse(stdout) as HermeticProbeResult
    expect(probe.root).not.toBe(callerPaths.root)
    expect(probe.createdFiles.length).toBeGreaterThanOrEqual(4)
    expect(
      probe.createdFiles.every((file) =>
        isInsideHermeticRoot(probe.root, file),
      ),
    ).toBe(true)
    if (callerPaths.deviceId) {
      expect(probe.deviceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(probe.deviceId).not.toBe(sentinels.deviceId?.content.trim())
    }

    expect(snapshotSentinels(sentinels)).toEqual(before)
    expect(snapshotEntries(callerPaths.root)).toEqual(entriesBefore)
  } finally {
    fs.rmSync(callerPaths.root, { force: true, recursive: true })
  }
})

function snapshotEntries(root: string): Array<string> {
  return fs
    .readdirSync(root, { recursive: true })
    .map((entry) => entry.toString())
    .sort()
}

function snapshotSentinels(
  sentinels: Record<string, HermeticSentinel>,
): Record<
  string,
  { content: string; mode: number; modifiedAt: number; size: number }
> {
  return Object.fromEntries(
    Object.entries(sentinels).map(([name, sentinel]) => {
      const stats = fs.statSync(sentinel.path)
      return [
        name,
        {
          content: fs.readFileSync(sentinel.path, "utf8"),
          mode: stats.mode & 0o777,
          modifiedAt: stats.mtimeMs,
          size: stats.size,
        },
      ]
    }),
  )
}

function writeSentinels(sentinels: Record<string, HermeticSentinel>): void {
  for (const sentinel of Object.values(sentinels)) {
    fs.mkdirSync(path.dirname(sentinel.path), { recursive: true })
    fs.writeFileSync(sentinel.path, sentinel.content, { mode: 0o600 })
  }
}
