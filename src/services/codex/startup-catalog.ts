import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import consola from "consola"

import { createCodexModelsResponse } from "~/services/codex/client-models"
import {
  listInstalledCodexVersions,
  type CodexModelsResponse,
} from "~/services/codex/installed-catalog"
import { normalizeCodexVersion } from "~/services/codex/version"
import type { Model } from "~/services/copilot/get-models"
import { PATHS } from "~/lib/paths"

export type CodexStartupCatalogUpdateResult =
  | {
      clientVersion: string
      modelCount: number
      path: string
      status: "unchanged" | "updated"
    }
  | {
      clientVersion: string
      path: string
      reason: "older_client_version"
      status: "skipped"
    }
  | {
      path: string
      reason:
        | "invalid_catalog"
        | "invalid_client_version"
        | "no_installed_client"
        | "no_valid_catalog"
      status: "skipped"
    }

export interface CodexStartupCatalogManager {
  createResponse: typeof createCodexModelsResponse
  refresh: (
    copilotModels: Array<Model>,
  ) => Promise<CodexStartupCatalogUpdateResult>
}

type ObserveCodexStartupCatalog = (
  clientVersion: string,
  catalog: CodexModelsResponse,
) => Promise<CodexStartupCatalogUpdateResult>

interface PersistedCodexStartupCatalog extends CodexModelsResponse {
  _copilot_api: {
    client_version: string
    generated_at: string
  }
}

export const createCodexStartupCatalogManager = ({
  catalogPath,
  createModelsResponse = createCodexModelsResponse,
  listInstalledVersions = listInstalledCodexVersions,
  writeAtomically = writeFileAtomically,
}: {
  catalogPath: string
  createModelsResponse?: typeof createCodexModelsResponse
  listInstalledVersions?: typeof listInstalledCodexVersions
  writeAtomically?: typeof writeFileAtomically
}): CodexStartupCatalogManager => {
  const observe: ObserveCodexStartupCatalog = async (
    clientVersion,
    catalog,
  ) => {
    const normalizedVersion = normalizeCodexVersion(clientVersion)
    if (!normalizedVersion) {
      return {
        path: catalogPath,
        reason: "invalid_client_version",
        status: "skipped",
      }
    }
    if (!isValidCodexStartupCatalog(catalog)) {
      return {
        path: catalogPath,
        reason: "invalid_catalog",
        status: "skipped",
      }
    }

    const existingCatalog = await readPersistedCatalog(catalogPath)
    const existingVersion = existingCatalog?._copilot_api.client_version ?? null
    if (
      existingVersion
      && compareCodexVersions(normalizedVersion, existingVersion) < 0
    ) {
      return {
        clientVersion: normalizedVersion,
        path: catalogPath,
        reason: "older_client_version",
        status: "skipped",
      }
    }

    if (
      existingCatalog
      && existingVersion === normalizedVersion
      && areCatalogModelsEqual(existingCatalog.models, catalog.models)
    ) {
      return {
        clientVersion: normalizedVersion,
        modelCount: catalog.models.length,
        path: catalogPath,
        status: "unchanged",
      }
    }

    const persistedCatalog: PersistedCodexStartupCatalog = {
      ...catalog,
      _copilot_api: {
        client_version: normalizedVersion,
        generated_at: new Date().toISOString(),
      },
    }
    const content = `${JSON.stringify(persistedCatalog, null, 2)}\n`
    await writeAtomically(catalogPath, content, (writtenContent) => {
      try {
        return isValidPersistedCatalog(
          JSON.parse(writtenContent) as PersistedCodexStartupCatalog,
        )
      } catch {
        return false
      }
    })
    return {
      clientVersion: normalizedVersion,
      modelCount: catalog.models.length,
      path: catalogPath,
      status: "updated",
    }
  }

  const refresh: CodexStartupCatalogManager["refresh"] = async (
    copilotModels,
  ) => {
    const versions = (await listInstalledVersions()).sort((left, right) =>
      compareCodexVersions(right, left),
    )
    if (versions.length === 0) {
      return {
        path: catalogPath,
        reason: "no_installed_client",
        status: "skipped",
      }
    }

    for (const clientVersion of versions) {
      const catalog = await createModelsResponse(clientVersion, copilotModels)
      if (isValidCodexStartupCatalog(catalog)) {
        return await observe(clientVersion, catalog)
      }
    }
    return {
      path: catalogPath,
      reason: "no_valid_catalog",
      status: "skipped",
    }
  }

  const createResponse: CodexStartupCatalogManager["createResponse"] = async (
    clientVersion,
    copilotModels,
  ) => {
    const catalog = await createModelsResponse(clientVersion, copilotModels)
    if (clientVersion && isValidCodexStartupCatalog(catalog)) {
      try {
        consola.debug(
          "codex.startup_catalog",
          await observe(clientVersion, catalog),
        )
      } catch (error) {
        consola.warn("codex.startup_catalog.persist_failed", {
          clientVersion,
          error,
        })
      }
    }
    return catalog
  }

  return { createResponse, refresh }
}

