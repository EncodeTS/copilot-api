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

/**
 * Deep-frozen catalogs, keyed on the identity of the array they were built
 * from. `refreshModels` replaces `state.models` wholesale, so identity changes
 * exactly when the catalog does and a stale entry can never be served.
 *
 * Without this, every `/v1/messages` and `/v1/messages/count_tokens` request
 * deep-copied and deep-froze the entire model catalog — measured at roughly
 * 1,500 object-graph nodes for a 25-model enterprise catalog — to produce a
 * value that is identical between 30-minute refreshes.
 */
const frozenCatalogs = new WeakMap<object, ReadonlyArray<Model>>()
const EMPTY_CATALOG: ReadonlyArray<Model> = Object.freeze([])

const freezeCatalog = (models: ReadonlyArray<Model>): ReadonlyArray<Model> => {
  if (models.length === 0) {
    // `state.models?.data ?? []` allocates a fresh array whenever the catalog
    // is absent, which would never hit the cache.
    return EMPTY_CATALOG
  }

  const cached = frozenCatalogs.get(models)
  if (cached) {
    return cached
  }

  const frozen = deepFreeze(structuredClone(models) as Array<Model>)
  frozenCatalogs.set(models, frozen)
  return frozen
}

export const createPreparedMessagesPolicyPort = (
  source: (
    requestedModel?: string,
  ) => PreparedMessagesPolicySnapshot = createRuntimePolicySnapshot,
): PreparedMessagesPolicyPort =>
  Object.freeze({
    snapshot: (requestedModel?: string) => {
      const { models, ...rest } = source(requestedModel)
      // Everything except the catalog is cheap and request-shaped, so it keeps
      // its per-call copy; the catalog is shared. Both halves stay deeply
      // frozen, so the immutability contract is unchanged.
      const frozenRest = deepFreeze(structuredClone(rest))
      return Object.freeze({
        ...frozenRest,
        models: freezeCatalog(models),
      })
    },
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
