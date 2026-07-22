import {
  getConfig,
  getExtraPromptForModel,
  getModelMappings,
  getReasoningEffortForModel,
} from "~/lib/config"
import { deepFreeze } from "~/lib/deep-freeze"
import type { GatewayReasoningEffort } from "~/lib/reasoning-effort"
import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"

export interface PreparedMessagesPolicySnapshot {
  readonly catalogLoaded: boolean
  readonly claudeTokenMultiplier: number
  readonly contextManagementMessages: boolean
  readonly extraPrompt: string
  readonly modelMappings: Readonly<Record<string, string>>
  readonly modelResponsesApiCompactThresholds: Readonly<Record<string, number>>
  readonly models: ReadonlyArray<Model>
  readonly reasoningEffort: GatewayReasoningEffort
  readonly useMessagesApi: boolean
  readonly useResponsesApiWebSocket: boolean
}

export interface PreparedMessagesPolicyPort {
  snapshot: (requestedModel?: string) => PreparedMessagesPolicySnapshot
}

export const createPreparedMessagesPolicyPort = (
  source: (
    requestedModel?: string,
  ) => PreparedMessagesPolicySnapshot = createRuntimePolicySnapshot,
): PreparedMessagesPolicyPort =>
  Object.freeze({
    snapshot: (requestedModel?: string) =>
      deepFreeze(structuredClone(source(requestedModel))),
  })

export const preparedMessagesPolicy = createPreparedMessagesPolicyPort()

export const resolvePreparedMessagesModel = (
  policy: PreparedMessagesPolicySnapshot,
  model: string,
): string =>
  Object.hasOwn(policy.modelMappings, model) ?
    policy.modelMappings[model]
  : model

function createRuntimePolicySnapshot(
  requestedModel = "",
): PreparedMessagesPolicySnapshot {
  const config = getConfig()
  const modelMappings = getModelMappings()
  const resolvedModel =
    Object.hasOwn(modelMappings, requestedModel) ?
      modelMappings[requestedModel]
    : requestedModel
  const contextManagementMessages =
    (
      config.migrationState?.contextManagementMessages
      === "pending_user_decision"
    ) ?
      false
    : (config.contextManagement?.messages ?? true)

  return {
    catalogLoaded: state.models !== undefined,
    claudeTokenMultiplier: config.claudeTokenMultiplier ?? 1.15,
    contextManagementMessages,
    extraPrompt: getExtraPromptForModel(resolvedModel),
    modelMappings,
    modelResponsesApiCompactThresholds:
      config.modelResponsesApiCompactThresholds ?? {},
    models: state.models?.data ?? [],
    reasoningEffort: getReasoningEffortForModel(resolvedModel),
    useMessagesApi: config.useMessagesApi ?? true,
    useResponsesApiWebSocket: config.useResponsesApiWebSocket ?? true,
  }
}
