import { afterEach, expect, mock, test } from "bun:test"

import type { CodexStartupCatalogUpdateResult } from "../src/services/codex/startup-catalog"
import type { ModelsResponse } from "../src/services/copilot/get-models"

import { refreshCodexStartupCatalog, startDependencies } from "../src/start"

const models = {
  data: [],
  object: "list",
} satisfies ModelsResponse

const originalDependencies = { ...startDependencies }

afterEach(() => {
  Object.assign(startDependencies, originalDependencies)
})

test("startup model observation refreshes the catalog with the current mapping snapshot", async () => {
  const refreshResult: CodexStartupCatalogUpdateResult = {
    clientVersion: "0.144.2",
    degraded: false,
    inputRevision: 2,
    modelCount: 1,
    path: "/tmp/models.json",
    restartRequired: true,
    status: "updated",
  }
  const refreshStartupCatalog = mock(() => Promise.resolve(refreshResult))
  startDependencies.getModelMappings = () => ({ source: "target" })
  startDependencies.refreshStartupCatalog = refreshStartupCatalog

  await refreshCodexStartupCatalog(models)

  expect(refreshStartupCatalog).toHaveBeenCalledWith({
    copilotModels: models.data,
    modelMappings: { source: "target" },
  })
})

test("startup model observation accepts non-updating catalog outcomes", async () => {
  const refreshResult: CodexStartupCatalogUpdateResult = {
    clientVersion: "0.144.2",
    degraded: false,
    inputRevision: 2,
    modelCount: 1,
    path: "/tmp/models.json",
    restartRequired: false,
    status: "unchanged",
  }
  startDependencies.getModelMappings = () => ({})
  startDependencies.refreshStartupCatalog = () => Promise.resolve(refreshResult)

  expect(await refreshCodexStartupCatalog(models)).toBeUndefined()
})
