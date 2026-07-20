import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, extname, join } from "node:path"
import { promisify } from "node:util"

import {
  normalizeCodexVersion,
  parseInstalledCodexVersion,
} from "~/services/codex/version"

const execFileAsync = promisify(execFile)

const CODEX_COMMAND_TIMEOUT_MS = 5_000
const CODEX_COMMAND_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const CODEX_CATALOG_CACHE_MS = 30 * 60 * 1000
const CODEX_CATALOG_NEGATIVE_CACHE_MS = 60 * 1000
const CODEX_CATALOG_CACHE_MAX_ENTRIES = 64
const CODEX_EXECUTABLE_DISCOVERY_CACHE_MS = 60 * 1000
const CODEX_APP_VERSIONED_EXECUTABLE_LIMIT = 8
const CODEX_APP_VERSION_DIRECTORY_PATTERN = /^[0-9a-f]{16}$/iu
const WINDOWS_CMD_UNSAFE_PATTERN = /[\r\n"&|<>^%!]/u
const WINDOWS_CMD_ARGUMENT_PATTERN = /^[0-9A-Za-z-]+$/u

export interface CodexModelInfo extends Record<string, unknown> {
  slug: string
}

export interface CodexModelsResponse {
  models: Array<CodexModelInfo>
}

interface CachedCatalog {
  expiresAt: number
  promise: Promise<CodexModelsResponse | null>
}

interface InstalledCodexExecutable {
  executable: string
  version: string
}

interface CachedExecutableDiscovery {
  expiresAt: number
  promise: Promise<Array<InstalledCodexExecutable>>
}

interface CodexCommandInvocation {
  executable: string
  args: Array<string>
  windowsVerbatimArguments: boolean
}

interface CodexExecutableCandidateOptions {
  environment?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
}

class CodexCatalogCache {
  readonly #entries = new Map<string, CachedCatalog>()

  get(version: string, now: number): CachedCatalog | undefined {
    const cached = this.#entries.get(version)
    if (!cached) {
      return undefined
    }
    if (cached.expiresAt <= now) {
      this.#entries.delete(version)
      return undefined
    }

    this.#entries.delete(version)
    this.#entries.set(version, cached)
    return cached
  }

  set(version: string, catalog: CachedCatalog): void {
    this.#entries.delete(version)
    this.#entries.set(version, catalog)
    while (this.#entries.size > CODEX_CATALOG_CACHE_MAX_ENTRIES) {
      const oldestVersion = this.#entries.keys().next().value
      if (typeof oldestVersion !== "string") {
        return
      }
      this.#entries.delete(oldestVersion)
    }
  }

  clear(): void {
    this.#entries.clear()
  }
}

const catalogCache = new CodexCatalogCache()
let executableDiscoveryCache: CachedExecutableDiscovery | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getVersionedCodexAppExecutables(binDirectory: string): Array<string> {
  try {
    return readdirSync(binDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory()
          && CODEX_APP_VERSION_DIRECTORY_PATTERN.test(entry.name),
      )
      .flatMap((entry) => {
        const executable = join(binDirectory, entry.name, "codex.exe")
        try {
          const modifiedAt = statSync(executable).mtimeMs
          return [{ executable, modifiedAt }]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, CODEX_APP_VERSIONED_EXECUTABLE_LIMIT)
      .map(({ executable }) => executable)
  } catch {
    return []
  }
}

function getCodexExecutableCandidates({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
}: CodexExecutableCandidateOptions = {}): Array<string> {
  const candidates: Array<string | undefined> = [
    environment.COPILOT_API_CODEX_CLI_PATH?.trim(),
  ]

  if (platform !== "win32") {
    candidates.push(
      "codex",
      join(home, ".local", "bin", "codex"),
      join(home, ".bun", "bin", "codex"),
    )
  }

  if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    )
  }

  if (platform === "win32") {
    const appData = environment.APPDATA?.trim()
    const localAppData = environment.LOCALAPPDATA?.trim()
    const pnpmHome = environment.PNPM_HOME?.trim()
    const codexAppBin =
      localAppData ? join(localAppData, "OpenAI", "Codex", "bin") : undefined
    const platformPackages = [
      ["codex-win32-x64", "x86_64-pc-windows-msvc"],
      ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
    ] as const
    const nativeCandidates: Array<string | undefined> = [
      "codex.exe",
      localAppData ?
        join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
      : undefined,
      codexAppBin ? join(codexAppBin, "codex.exe") : undefined,
      ...(codexAppBin ? getVersionedCodexAppExecutables(codexAppBin) : []),
      appData ? join(appData, "npm", "codex.exe") : undefined,
      pnpmHome ? join(pnpmHome, "codex.exe") : undefined,
      join(home, ".bun", "bin", "codex.exe"),
    ]

    if (appData) {
      for (const [packageName, target] of platformPackages) {
        const nativePath = [
          "@openai",
          packageName,
          "vendor",
          target,
          "bin",
          "codex.exe",
        ]
        nativeCandidates.push(
          join(
            appData,
            "npm",
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            ...nativePath,
          ),
          join(appData, "npm", "node_modules", ...nativePath),
        )
      }
    }

    candidates.push(
      ...nativeCandidates,
      "codex.cmd",
      appData ? join(appData, "npm", "codex.cmd") : undefined,
      pnpmHome ? join(pnpmHome, "codex.cmd") : undefined,
      join(home, ".bun", "bin", "codex.cmd"),
      "codex",
      join(home, ".local", "bin", "codex"),
      join(home, ".bun", "bin", "codex"),
    )
  }

  return [
    ...new Set(
      candidates.filter((candidate): candidate is string => Boolean(candidate)),
    ),
  ]
}

function resolveWindowsPathCommand(executable: string): string {
  if (
    process.platform !== "win32"
    || executable.includes("\\")
    || executable.includes("/")
  ) {
    return executable
  }

  const extensions =
    extname(executable) ?
      [""]
    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension)

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const normalizedDirectory = directory.trim().replace(/^"|"$/gu, "")
    if (!normalizedDirectory) {
      continue
    }

    for (const extension of extensions) {
      const candidate = join(normalizedDirectory, `${executable}${extension}`)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }

  return executable
}

