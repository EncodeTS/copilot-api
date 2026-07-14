import { isResponsesApiWebSocketEnabled } from "~/lib/config"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import {
  loadInstalledCodexCatalog,
  type CodexModelInfo,
  type CodexModelsResponse,
} from "~/services/codex/installed-catalog"
import { normalizeCodexVersion } from "~/services/codex/version"
import type { Model } from "~/services/copilot/get-models"

const CODEX_USER_AGENT_VERSION_PATTERN =
  /\bcodex(?:[-_\s][^/]*)?\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const CODEX_AUTO_COMPACT_RATIO = 0.9
// Codex checks the existing context before adding the next turn, so leave room
// below the upstream prompt cap for one moderate user/tool payload.
const CODEX_AUTO_COMPACT_HEADROOM_TOKENS = 32_000

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ?
      value
    : undefined
}

export function getCodexClientVersion(
  requestUrl: string,
  userAgent: string | undefined,
): string | null {
  const urlVersion = normalizeCodexVersion(
    new URL(requestUrl, "http://localhost").searchParams.get("client_version"),
  )
  const userAgentVersion = normalizeCodexVersion(
    userAgent?.match(CODEX_USER_AGENT_VERSION_PATTERN)?.[1],
  )

  return urlVersion && userAgentVersion && urlVersion !== userAgentVersion ?
      null
    : (urlVersion ?? userAgentVersion)
}

export function isCodexClientUserAgent(userAgent: string | undefined): boolean {
  return /^codex/iu.test(userAgent?.trim() ?? "")
}

export const codexClientModelsDependencies = {
  isResponsesApiWebSocketEnabled,
  loadBundledCatalog: loadInstalledCodexCatalog,
}

function supportsResponses(model: Model): boolean {
  const capabilities = getResponsesEndpointCapabilities(model)
  return (
    capabilities.http
    || (capabilities.websocket
      && codexClientModelsDependencies.isResponsesApiWebSocketEnabled())
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
