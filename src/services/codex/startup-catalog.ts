import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import consola from "consola"

import type { CodexStartupCatalogUpdateResult } from "../../../shared-types"

import {
  projectCodexModels,
  type CodexModelsProjection,
} from "~/services/codex/client-models"
import {
  listInstalledCodexVersions,
  type CodexModelsResponse,
} from "~/services/codex/installed-catalog"
import { normalizeCodexVersion } from "~/services/codex/version"
import type { Model } from "~/services/copilot/get-models"
import { PATHS } from "~/lib/paths"

export type { CodexStartupCatalogUpdateResult } from "../../../shared-types"

export interface CodexStartupCatalogInputs {
  copilotModels: ReadonlyArray<Model>
  modelMappings: Readonly<Record<string, string>>
}

export interface CodexStartupCatalogManager {
  createResponse: (
    clientVersion: string | null,
    inputs: CodexStartupCatalogInputs,
  ) => Promise<CodexModelsResponse>
  refresh: (
    inputs: CodexStartupCatalogInputs,
  ) => Promise<CodexStartupCatalogUpdateResult>
}

interface CodexStartupCatalogSnapshot extends CodexStartupCatalogInputs {
  inputRevision: number
}

interface PersistedCodexStartupCatalog extends CodexModelsResponse {
  _copilot_api: {
    client_version: string
    generated_at: string
    input_revision?: number
  }
}

