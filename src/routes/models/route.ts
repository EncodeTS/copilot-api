import { Hono } from "hono"

import { listEnabledProviders } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

export const modelRoutes = new Hono()

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()

type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeCopilotModel(model: Model): ClientModel {
  const capabilities = model.capabilities
  const contextWindow = capabilities?.limits?.max_context_window_tokens ?? 0
  const clientId = toClientModelId(model.id)
  const is1m = contextWindow >= 1_000_000

  return {
    claude_model_id: is1m ? `${clientId}[1m]` : clientId,
    ...model,
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
    display_name: model.name,
  }
}

function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function normalizeProviderModel(
  provider: string,
  model: unknown,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId) {
    return null
  }

  const id = `${provider}/${rawId}`
  const name =
    getStringField(model, "display_name")
    ?? getStringField(model, "name")
    ?? rawId
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...model,
    id,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
    display_name: name,
  }
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return []
    }

    if (providerConfig.name === "codex") {
      const codexModels = getCodexModels().data
      return codexModels
        .map((model) => normalizeProviderModel(providerConfig.name, model))
        .filter((model): model is ClientModel => model !== null)
    }

    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      logger.warn("models.provider.skip_non_ok", {
        provider,
        statusCode: response.status,
      })
      return []
    }

    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      logger.warn("models.provider.skip_invalid_body", { provider })
      return []
    }

    return body.data
      .map((model) => normalizeProviderModel(providerConfig.name, model))
      .filter((model): model is ClientModel => model !== null)
  } catch (error) {
    logger.warn("models.provider.skip_error", {
      provider,
      error,
    })
    return []
  }
}

async function getAggregatedModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  const copilotModels = state.models?.data.map(normalizeCopilotModel) ?? []
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(provider, requestHeaders),
    ),
  )

  const models = [...copilotModels, ...providerModelsByProvider.flat()]

  const seenModelIds = new Set<string>()
  return models.filter((model) => {
    if (seenModelIds.has(model.id)) {
      return false
    }

    seenModelIds.add(model.id)
    return true
  })
}

modelRoutes.get("/", async (c) => {
  try {
    const models = await getAggregatedModels(c.req.raw.headers)

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
