import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import type { Model } from "~/services/copilot/get-models"

const execFileAsync = promisify(execFile)

const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const CODEX_USER_AGENT_VERSION_PATTERN =
  /\bcodex(?:[-_\s][^/]*)?\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const CODEX_VERSION_OUTPUT_PATTERN =
  /\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const CODEX_COMMAND_TIMEOUT_MS = 5_000
const CODEX_COMMAND_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const CODEX_CATALOG_CACHE_MS = 30 * 60 * 1000
const CODEX_CATALOG_NEGATIVE_CACHE_MS = 60 * 1000
const CODEX_AUTO_COMPACT_RATIO = 0.9
// Codex checks the existing context before adding the next turn, so leave room
// below the upstream prompt cap for one moderate user/tool payload.
const CODEX_AUTO_COMPACT_HEADROOM_TOKENS = 32_000

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

const catalogCache = new Map<string, CachedCatalog>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ?
      value
    : undefined
}

function normalizeVersion(value: string | null | undefined): string | null {
  const version = value?.trim() ?? ""
  return CODEX_VERSION_PATTERN.test(version) ? version : null
}

export function getCodexClientVersion(
  requestUrl: string,
  userAgent: string | undefined,
): string | null {
  const urlVersion = normalizeVersion(
    new URL(requestUrl, "http://localhost").searchParams.get("client_version"),
  )
  if (urlVersion) {
    return urlVersion
  }

  return normalizeVersion(
    userAgent?.match(CODEX_USER_AGENT_VERSION_PATTERN)?.[1],
  )
}

export function isCodexClientUserAgent(userAgent: string | undefined): boolean {
  return /^codex/iu.test(userAgent?.trim() ?? "")
}

function getCodexExecutableCandidates(): Array<string> {
  const candidates = [
    process.env.COPILOT_API_CODEX_CLI_PATH?.trim(),
    "codex",
    join(homedir(), ".local", "bin", "codex"),
    join(homedir(), ".bun", "bin", "codex"),
  ]

  if (process.platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    )
  }

  return [
    ...new Set(candidates.filter((candidate) => candidate)),
  ] as Array<string>
}

async function runCodexCommand(
  executable: string,
  args: Array<string>,
): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer: CODEX_COMMAND_MAX_BUFFER_BYTES,
    timeout: CODEX_COMMAND_TIMEOUT_MS,
  })
  return stdout
}

export const codexCatalogLoaderDependencies = {
  getExecutableCandidates: getCodexExecutableCandidates,
  runCommand: runCodexCommand,
}

function parseCodexVersionOutput(output: string): string | null {
  return normalizeVersion(output.match(CODEX_VERSION_OUTPUT_PATTERN)?.[1])
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

async function readInstalledCodexCatalog(
  requestedVersion: string,
): Promise<CodexModelsResponse | null> {
  for (const executable of codexCatalogLoaderDependencies.getExecutableCandidates()) {
    try {
      const installedVersion = parseCodexVersionOutput(
        await codexCatalogLoaderDependencies.runCommand(executable, [
          "--version",
        ]),
      )
      if (installedVersion !== requestedVersion) {
        continue
      }

      return parseCodexModelsOutput(
        await codexCatalogLoaderDependencies.runCommand(executable, [
          "debug",
          "models",
          "--bundled",
        ]),
      )
    } catch {
      continue
    }
  }

  return null
}

export async function loadInstalledCodexCatalog(
  requestedVersion: string,
): Promise<CodexModelsResponse | null> {
  const now = Date.now()
  const cached = catalogCache.get(requestedVersion)
  if (cached && cached.expiresAt > now) {
    return await cached.promise
  }

  const promise = readInstalledCodexCatalog(requestedVersion)
  const cacheEntry = {
    expiresAt: now + CODEX_CATALOG_NEGATIVE_CACHE_MS,
    promise,
  }
  catalogCache.set(requestedVersion, cacheEntry)
  void promise.then((catalog) => {
    cacheEntry.expiresAt =
      Date.now()
      + (catalog ? CODEX_CATALOG_CACHE_MS : CODEX_CATALOG_NEGATIVE_CACHE_MS)
  })
  return await promise
}

export const codexClientModelsDependencies = {
  loadBundledCatalog: loadInstalledCodexCatalog,
}

function supportsResponses(model: Model): boolean {
  return (
    model.supported_endpoints?.some(
      (endpoint) => endpoint === "/responses" || endpoint === "/v1/responses",
    ) ?? false
  )
}

function resolveAutoCompactTokenLimit(
  model: Model,
  contextWindow: number,
): number {
  const limits = model.capabilities.limits
  const outputTokens = asPositiveInteger(limits.max_output_tokens) ?? 0
  const promptTokens =
    asPositiveInteger(limits.max_prompt_tokens)
    ?? Math.max(1, contextWindow - outputTokens)
  const contextRatioLimit = Math.floor(contextWindow * CODEX_AUTO_COMPACT_RATIO)
  const promptHeadroomLimit = Math.max(
    1,
    promptTokens - CODEX_AUTO_COMPACT_HEADROOM_TOKENS,
  )

  return Math.min(contextRatioLimit, promptHeadroomLimit)
}

function applyCopilotCapabilities(
  template: CodexModelInfo,
  copilotModel: Model,
): CodexModelInfo {
  const contextWindow = asPositiveInteger(
    copilotModel.capabilities.limits.max_context_window_tokens,
  )
  if (!contextWindow) {
    return { ...template }
  }

  return {
    ...template,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: resolveAutoCompactTokenLimit(
      copilotModel,
      contextWindow,
    ),
  }
}

export async function createCodexModelsResponse(
  clientVersion: string | null,
  copilotModels: Array<Model>,
): Promise<CodexModelsResponse> {
  if (!clientVersion) {
    return { models: [] }
  }

  const catalog =
    await codexClientModelsDependencies.loadBundledCatalog(clientVersion)
  if (!catalog) {
    return { models: [] }
  }

  const copilotModelsById = new Map(
    copilotModels
      .filter((model) => model.model_picker_enabled && supportsResponses(model))
      .map((model) => [model.id, model]),
  )

  return {
    models: catalog.models.flatMap((template) => {
      const copilotModel = copilotModelsById.get(template.slug)
      return copilotModel ?
          [applyCopilotCapabilities(template, copilotModel)]
        : []
    }),
  }
}

export function clearCodexCatalogCache(): void {
  catalogCache.clear()
}