const isValidCodexStartupCatalog = (value: CodexModelsResponse): boolean => {
  if (!Array.isArray(value.models) || value.models.length === 0) {
    return false
  }

  const validModels = value.models.every((model) => {
    const contextWindow = model.context_window
    const maxContextWindow = model.max_context_window
    const autoCompactTokenLimit = model.auto_compact_token_limit
    return (
      isNonEmptyString(model.slug)
      && isNonEmptyString(model.display_name)
      && isNonEmptyString(model.base_instructions)
      && isNonEmptyString(model.shell_type)
      && isNonEmptyString(model.visibility)
      && typeof model.supported_in_api === "boolean"
      && isNonEmptyStringArray(model.input_modalities)
      && isReasoningLevelArray(model.supported_reasoning_levels)
      && isPositiveSafeInteger(contextWindow)
      && isPositiveSafeInteger(maxContextWindow)
      && contextWindow <= maxContextWindow
      && isPercentage(model.effective_context_window_percent)
      && (autoCompactTokenLimit === null
        || autoCompactTokenLimit === undefined
        || (isPositiveSafeInteger(autoCompactTokenLimit)
          && autoCompactTokenLimit <= contextWindow))
    )
  })
  return (
    validModels
    && value.models.some(
      (model) => model.supported_in_api === true && model.visibility === "list",
    )
  )
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

const isPercentage = (value: unknown): value is number =>
  isPositiveSafeInteger(value) && value <= 100

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const isNonEmptyStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value)
  && value.length > 0
  && value.every((item) => isNonEmptyString(item))

const isReasoningLevelArray = (
  value: unknown,
): value is Array<{ effort: string }> =>
  Array.isArray(value)
  && value.length > 0
  && value.every((item) => isRecord(item) && isNonEmptyString(item.effort))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readFileIfPresent = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

const readPersistedCatalog = async (
  catalogPath: string,
): Promise<PersistedCodexStartupCatalog | null> => {
  const content = await readFileIfPresent(catalogPath)
  if (!content) {
    return null
  }
  try {
    const value = JSON.parse(content) as PersistedCodexStartupCatalog
    return isValidPersistedCatalog(value) ? value : null
  } catch {
    return null
  }
}

const isValidPersistedCatalog = (
  value: PersistedCodexStartupCatalog,
): boolean =>
  isValidCodexStartupCatalog(value)
  && isRecord(value._copilot_api)
  && typeof value._copilot_api.client_version === "string"
  && normalizeCodexVersion(value._copilot_api.client_version) !== null
  && typeof value._copilot_api.generated_at === "string"
  && !Number.isNaN(Date.parse(value._copilot_api.generated_at))

const areCatalogModelsEqual = (
  left: Array<unknown>,
  right: Array<unknown>,
): boolean => JSON.stringify(left) === JSON.stringify(right)

const compareCodexVersions = (left: string, right: string): number => {
  const [leftCore, leftPrerelease] = left.split(/[-+]/u, 2)
  const [rightCore, rightPrerelease] = right.split(/[-+]/u, 2)
  const leftParts = leftCore.split(".").map(Number)
  const rightParts = rightCore.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  if (!leftPrerelease && rightPrerelease) return 1
  if (leftPrerelease && !rightPrerelease) return -1
  return (leftPrerelease ?? "").localeCompare(rightPrerelease ?? "", "en", {
    numeric: true,
  })
}

const writeFileAtomically = async (
  destinationPath: string,
  content: string,
  validateWrittenContent: (content: string) => boolean = () => true,
): Promise<void> => {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  )

  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    const writtenContent = await fs.readFile(temporaryPath, "utf8")
    if (writtenContent !== content || !validateWrittenContent(writtenContent)) {
      throw new Error("Atomic file validation failed before replacement")
    }
    await fs.chmod(temporaryPath, 0o600)
    await fs.rename(temporaryPath, destinationPath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error

export const codexStartupCatalogManager = createCodexStartupCatalogManager({
  catalogPath: PATHS.CODEX_MODEL_CATALOG_PATH,
})
