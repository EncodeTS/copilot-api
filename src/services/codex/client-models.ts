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
const SOURCE_IDENTITY_FIELDS = [
  "description",
  "display_name",
  "priority",
  "visibility",
] as const

export type CodexModelsProjectionStatus =
  | "complete"
  | "degraded"
  | "unavailable"

export type CodexModelsProjectionDiagnosticCode =
  | "base_catalog_unavailable"
  | "reasoning_incompatible"
  | "source_descriptor_missing"
  | "target_context_invalid"
  | "target_descriptor_missing"
  | "target_disabled"
  | "target_provider_qualified"
  | "target_responses_unsupported"
  | "target_unavailable"

export interface CodexModelsProjectionDiagnostic {
  code: CodexModelsProjectionDiagnosticCode
  source?: string
  target?: string
}

export interface CodexModelsProjection {
  catalog: CodexModelsResponse
  diagnostics: Array<CodexModelsProjectionDiagnostic>
  status: CodexModelsProjectionStatus
}

export interface CodexModelsProjectionInput {
  clientVersion: string | null
  copilotModels: ReadonlyArray<Model>
  modelMappings: Readonly<Record<string, string>>
}

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
  requireContextWindow = false,
):
  | { model: CodexModelInfo }
  | { reason: "reasoning_incompatible" | "target_context_invalid" } {
  const contextWindow = asPositiveInteger(
    copilotModel.capabilities.limits.max_context_window_tokens,
  )
  if (!contextWindow) {
    if (requireContextWindow) {
      return { reason: "target_context_invalid" }
    }
    return { model: { ...template } }
  }

  const model = {
    ...template,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: resolveAutoCompactTokenLimit(
      copilotModel,
      contextWindow,
    ),
  }
  return requireContextWindow ?
      applyLiveReasoningCapabilities(model, copilotModel)
    : { model }
}

function applyLiveReasoningCapabilities(
  template: CodexModelInfo,
  copilotModel: Model,
): { model: CodexModelInfo } | { reason: "reasoning_incompatible" } {
  if (!Object.hasOwn(copilotModel.capabilities.supports, "reasoning_effort")) {
    return { model: { ...template } }
  }

  const liveEfforts = copilotModel.capabilities.supports.reasoning_effort ?? []
  const descriptorLevels = template.supported_reasoning_levels
  const supportedReasoningLevels =
    Array.isArray(descriptorLevels) ?
      descriptorLevels.filter(
        (level) =>
          isRecord(level)
          && typeof level.effort === "string"
          && liveEfforts.includes(level.effort),
      )
    : []
  const defaultEffort =
    typeof template.default_reasoning_effort === "string" ?
      template.default_reasoning_effort
    : typeof template.default_reasoning_level === "string" ?
      template.default_reasoning_level
    : undefined
  if (
    supportedReasoningLevels.length === 0
    || (defaultEffort
      && !supportedReasoningLevels.some(
        (level) =>
          isRecord(level)
          && typeof level.effort === "string"
          && level.effort === defaultEffort,
      ))
  ) {
    return { reason: "reasoning_incompatible" }
  }

  return {
    model: {
      ...template,
      supported_reasoning_levels: supportedReasoningLevels,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createVirtualAliasDescriptor(
  source: CodexModelInfo,
  target: CodexModelInfo,
): CodexModelInfo {
  const alias: CodexModelInfo = {
    ...target,
    slug: source.slug,
  }
  for (const field of SOURCE_IDENTITY_FIELDS) {
    if (Object.hasOwn(source, field)) {
      alias[field] = source[field]
    }
  }
  return alias
}

export async function projectCodexModels({
  clientVersion,
  copilotModels,
  modelMappings,
}: CodexModelsProjectionInput): Promise<CodexModelsProjection> {
  if (!clientVersion) {
    return {
      catalog: { models: [] },
      diagnostics: [{ code: "base_catalog_unavailable" }],
      status: "unavailable",
    }
  }

  const catalog =
    await codexClientModelsDependencies.loadBundledCatalog(clientVersion)
  if (!catalog) {
    return {
      catalog: { models: [] },
      diagnostics: [{ code: "base_catalog_unavailable" }],
      status: "unavailable",
    }
  }

  const descriptorsBySlug = new Map(
    catalog.models.map((descriptor) => [descriptor.slug, descriptor]),
  )
  const liveModelsById = new Map(
    copilotModels.map((model) => [model.id, model]),
  )
  const diagnostics: Array<CodexModelsProjectionDiagnostic> = []
  const models = catalog.models.flatMap((sourceDescriptor) => {
    const mappedTarget = modelMappings[sourceDescriptor.slug]
    const targetId = mappedTarget ?? sourceDescriptor.slug
    if (mappedTarget?.includes("/")) {
      diagnostics.push({
        code: "target_provider_qualified",
        source: sourceDescriptor.slug,
        target: mappedTarget,
      })
      return []
    }

    const targetDescriptor =
      mappedTarget ? descriptorsBySlug.get(targetId) : sourceDescriptor
    if (!targetDescriptor) {
      diagnostics.push({
        code: "target_descriptor_missing",
        source: sourceDescriptor.slug,
        target: targetId,
      })
      return []
    }

    const targetModel = liveModelsById.get(targetId)
    if (!targetModel) {
      if (mappedTarget) {
        diagnostics.push({
          code: "target_unavailable",
          source: sourceDescriptor.slug,
          target: targetId,
        })
      }
      return []
    }
    if (!targetModel.model_picker_enabled) {
      if (mappedTarget) {
        diagnostics.push({
          code: "target_disabled",
          source: sourceDescriptor.slug,
          target: targetId,
        })
      }
      return []
    }
    if (!supportsResponses(targetModel)) {
      if (mappedTarget) {
        diagnostics.push({
          code: "target_responses_unsupported",
          source: sourceDescriptor.slug,
          target: targetId,
        })
      }
      return []
    }

    const descriptor =
      mappedTarget ?
        createVirtualAliasDescriptor(sourceDescriptor, targetDescriptor)
      : targetDescriptor
    const applied = applyCopilotCapabilities(
      descriptor,
      targetModel,
      mappedTarget !== undefined,
    )
    if ("reason" in applied) {
      if (mappedTarget) {
        diagnostics.push({
          code: applied.reason,
          source: sourceDescriptor.slug,
          target: targetId,
        })
      }
      return []
    }
    return [applied.model]
  })

  for (const [source, target] of Object.entries(modelMappings)) {
    if (!descriptorsBySlug.has(source)) {
      diagnostics.push({
        code: "source_descriptor_missing",
        source,
        target,
      })
    }
  }

  return {
    catalog: { models },
    diagnostics,
    status: diagnostics.length > 0 ? "degraded" : "complete",
  }
}

export async function createCodexModelsResponse(
  clientVersion: string | null,
  copilotModels: Array<Model>,
  modelMappings: Readonly<Record<string, string>> = {},
): Promise<CodexModelsResponse> {
  const projection = await projectCodexModels({
    clientVersion,
    copilotModels,
    modelMappings,
  })
  return projection.catalog
}
