import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"

import { HTTPError } from "~/lib/error"
import {
  normalizeGatewayReasoningEfforts,
  type GatewayReasoningEffort,
} from "~/lib/reasoning-effort"
import { state } from "~/lib/state"

export const getModels = async () => {
  consola.info(`Fetching models from ${copilotBaseUrl(state)}/models`)
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotModelsHeaders(state),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()

    consola.error("Failed to get models response body", errorText)

    throw new HTTPError("Failed to get models", response)
  }

  const models = (await response.json()) as ModelsResponse
  return {
    ...models,
    data: models.data.map(normalizeModelReasoningEfforts),
  }
}

const normalizeModelReasoningEfforts = (model: Model): Model => {
  const supports = model.capabilities.supports
  if (!Object.hasOwn(supports, "reasoning_effort")) {
    return model
  }

  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      supports: {
        ...supports,
        reasoning_effort: normalizeGatewayReasoningEfforts(
          supports.reasoning_effort,
        ).efforts,
      },
    },
  }
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  max_thinking_budget?: number
  min_thinking_budget?: number
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  adaptive_thinking?: boolean
  reasoning_effort?: Array<GatewayReasoningEffort>
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer?: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview?: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
}
