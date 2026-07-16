import { Hono } from "hono"
import { createHash } from "node:crypto"

import { getModelMappings, listEnabledProviders } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"
import {
  getCodexClientVersion,
  isCodexClientUserAgent,
} from "~/services/codex/client-models"
import type { CodexModelsResponse } from "~/services/codex/installed-catalog"
import { codexStartupCatalogManager } from "~/services/codex/startup-catalog"
import {
  forwardCodexModels,
  getModels as getCodexModels,
} from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  forwardProviderModels,
} from "~/services/providers/provider-proxy"

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

export function projectGeneralCopilotModels(
  models: ReadonlyArray<Model>,
  modelMappings: Readonly<Record<string, string>>,
): Array<Model> {
  const modelsById = new Map(models.map((model) => [model.id, model]))
  return models.map((source) => {
    const targetId = modelMappings[source.id]
    if (!targetId || targetId.includes("/")) {
      return structuredClone(source)
    }
    const target = modelsById.get(targetId)
    if (!target) {
      return structuredClone(source)
    }

    return {
      ...structuredClone(source),
      capabilities: structuredClone(target.capabilities),
      supported_endpoints: structuredClone(target.supported_endpoints),
      vendor: target.vendor,
      version: target.version,
    }
  })
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
  const copilotModels =
    state.models ?
      projectGeneralCopilotModels(state.models.data, getModelMappings()).map(
        normalizeCopilotModel,
      )
    : []
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

function createCodexCatalogHttpResponse(
  body: CodexModelsResponse,
  ifNoneMatch: string | undefined,
): Response {
  const responseText = JSON.stringify(body)
  const etag = `"${createHash("sha256").update(responseText).digest("hex")}"`
  const headers = new Headers({
    "cache-control": "private, max-age=0, must-revalidate",
    "content-type": "application/json; charset=UTF-8",
    etag,
    vary: "User-Agent",
  })
  const requestEtags = ifNoneMatch
    ?.split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))

  if (requestEtags?.includes(etag) || requestEtags?.includes("*")) {
    return new Response(null, { status: 304, headers })
  }

  return new Response(responseText, { status: 200, headers })
}

modelRoutes.get("/", async (c) => {
  try {
    const userAgent = c.req.header("user-agent")
    if (isCodexClientUserAgent(userAgent)) {
      if (!state.models && (await resolveProviderConfig("codex"))) {
        return createProviderProxyResponse(
          await forwardCodexModels(c.req.url, c.req.raw.headers),
        )
      }

      const clientVersion = getCodexClientVersion(c.req.url, userAgent)
      const models = await codexStartupCatalogManager.createResponse(
        clientVersion,
        {
          copilotModels: state.models?.data ?? [],
          modelMappings: getModelMappings(),
        },
      )
      return createCodexCatalogHttpResponse(
        models,
        c.req.header("if-none-match"),
      )
    }

    const models = await getAggregatedModels(c.req.raw.headers)

    c.header("vary", "User-Agent")
    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
