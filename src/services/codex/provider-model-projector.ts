import {
  normalizeGatewayReasoningEfforts,
  type GatewayReasoningEffort,
} from "~/lib/reasoning-effort"
import type { Model, ModelsResponse } from "~/services/copilot/get-models"

import type {
  CodexOfficialCatalogProjection,
  CodexProviderCatalogDiagnostic,
} from "./provider-catalog-types"

interface CodexStaticFallbackModelDefinition {
  contextWindow: number
  id: string
  input: Array<"text" | "image">
  maxContextWindow?: number
  maxTokens: number
  name: string
}

// These are gateway adapter invariants, not claims inferred from a model name:
// both provider routes implement streaming Responses delivery at these paths.
export const CODEX_PROVIDER_ADAPTER_INVARIANTS = Object.freeze({
  streaming: true,
  supportedEndpoints: Object.freeze(["/v1/messages", "/v1/responses"] as const),
})

export const CODEX_STATIC_FALLBACK_DIAGNOSTICS = Object.freeze([
  { code: "static_capability_degraded" as const },
  { code: "static_effort_filtered" as const },
])

const CODEX_STATIC_FALLBACK_MODELS: Array<CodexStaticFallbackModelDefinition> =
  [
    {
      contextWindow: 100_000,
      id: "gpt-5.3-codex-spark",
      input: ["text"],
      maxTokens: 32_000,
      name: "GPT-5.3 Codex Spark",
    },
    {
      contextWindow: 272_000,
      id: "gpt-5.4",
      input: ["text", "image"],
      maxContextWindow: 1_000_000,
      maxTokens: 128_000,
      name: "GPT-5.4",
    },
    {
      contextWindow: 272_000,
      id: "gpt-5.4-mini",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "GPT-5.4 mini",
    },
    {
      contextWindow: 272_000,
      id: "gpt-5.5",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "GPT-5.5",
    },
    {
      contextWindow: 372_000,
      id: "gpt-5.6-sol",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "GPT-5.6 Sol",
    },
    {
      contextWindow: 372_000,
      id: "gpt-5.6-terra",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "GPT-5.6 Terra",
    },
    {
      contextWindow: 372_000,
      id: "gpt-5.6-luna",
      input: ["text", "image"],
      maxTokens: 128_000,
      name: "GPT-5.6 Luna",
    },
  ]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asPositiveSafeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ?
    value
  : undefined

const getReasoningLevelEfforts = (value: unknown): Array<string> | null => {
  if (!Array.isArray(value)) return null
  const efforts: Array<string> = []
  for (const level of value) {
    if (!isRecord(level) || typeof level.effort !== "string") {
      return null
    }
    efforts.push(level.effort)
  }
  return efforts
}

const projectOfficialCodexModel = (
  value: unknown,
): {
  diagnostics: Array<CodexProviderCatalogDiagnostic>
  model: Model | null
} => {
  if (!isRecord(value)) {
    return { diagnostics: [], model: null }
  }

  const slug =
    typeof value.slug === "string" && value.slug.trim() ? value.slug : null
  const displayName =
    typeof value.display_name === "string" && value.display_name.trim() ?
      value.display_name
    : slug
  const inputModalities = value.input_modalities
  const promptTokens = asPositiveSafeInteger(value.context_window)
  const contextWindow =
    asPositiveSafeInteger(value.max_context_window) ?? promptTokens
  const reasoningEfforts = getReasoningLevelEfforts(
    value.supported_reasoning_levels,
  )
  const normalizedReasoning = normalizeGatewayReasoningEfforts(reasoningEfforts)

  if (
    !slug
    || !displayName
    || value.visibility !== "list"
    || value.supported_in_api !== true
    || !Array.isArray(inputModalities)
    || !inputModalities.includes("text")
    || !promptTokens
    || !contextWindow
    || contextWindow < promptTokens
    || !reasoningEfforts
    || !normalizedReasoning.validArray
  ) {
    return { diagnostics: [], model: null }
  }

  const diagnostics = normalizedReasoning.rejected.map((effort) => ({
    code: "unsupported_reasoning_effort" as const,
    model: slug,
    value: effort,
  }))
  if (normalizedReasoning.efforts.length === 0) {
    return { diagnostics, model: null }
  }
  const supportsToolCalls =
    value.supports_parallel_tool_calls === true
    || typeof value.apply_patch_tool_type === "string"
    || typeof value.web_search_tool_type === "string"
    || typeof value.tool_mode === "string"

  return {
    diagnostics,
    model: {
      capabilities: {
        family: slug,
        limits: {
          max_context_window_tokens: contextWindow,
          max_prompt_tokens: promptTokens,
        },
        object: "model_capabilities",
        supports: {
          adaptive_thinking: normalizedReasoning.efforts.length > 0,
          parallel_tool_calls: value.supports_parallel_tool_calls === true,
          reasoning_effort: normalizedReasoning.efforts,
          streaming: CODEX_PROVIDER_ADAPTER_INVARIANTS.streaming,
          tool_calls: supportsToolCalls,
          vision: inputModalities.includes("image"),
        },
        type: "chat",
      },
      id: slug,
      model_picker_enabled: true,
      name: displayName,
      object: "model",
      supported_endpoints: [
        ...CODEX_PROVIDER_ADAPTER_INVARIANTS.supportedEndpoints,
      ],
      vendor: "openai",
      version: "codex-official",
    },
  }
}

export const projectOfficialCodexCatalog = (
  value: unknown,
): CodexOfficialCatalogProjection | null => {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return null
  }

  const diagnostics: Array<CodexProviderCatalogDiagnostic> = []
  const models = value.models.flatMap((candidate) => {
    const projection = projectOfficialCodexModel(candidate)
    diagnostics.push(...projection.diagnostics)
    return projection.model ? [projection.model] : []
  })
  return {
    catalog: { data: models, object: "list" },
    diagnostics,
    upstreamModelCount: value.models.length,
  }
}

const normalizeStaticFallbackModel = (
  model: CodexStaticFallbackModelDefinition,
): Model => {
  const reasoningEffort: Array<GatewayReasoningEffort> = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]
  return {
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens:
          model.maxContextWindow ?? model.contextWindow,
        max_output_tokens: model.maxTokens,
        max_prompt_tokens: model.contextWindow,
      },
      object: "model_capabilities",
      supports: {
        adaptive_thinking: true,
        parallel_tool_calls: true,
        reasoning_effort: reasoningEffort,
        streaming: CODEX_PROVIDER_ADAPTER_INVARIANTS.streaming,
        tool_calls: true,
        vision: model.input.includes("image"),
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: model.id,
    model_picker_enabled: true,
    name: model.name,
    object: "model",
    preview: false,
    supported_endpoints: [
      ...CODEX_PROVIDER_ADAPTER_INVARIANTS.supportedEndpoints,
    ],
    vendor: "openai",
    version: "codex-static-fallback",
  }
}

export const getStaticCodexModels = (): ModelsResponse => ({
  data: CODEX_STATIC_FALLBACK_MODELS.map(normalizeStaticFallbackModel),
  object: "list",
})
