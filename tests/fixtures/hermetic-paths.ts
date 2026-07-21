import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const HERMETIC_TEST_ROOT_ENV = "COPILOT_API_TEST_ROOT"

export interface HermeticTestPaths {
  appData: string
  appHome: string
  catalog: string
  codexCredentials: string
  config: string
  database: string
  desktopSettings: string
  deviceId?: string
  githubToken: string
  home: string
  localAppData: string
  logs: string
  pnpmHome: string
  recovery: string
  root: string
  xdgCache: string
  xdgConfig: string
  xdgData: string
}

export interface HermeticSentinel {
  content: string
  path: string
}

export const createHermeticTestPaths = (
  prefix = "copilot-api-test-home-",
): HermeticTestPaths =>
  buildHermeticTestPaths(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

export const buildHermeticTestPaths = (
  root: string,
  platform: NodeJS.Platform = process.platform,
): HermeticTestPaths => {
  const home = path.join(root, "home")
  const appHome = path.join(root, "app-home")
  const xdgCache = path.join(root, "xdg-cache")

  return {
    appData: path.join(root, "app-data"),
    appHome,
    catalog: path.join(appHome, "codex-model-catalog.json"),
    codexCredentials: path.join(appHome, "codex_credentials.json"),
    config: path.join(appHome, "config.json"),
    database: path.join(appHome, "copilot-api.sqlite"),
    desktopSettings: path.join(appHome, "desktop-config.json"),
    deviceId:
      platform === "darwin" ?
        path.join(
          home,
          "Library",
          "Application Support",
          "Microsoft",
          "DeveloperTools",
          "deviceid",
        )
      : platform === "linux" ?
        path.join(xdgCache, "Microsoft", "DeveloperTools", "deviceid")
      : undefined,
    githubToken: path.join(appHome, "github_token"),
    home,
    localAppData: path.join(root, "local-app-data"),
    logs: path.join(appHome, "logs"),
    pnpmHome: path.join(root, "pnpm-home"),
    recovery: path.join(appHome, "reasoning-recovery-cache.json"),
    root,
    xdgCache,
    xdgConfig: path.join(root, "xdg-config"),
    xdgData: path.join(root, "xdg-data"),
  }
}

export const getHermeticTestPaths = (
  env: NodeJS.ProcessEnv = process.env,
): HermeticTestPaths => {
  const root = env[HERMETIC_TEST_ROOT_ENV]
  if (!root) throw new Error(`Missing ${HERMETIC_TEST_ROOT_ENV}`)
  return buildHermeticTestPaths(root)
}

export const createHermeticTestEnvironment = (
  paths: HermeticTestPaths,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...base,
  APPDATA: paths.appData,
  COPILOT_API_CODEX_MODEL_CATALOG_PATH: paths.catalog,
  COPILOT_API_DESKTOP_SETTINGS_PATH: paths.desktopSettings,
  COPILOT_API_HOME: paths.appHome,
  COPILOT_API_LOG_DIR: paths.logs,
  COPILOT_API_SQLITE_DB_PATH: paths.database,
  COPILOT_API_TEST_MODE: "1",
  [HERMETIC_TEST_ROOT_ENV]: paths.root,
  HOME: paths.home,
  LOCALAPPDATA: paths.localAppData,
  PNPM_HOME: paths.pnpmHome,
  USERPROFILE: paths.home,
  XDG_CACHE_HOME: paths.xdgCache,
  XDG_CONFIG_HOME: paths.xdgConfig,
  XDG_DATA_HOME: paths.xdgData,
})

export const applyHermeticTestEnvironment = (
  paths: HermeticTestPaths,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  Object.assign(env, createHermeticTestEnvironment(paths, env))
}

export const isInsideHermeticRoot = (
  root: string,
  candidate: string,
): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
  )
}

export const createHermeticSentinels = (
  paths: HermeticTestPaths,
): Record<string, HermeticSentinel> => {
  const sentinels: Record<string, HermeticSentinel> = {
    catalog: sentinel(paths.catalog, "catalog"),
    codexCredentials: sentinel(paths.codexCredentials, "codex-credentials"),
    config: sentinel(paths.config, "config"),
    database: sentinel(paths.database, "database"),
    desktopSettings: sentinel(paths.desktopSettings, "desktop-settings"),
    githubToken: sentinel(paths.githubToken, "github-token"),
    log: sentinel(path.join(paths.logs, "caller-owned.log"), "log"),
    recovery: sentinel(paths.recovery, "recovery"),
  }
  if (paths.deviceId) {
    sentinels.deviceId = sentinel(paths.deviceId, "device-id")
  }
  return sentinels
}

const sentinel = (filePath: string, name: string): HermeticSentinel => ({
  content: `caller-owned-${name}\n`,
  path: filePath,
})
