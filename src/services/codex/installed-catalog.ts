import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
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

function getCodexExecutableCandidates(): Array<string> {
  const home = homedir()
  const candidates: Array<string | undefined> = [
    process.env.COPILOT_API_CODEX_CLI_PATH?.trim(),
    "codex",
    join(home, ".local", "bin", "codex"),
    join(home, ".bun", "bin", "codex"),
  ]

  if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    )
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim()
    const localAppData = process.env.LOCALAPPDATA?.trim()
    const pnpmHome = process.env.PNPM_HOME?.trim()
    const platformPackages = [
      ["codex-win32-x64", "x86_64-pc-windows-msvc"],
      ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
    ] as const

    candidates.push(
      localAppData ?
        join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
      : undefined,
      appData ? join(appData, "npm", "codex.exe") : undefined,
      appData ? join(appData, "npm", "codex.cmd") : undefined,
      pnpmHome ? join(pnpmHome, "codex.exe") : undefined,
      pnpmHome ? join(pnpmHome, "codex.cmd") : undefined,
      join(home, ".bun", "bin", "codex.exe"),
      join(home, ".bun", "bin", "codex.cmd"),
    )

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
        candidates.push(
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

  const models = value.models.filter(
    (model): model is CodexModelInfo =>
      isRecord(model)
      && typeof model.slug === "string"
      && model.slug.trim().length > 0
      && typeof model.base_instructions === "string",
  )

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

async function readInstalledCodexCatalog(
  requestedVersion: string,
): Promise<CodexModelsResponse | null> {
  const installedExecutables = await discoverInstalledCodexExecutables()
  for (const { executable, version } of installedExecutables) {
    if (version !== requestedVersion) {
      continue
    }

    try {
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
