import { expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { CodexModelsResponse } from "~/services/codex/installed-catalog"
import { createCodexStartupCatalogManager } from "~/services/codex/startup-catalog"
import type { Model } from "~/services/copilot/get-models"

const createCatalog = ({
  autoCompactTokenLimit = 890_000,
  contextWindow = 1_050_000,
}: {
  autoCompactTokenLimit?: number
  contextWindow?: number
} = {}): CodexModelsResponse => ({
  models: [
    {
      auto_compact_token_limit: autoCompactTokenLimit,
      base_instructions: "bundled instructions",
      context_window: contextWindow,
      display_name: "GPT-5.6-Sol",
      effective_context_window_percent: 95,
      input_modalities: ["text", "image"],
      max_context_window: contextWindow,
      shell_type: "shell_command",
      slug: "gpt-5.6-sol",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "high" }],
      visibility: "list",
    },
  ],
})

const withTemporaryCatalog = async (
  run: (catalogPath: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-api-codex-startup-catalog-"),
  )
  const catalogPath = path.join(tempDir, "codex-model-catalog.json")

  try {
    await run(catalogPath)
  } finally {
    const resolvedTempDir = path.resolve(tempDir)
    const resolvedOsTemp = path.resolve(os.tmpdir())
    if (resolvedTempDir.startsWith(`${resolvedOsTemp}${path.sep}`)) {
      await fs.rm(resolvedTempDir, { force: true, recursive: true })
    }
  }
}

const createManagerForResponse = (
  catalogPath: string,
  catalog: CodexModelsResponse,
) =>
  createCodexStartupCatalogManager({
    catalogPath,
    createModelsResponse: () => Promise.resolve(catalog),
  })

const readPersistedCatalog = async (catalogPath: string) =>
  JSON.parse(await fs.readFile(catalogPath, "utf8")) as CodexModelsResponse & {
    _copilot_api: {
      client_version: string
      generated_at: string
    }
  }

test("Codex startup catalog stores a valid last-known-good snapshot", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const catalog = createCatalog()
    const manager = createManagerForResponse(catalogPath, catalog)

    expect(await manager.createResponse("0.144.2", [])).toEqual(catalog)
    const persisted = await readPersistedCatalog(catalogPath)
    expect(persisted.models).toEqual(catalog.models)
    expect(persisted._copilot_api.client_version).toBe("0.144.2")
    expect(
      Number.isNaN(Date.parse(persisted._copilot_api.generated_at)),
    ).toBeFalse()
    expect(await Bun.file(`${catalogPath}.meta.json`).exists()).toBeFalse()
  })
})

test("Codex startup catalog does not let an older client overwrite a newer snapshot", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const currentCatalog = createCatalog()
    await createManagerForResponse(catalogPath, currentCatalog).createResponse(
      "0.144.2",
      [],
    )

    await createManagerForResponse(
      catalogPath,
      createCatalog({
        autoCompactTokenLimit: 240_000,
        contextWindow: 400_000,
      }),
    ).createResponse("0.143.0", [])

    expect((await readPersistedCatalog(catalogPath)).models).toEqual(
      currentCatalog.models,
    )
  })
})

test("Codex startup catalog refreshes from the newest installed client", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const currentCatalog = createCatalog()
    const createModelsResponse = mock((clientVersion: string | null) =>
      Promise.resolve(
        clientVersion === "0.144.2" ? currentCatalog : { models: [] },
      ),
    )
    const manager = createCodexStartupCatalogManager({
      catalogPath,
      createModelsResponse,
      listInstalledVersions: () =>
        Promise.resolve(["0.143.0", "0.144.2", "0.144.1"]),
    })

    const result = await manager.refresh([] as Array<Model>)

    expect(result).toMatchObject({
      clientVersion: "0.144.2",
      modelCount: 1,
      path: catalogPath,
      status: "updated",
    })
    expect(createModelsResponse).toHaveBeenCalledTimes(1)
    expect(createModelsResponse.mock.calls[0]?.[0]).toBe("0.144.2")
    expect((await readPersistedCatalog(catalogPath)).models).toEqual(
      currentCatalog.models,
    )
  })
})

