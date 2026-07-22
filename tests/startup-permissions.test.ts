import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ensurePaths, PATHS } from "~/lib/paths"

const tempDirectories: Array<string> = []
const decoder = new TextDecoder()

afterEach(() => {
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

test("startup repairs every known sensitive state path without creating optional state", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-startup-mode-"),
  )
  tempDirectories.push(root)
  const appHome = path.join(root, "app")
  const desktopSettings = path.join(root, "desktop-config.json")
  const database = path.join(appHome, "copilot-api.sqlite")
  fs.mkdirSync(path.join(appHome, "default"), { recursive: true, mode: 0o755 })
  fs.chmodSync(appHome, 0o755)

  const existingSensitiveFiles = [
    path.join(appHome, "config.json"),
    path.join(appHome, "config.json.bak"),
    path.join(appHome, "default", "github_token"),
    path.join(appHome, "codex_credentials.json"),
    path.join(appHome, "codex_credentials.json.bak"),
    path.join(appHome, "codex-model-catalog.json"),
    path.join(appHome, "reasoning-recovery-cache.json"),
    database,
    `${database}-wal`,
    `${database}-shm`,
    desktopSettings,
    `${desktopSettings}.bak`,
  ]
  for (const filePath of existingSensitiveFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "fixture", { mode: 0o644 })
    fs.chmodSync(filePath, 0o644)
  }

  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      'const fs = await import("node:fs"); const path = await import("node:path"); const { ensurePaths, PATHS } = await import("./src/lib/paths"); await ensurePaths(); const files = PATHS.knownSensitiveFiles(); console.log(JSON.stringify({ appMode: fs.statSync(PATHS.APP_DIR).mode & 0o777, authMode: fs.statSync(path.dirname(PATHS.GITHUB_TOKEN_PATH)).mode & 0o777, fileModes: files.filter((file) => fs.existsSync(file)).map((file) => [file, fs.statSync(file).mode & 0o777]), files }));',
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      COPILOT_API_HOME: appHome,
      COPILOT_API_OAUTH_APP: "default",
      COPILOT_API_DESKTOP_SETTINGS_PATH: desktopSettings,
      COPILOT_API_SQLITE_DB_PATH: database,
    },
  })

  const stderr = decoder.decode(result.stderr)
  const stdout = decoder.decode(result.stdout).trim()
  if (result.exitCode !== 0) {
    throw new Error(
      `startup repair failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
  const repaired = JSON.parse(stdout) as {
    appMode: number
    authMode: number
    fileModes: Array<[string, number]>
    files: Array<string>
  }

  if (process.platform !== "win32") {
    expect(repaired.appMode).toBe(0o700)
    expect(repaired.authMode).toBe(0o700)
    expect(repaired.fileModes.every(([, fileMode]) => fileMode === 0o600)).toBe(
      true,
    )
  }
  expect(repaired.files).toContain(`${database}-wal`)
  expect(repaired.files).toContain(`${database}-shm`)
  expect(
    fs.existsSync(path.join(appHome, "reasoning-recovery-cache.json.bak")),
  ).toBe(false)
})

test("Desktop settings writes are atomic and private", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-settings-mode-"),
  )
  tempDirectories.push(root)
  const settingsPath = path.join(root, "state", "desktop-config.json")
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      'const fs = await import("node:fs"); const path = await import("node:path"); const store = await import("./desktop/electron/settings-store"); const settings = store.normalizeSettings({ lastPort: 5151 }); await store.writeSettings(settings); await store.writeSettings({ ...settings, lastPort: 5252 }); console.log(JSON.stringify({ content: JSON.parse(fs.readFileSync(process.env.COPILOT_API_DESKTOP_SETTINGS_PATH, "utf8")), directoryMode: fs.statSync(path.dirname(process.env.COPILOT_API_DESKTOP_SETTINGS_PATH)).mode & 0o777, fileMode: fs.statSync(process.env.COPILOT_API_DESKTOP_SETTINGS_PATH).mode & 0o777, temporaryFiles: fs.readdirSync(path.dirname(process.env.COPILOT_API_DESKTOP_SETTINGS_PATH)).filter((entry) => entry.endsWith(".tmp")) }));',
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      COPILOT_API_DESKTOP_SETTINGS_PATH: settingsPath,
    },
  })
  const stdout = decoder.decode(result.stdout).trim()
  const stderr = decoder.decode(result.stderr)
  if (result.exitCode !== 0) {
    throw new Error(
      `settings write failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
  const output = JSON.parse(stdout) as {
    content: { lastPort?: number }
    directoryMode: number
    fileMode: number
    temporaryFiles: Array<string>
  }
  expect(output.content.lastPort).toBe(5252)
  expect(output.temporaryFiles).toEqual([])
  if (process.platform !== "win32") {
    expect(output.directoryMode).toBe(0o700)
    expect(output.fileMode).toBe(0o600)
  }
})

test("known sensitive path inventory follows the active SQLite override", async () => {
  const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH
  const database = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-path-inventory-")),
    "custom.sqlite",
  )
  tempDirectories.push(path.dirname(database))
  process.env.COPILOT_API_SQLITE_DB_PATH = database

  try {
    const sensitiveFiles = PATHS.knownSensitiveFiles()
    expect(PATHS.getTokenUsageDbPath()).toBe(database)
    expect(sensitiveFiles).toContain(database)
    expect(sensitiveFiles).toContain(`${database}-wal`)
    expect(sensitiveFiles).toContain(`${database}-shm`)
    expect(sensitiveFiles).toContain(`${database}.bak`)
    expect(sensitiveFiles).toContain(`${PATHS.CONFIG_PATH}.backup`)

    await ensurePaths()
    if (process.platform !== "win32") {
      expect(fs.statSync(PATHS.APP_DIR).mode & 0o777).toBe(0o700)
      expect(fs.statSync(PATHS.CONFIG_PATH).mode & 0o777).toBe(0o600)
    }
  } finally {
    if (originalDbPath === undefined)
      delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
  }
})
