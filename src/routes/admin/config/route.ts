import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/error"
import {
  getModelMappings,
  ModelMappingsValidationError,
  setModelMappings,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { codexStartupCatalogManager } from "~/services/codex/startup-catalog"

export const configRoutes = new Hono()

export const configRouteDependencies = {
  refreshStartupCatalog: ({
    modelMappings,
  }: {
    modelMappings: Readonly<Record<string, string>>
  }) =>
    codexStartupCatalogManager.refresh({
      copilotModels: state.models?.data ?? [],
      modelMappings,
    }),
}

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(z.string(), z.string()),
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )
    const catalogRefresh = await configRouteDependencies.refreshStartupCatalog({
      modelMappings: updatedModelMappings,
    })

    return c.json({
      catalogRefresh,
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    if (error instanceof ModelMappingsValidationError) {
      return c.json(
        {
          error: {
            diagnostics: error.diagnostics,
            message: error.message,
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    return await forwardError(c, error)
  }
})