test("Codex startup catalog rejects invalid catalog variants", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const catalog = createCatalog()
    await createManagerForResponse(catalogPath, catalog).createResponse(
      "0.144.2",
      [],
    )
    const previousBytes = await fs.readFile(catalogPath)
    const partialCatalog = createCatalog()
    delete partialCatalog.models[0]?.display_name
    const malformedCatalog = createCatalog()
    malformedCatalog.models[0].input_modalities = "text"
    const negativeCatalog = createCatalog()
    negativeCatalog.models[0].context_window = -1
    const inconsistentCatalog = createCatalog()
    inconsistentCatalog.models[0].auto_compact_token_limit = 2_000_000
    const hiddenCatalog = createCatalog()
    hiddenCatalog.models[0].visibility = "hide"

    for (const invalidCatalog of [
      { models: [] },
      partialCatalog,
      malformedCatalog,
      negativeCatalog,
      inconsistentCatalog,
      hiddenCatalog,
    ]) {
      await createManagerForResponse(
        catalogPath,
        invalidCatalog,
      ).createResponse("0.144.3", [])
    }

    expect(await fs.readFile(catalogPath)).toEqual(previousBytes)
  })
})

test("Codex startup catalog replaces an older snapshot with a newer client", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    await createManagerForResponse(
      catalogPath,
      createCatalog({
        autoCompactTokenLimit: 240_000,
        contextWindow: 400_000,
      }),
    ).createResponse("0.143.0", [])
    const currentCatalog = createCatalog()

    await createManagerForResponse(catalogPath, currentCatalog).createResponse(
      "0.144.2",
      [],
    )

    expect((await readPersistedCatalog(catalogPath)).models).toEqual(
      currentCatalog.models,
    )
  })
})

test("Codex startup catalog upgrades a legacy snapshot without metadata", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const catalog = createCatalog()
    const manager = createManagerForResponse(catalogPath, catalog)
    await fs.writeFile(
      catalogPath,
      `${JSON.stringify(catalog, null, 2)}\n`,
      "utf8",
    )

    await manager.createResponse("0.144.2", [])

    const persisted = await readPersistedCatalog(catalogPath)
    expect(persisted.models).toEqual(catalog.models)
    expect(persisted._copilot_api.client_version).toBe("0.144.2")
  })
})

test("Codex startup catalog keeps generation failures away from last-known-good", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const catalog = createCatalog()
    await createManagerForResponse(catalogPath, catalog).createResponse(
      "0.144.2",
      [],
    )
    const previousBytes = await fs.readFile(catalogPath)
    const manager = createCodexStartupCatalogManager({
      catalogPath,
      createModelsResponse: () =>
        Promise.reject(new Error("generation failed")),
    })

    expect(manager.createResponse("0.144.3", [])).rejects.toThrow(
      "generation failed",
    )
    expect(await fs.readFile(catalogPath)).toEqual(previousBytes)
  })
})

test("Codex models response survives a startup catalog write failure", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const blockingParent = path.join(
      path.dirname(catalogPath),
      "not-a-directory",
    )
    await fs.writeFile(blockingParent, "keep me", "utf8")
    const blockedCatalogPath = path.join(blockingParent, "models.json")
    const catalog = createCatalog()
    const manager = createManagerForResponse(blockedCatalogPath, catalog)

    expect(await manager.createResponse("0.144.2", [])).toEqual(catalog)
    expect(await fs.readFile(blockingParent, "utf8")).toBe("keep me")
  })
})

test("Codex startup catalog preserves last-known-good across atomic-layer failures", async () => {
  await withTemporaryCatalog(async (catalogPath) => {
    const originalCatalog = createCatalog({
      autoCompactTokenLimit: 240_000,
      contextWindow: 400_000,
    })
    await createManagerForResponse(catalogPath, originalCatalog).createResponse(
      "0.143.0",
      [],
    )
    const previousBytes = await fs.readFile(catalogPath)

    for (const failure of ["readback validation failed", "rename failed"]) {
      const currentCatalog = createCatalog()
      const manager = createCodexStartupCatalogManager({
        catalogPath,
        createModelsResponse: () => Promise.resolve(currentCatalog),
        writeAtomically: () => Promise.reject(new Error(failure)),
      })

      expect(await manager.createResponse("0.144.2", [])).toEqual(
        currentCatalog,
      )
      expect(await fs.readFile(catalogPath)).toEqual(previousBytes)
    }
  })
})