function createWindowsCmdInvocation(
  executable: string,
  args: Array<string>,
): CodexCommandInvocation {
  if (
    WINDOWS_CMD_UNSAFE_PATTERN.test(executable)
    || args.some((arg) => !WINDOWS_CMD_ARGUMENT_PATTERN.test(arg))
  ) {
    throw new Error("Unsafe Windows command path or argument")
  }

  return {
    executable: process.env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", `""${executable}" ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
  }
}

async function runCodexCommand(
  executable: string,
  args: Array<string>,
): Promise<string> {
  const resolvedExecutable = resolveWindowsPathCommand(executable)
  const invocation =
    (
      process.platform === "win32"
      && [".bat", ".cmd"].includes(extname(resolvedExecutable).toLowerCase())
    ) ?
      createWindowsCmdInvocation(resolvedExecutable, args)
    : {
        executable: resolvedExecutable,
        args,
        windowsVerbatimArguments: false,
      }
  const { stdout } = await execFileAsync(
    invocation.executable,
    invocation.args,
    {
      encoding: "utf8",
      maxBuffer: CODEX_COMMAND_MAX_BUFFER_BYTES,
      timeout: CODEX_COMMAND_TIMEOUT_MS,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  )
  return stdout
}

export const codexCatalogLoaderDependencies = {
  getExecutableCandidates: getCodexExecutableCandidates,
  runCommand: runCodexCommand,
}

function parseCodexModelsOutput(output: string): CodexModelsResponse | null {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return null
  }

  if (!isRecord(value) || !Array.isArray(value.models)) {
    return null
  }

  const models: Array<CodexModelInfo> = []
  for (const model of value.models) {
    if (
      !isRecord(model)
      || typeof model.slug !== "string"
      || model.slug.trim().length === 0
      || typeof model.base_instructions !== "string"
    ) {
      return null
    }
    const parsedModel = model as CodexModelInfo
    models.push({
      ...parsedModel,
      // Newer bundled catalogs can omit this legacy field, while older Codex
      // clients still require it when parsing model_catalog_json.
      supports_reasoning_summaries:
        typeof parsedModel.supports_reasoning_summaries === "boolean" ?
          parsedModel.supports_reasoning_summaries
        : true,
    })
  }

  return models.length > 0 ? { models } : null
}

async function discoverInstalledCodexExecutables(): Promise<
  Array<InstalledCodexExecutable>
> {
  const now = Date.now()
  if (executableDiscoveryCache && executableDiscoveryCache.expiresAt > now) {
    return await executableDiscoveryCache.promise
  }

  const promise = Promise.all(
    codexCatalogLoaderDependencies
      .getExecutableCandidates()
      .map(async (executable): Promise<InstalledCodexExecutable | null> => {
        try {
          const version = parseInstalledCodexVersion(
            await codexCatalogLoaderDependencies.runCommand(executable, [
              "--version",
            ]),
          )
          return version ? { executable, version } : null
        } catch {
          return null
        }
      }),
  ).then((executables) =>
    executables.filter(
      (executable): executable is InstalledCodexExecutable =>
        executable !== null,
    ),
  )

  executableDiscoveryCache = {
    expiresAt: now + CODEX_EXECUTABLE_DISCOVERY_CACHE_MS,
    promise,
  }
  return await promise
}

export async function listInstalledCodexVersions(): Promise<Array<string>> {
  const installedExecutables = await discoverInstalledCodexExecutables()
  return [...new Set(installedExecutables.map(({ version }) => version))]
}

async function readInstalledCodexCatalog(
  requestedVersion: string,
): Promise<CodexModelsResponse | null> {
  const installedExecutables = await discoverInstalledCodexExecutables()
  for (const { executable, version } of installedExecutables) {
    if (version !== requestedVersion) {
      continue
    }

    try {
      const currentVersion = parseInstalledCodexVersion(
        await codexCatalogLoaderDependencies.runCommand(executable, [
          "--version",
        ]),
      )
      if (currentVersion !== requestedVersion) {
        continue
      }

      const catalog = parseCodexModelsOutput(
        await codexCatalogLoaderDependencies.runCommand(executable, [
          "debug",
          "models",
          "--bundled",
        ]),
      )
      if (catalog) {
        return catalog
      }
    } catch {
      continue
    }
  }

  return null
}

export async function loadInstalledCodexCatalog(
  requestedVersion: string,
): Promise<CodexModelsResponse | null> {
  const normalizedVersion = normalizeCodexVersion(requestedVersion)
  if (!normalizedVersion) {
    return null
  }

  const now = Date.now()
  const cached = catalogCache.get(normalizedVersion, now)
  if (cached) {
    return await cached.promise
  }

  const promise = readInstalledCodexCatalog(normalizedVersion)
  const cacheEntry = {
    expiresAt: now + CODEX_CATALOG_NEGATIVE_CACHE_MS,
    promise,
  }
  catalogCache.set(normalizedVersion, cacheEntry)
  void promise.then((catalog) => {
    cacheEntry.expiresAt =
      Date.now()
      + (catalog ? CODEX_CATALOG_CACHE_MS : CODEX_CATALOG_NEGATIVE_CACHE_MS)
  })
  return await promise
}

export function clearCodexCatalogCache(): void {
  catalogCache.clear()
  executableDiscoveryCache = null
}