export const createCodexStartupCatalogManager = ({
  catalogPath,
  projectModels = projectCodexModels,
  listInstalledVersions = listInstalledCodexVersions,
  writeAtomically = writeFileAtomically,
}: {
  catalogPath: string
  projectModels?: typeof projectCodexModels
  listInstalledVersions?: typeof listInstalledCodexVersions
  writeAtomically?: typeof writeFileAtomically
}): CodexStartupCatalogManager => {
  let currentSnapshot: CodexStartupCatalogSnapshot | null = null
  let persistenceQueue: Promise<void> = Promise.resolve()

  const captureInputs = (
    inputs: CodexStartupCatalogInputs,
  ): CodexStartupCatalogSnapshot => {
    const nextInputs = cloneInputs(inputs)
    if (
      currentSnapshot
      && isDeepStrictEqual(
        currentSnapshot.copilotModels,
        nextInputs.copilotModels,
      )
      && isDeepStrictEqual(
        currentSnapshot.modelMappings,
        nextInputs.modelMappings,
      )
    ) {
      return currentSnapshot
    }

    currentSnapshot = deepFreeze({
      ...nextInputs,
      inputRevision: (currentSnapshot?.inputRevision ?? 0) + 1,
    })
    return currentSnapshot
  }

  const persistProjectionNow = async (
    clientVersion: string | null,
    snapshot: CodexStartupCatalogSnapshot,
    projection: CodexModelsProjection,
  ): Promise<CodexStartupCatalogUpdateResult> => {
    const normalizedVersion = normalizeCodexVersion(clientVersion)
    if (!normalizedVersion) {
      return {
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "invalid_client_version",
        restartRequired: false,
        status: "skipped",
      }
    }
    if (
      currentSnapshot
      && snapshot.inputRevision < currentSnapshot.inputRevision
    ) {
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "superseded_input",
        restartRequired: false,
        status: "skipped",
      }
    }
    if (projection.status === "unavailable") {
      return {
        clientVersion: normalizedVersion,
        degraded: false,
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "projection_unavailable",
        restartRequired: false,
        status: "skipped",
      }
    }
    if (!isValidCodexStartupCatalog(projection.catalog)) {
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "invalid_catalog",
        restartRequired: false,
        status: "skipped",
      }
    }

    let existingCatalog: PersistedCodexStartupCatalog | null
    try {
      existingCatalog = await readPersistedCatalog(catalogPath)
    } catch (error) {
      consola.warn("codex.startup_catalog.persist_failed", {
        clientVersion: normalizedVersion,
        inputRevision: snapshot.inputRevision,
        error,
      })
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "persistence_failed",
        restartRequired: false,
        status: "failed",
      }
    }
    const existingVersion = existingCatalog?._copilot_api.client_version ?? null
    if (
      existingVersion
      && compareCodexVersions(normalizedVersion, existingVersion) < 0
    ) {
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "older_client_version",
        restartRequired: false,
        status: "skipped",
      }
    }

    if (
      existingCatalog
      && existingVersion === normalizedVersion
      && areCatalogModelsEqual(
        existingCatalog.models,
        projection.catalog.models,
      )
    ) {
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        modelCount: projection.catalog.models.length,
        path: catalogPath,
        restartRequired: false,
        status: "unchanged",
      }
    }

    const persistedCatalog: PersistedCodexStartupCatalog = {
      ...projection.catalog,
      _copilot_api: {
        client_version: normalizedVersion,
        generated_at: new Date().toISOString(),
        input_revision: snapshot.inputRevision,
      },
    }
    const content = `${JSON.stringify(persistedCatalog, null, 2)}\n`
    try {
      await writeAtomically(catalogPath, content, (writtenContent) => {
        try {
          return isValidPersistedCatalog(
            JSON.parse(writtenContent) as PersistedCodexStartupCatalog,
          )
        } catch {
          return false
        }
      })
    } catch (error) {
      consola.warn("codex.startup_catalog.persist_failed", {
        clientVersion: normalizedVersion,
        inputRevision: snapshot.inputRevision,
        error,
      })
      return {
        clientVersion: normalizedVersion,
        degraded: projection.status === "degraded",
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "persistence_failed",
        restartRequired: false,
        status: "failed",
      }
    }
    return {
      clientVersion: normalizedVersion,
      degraded: projection.status === "degraded",
      inputRevision: snapshot.inputRevision,
      modelCount: projection.catalog.models.length,
      path: catalogPath,
      restartRequired: true,
      status: "updated",
    }
  }

  const persistProjection = (
    clientVersion: string | null,
    snapshot: CodexStartupCatalogSnapshot,
    projection: CodexModelsProjection,
  ): Promise<CodexStartupCatalogUpdateResult> => {
    const operation = persistenceQueue.then(() =>
      persistProjectionNow(clientVersion, snapshot, projection),
    )
    persistenceQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  const refresh: CodexStartupCatalogManager["refresh"] = async (inputs) => {
    const snapshot = captureInputs(inputs)
    let versions: Array<string>
    try {
      versions = (await listInstalledVersions()).sort((left, right) =>
        compareCodexVersions(right, left),
      )
    } catch (error) {
      consola.warn("codex.startup_catalog.discovery_failed", {
        inputRevision: snapshot.inputRevision,
        error,
      })
      return {
        degraded: false,
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "generation_failed",
        restartRequired: false,
        status: "failed",
      }
    }
    if (versions.length === 0) {
      return {
        degraded: false,
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "no_installed_client",
        restartRequired: false,
        status: "skipped",
      }
    }

    const clientVersion = versions[0]
    let projection: CodexModelsProjection
    try {
      projection = await projectModels({
        clientVersion,
        copilotModels: snapshot.copilotModels,
        modelMappings: snapshot.modelMappings,
      })
    } catch (error) {
      consola.warn("codex.startup_catalog.generation_failed", {
        clientVersion,
        inputRevision: snapshot.inputRevision,
        error,
      })
      return {
        clientVersion,
        degraded: false,
        inputRevision: snapshot.inputRevision,
        path: catalogPath,
        reason: "generation_failed",
        restartRequired: false,
        status: "failed",
      }
    }
    return await persistProjection(clientVersion, snapshot, projection)
  }

  const createResponse: CodexStartupCatalogManager["createResponse"] = async (
    clientVersion,
    inputs,
  ) => {
    const snapshot = captureInputs(inputs)
    const projection = await projectModels({
      clientVersion,
      copilotModels: snapshot.copilotModels,
      modelMappings: snapshot.modelMappings,
    })
    consola.debug(
      "codex.startup_catalog",
      await persistProjection(clientVersion, snapshot, projection),
    )
    return projection.catalog
  }

  return { createResponse, refresh }
}

const cloneInputs = (
  inputs: CodexStartupCatalogInputs,
): CodexStartupCatalogInputs => ({
  copilotModels: structuredClone([...inputs.copilotModels]),
  modelMappings: Object.fromEntries(Object.entries(inputs.modelMappings)),
})

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return value
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
  && (value._copilot_api.input_revision === undefined
    || isPositiveSafeInteger(value._copilot_api.input_revision))

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
