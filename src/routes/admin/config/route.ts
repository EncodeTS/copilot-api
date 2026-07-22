import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/error"
import {
  getModelMappings,
  getResponsesWebSocketResourceLimits,
  setModelMappings,
  validateModelMappingsOutcome,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { getHandlerLogDirectory } from "~/lib/logger"
import {
  applyLegacyLogCleanup,
  LEGACY_LOG_CLEANUP_CONFIRMATION,
  previewLegacyLogCleanup,
} from "~/lib/legacy-log-cleanup"
import { state } from "~/lib/state"
import { codexStartupCatalogManager } from "~/services/codex/startup-catalog"
import {
  clearPooledWebSocketConnections,
  getPooledWebSocketDiagnostics,
} from "~/services/responses-websocket"

export const configRoutes = new Hono()

export const configRouteDependencies = {
  clearResponsesWebSocketConnections: clearPooledWebSocketConnections,
  getPooledWebSocketDiagnostics,
  getResponsesWebSocketResourceLimits,
  previewLegacyLogs: () =>
    previewLegacyLogCleanup({ logDirectory: getHandlerLogDirectory() }),
  applyLegacyLogs: (input: { confirmation: string; previewId: string }) =>
    applyLegacyLogCleanup({
      ...input,
      logDirectory: getHandlerLogDirectory(),
    }),
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

const responsesWebSocketClearRequestSchema = z.object({
  reason: z.enum(["network_change", "proxy_change"]),
})

const legacyLogCleanupRequestSchema = z.object({
  confirmation: z.literal(LEGACY_LOG_CLEANUP_CONFIRMATION),
  previewId: z.string().regex(/^[a-f0-9]{64}$/u),
})

configRoutes.get("/legacy-logs", async (c) => {
  const preview = await configRouteDependencies.previewLegacyLogs()
  return c.json({
    ...preview,
    confirmation: LEGACY_LOG_CLEANUP_CONFIRMATION,
  })
})

configRoutes.post("/legacy-logs", async (c) => {
  const parseResult = legacyLogCleanupRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  )
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

  try {
    return c.json(
      await configRouteDependencies.applyLegacyLogs(parseResult.data),
    )
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/responses-websocket", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    diagnostics: configRouteDependencies.getPooledWebSocketDiagnostics(),
    limits: configRouteDependencies.getResponsesWebSocketResourceLimits(),
  })
})

configRoutes.post("/responses-websocket/clear", async (c) => {
  const parseResult = responsesWebSocketClearRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  )
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

  const clearedConnections =
    configRouteDependencies.clearResponsesWebSocketConnections(
      parseResult.data.reason,
    )
  return c.json({
    clearedConnections,
    diagnostics: configRouteDependencies.getPooledWebSocketDiagnostics(),
  })
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

    const validation = validateModelMappingsOutcome(
      parseResult.data.modelMappings,
    )
    if (!validation.ok) {
      return c.json(
        {
          error: {
            diagnostics: validation.diagnostics,
            message: "Invalid model mappings.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(validation.modelMappings)
    const catalogRefresh = await configRouteDependencies.refreshStartupCatalog({
      modelMappings: updatedModelMappings,
    })

    return c.json({
      catalogRefresh,
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
