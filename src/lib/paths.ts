import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  repairPrivateFile,
  supportsPosixPermissionModes,
} from "./file-protection"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")
const APP_DIR = process.env.COPILOT_API_HOME || DEFAULT_DIR

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
const CODEX_CREDENTIAL_PATH = path.join(APP_DIR, "codex_credentials.json")
const CONFIG_PATH = path.join(APP_DIR, "config.json")
const REASONING_RECOVERY_PATH = path.join(
  APP_DIR,
  "reasoning-recovery-cache.json",
)
const CODEX_MODEL_CATALOG_PATH =
  process.env.COPILOT_API_CODEX_MODEL_CATALOG_PATH?.trim()
  || path.join(APP_DIR, "codex-model-catalog.json")
const DESKTOP_SETTINGS_PATH =
  process.env.COPILOT_API_DESKTOP_SETTINGS_PATH?.trim()
  || path.join(DEFAULT_DIR, "desktop-config.json")
const getTokenUsageDbPath = (): string =>
  process.env.COPILOT_API_SQLITE_DB_PATH?.trim()
  || path.join(APP_DIR, "copilot-api.sqlite")

const knownBackups = (filePath: string): Array<string> => [
  `${filePath}.bak`,
  `${filePath}.backup`,
]

const knownSensitiveFiles = (): Array<string> => {
  const tokenUsageDbPath = getTokenUsageDbPath()
  return [
    GITHUB_TOKEN_PATH,
    CODEX_CREDENTIAL_PATH,
    CONFIG_PATH,
    CODEX_MODEL_CATALOG_PATH,
    REASONING_RECOVERY_PATH,
    DESKTOP_SETTINGS_PATH,
    tokenUsageDbPath,
    `${tokenUsageDbPath}-wal`,
    `${tokenUsageDbPath}-shm`,
    ...knownBackups(GITHUB_TOKEN_PATH),
    ...knownBackups(CODEX_CREDENTIAL_PATH),
    ...knownBackups(CONFIG_PATH),
    ...knownBackups(CODEX_MODEL_CATALOG_PATH),
    ...knownBackups(REASONING_RECOVERY_PATH),
    ...knownBackups(DESKTOP_SETTINGS_PATH),
    ...knownBackups(tokenUsageDbPath),
  ]
}

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CODEX_CREDENTIAL_PATH,
  CONFIG_PATH,
  CODEX_MODEL_CATALOG_PATH,
  REASONING_RECOVERY_PATH,
  DESKTOP_SETTINGS_PATH,
  getTokenUsageDbPath,
  knownSensitiveFiles,
}

export async function ensurePaths(): Promise<void> {
  await ensurePrivateDirectory(PATHS.APP_DIR)
  await ensurePrivateDirectory(path.join(PATHS.APP_DIR, AUTH_APP))
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
  await Promise.all(PATHS.knownSensitiveFiles().map(repairPrivateFile))
}

async function ensureFile(filePath: string): Promise<void> {
  if (await repairPrivateFile(filePath)) return
  const handle = await fs.open(filePath, "wx", PRIVATE_FILE_MODE)
  await handle.close()
  if (supportsPosixPermissionModes()) {
    await fs.chmod(filePath, PRIVATE_FILE_MODE)
  }
}
