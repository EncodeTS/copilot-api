import consola from "consola"

import { copilotBaseUrl, copilotModelsHeaders } from "~/lib/api-config"
import { isCopilotUseLocalModelsEnabled } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import localModelsData from "./local-models.json" with { type: "json" }

export const getModels = async () => {
  if (isCopilotUseLocalModelsEnabled()) {
    // Compatibility mode: load model list from local JSON file,
    // and enable models with policy.state === "disabled" to be selectable in the picker
    const models = localModelsData as ModelsResponse
    for (const model of models.data) {
      if (model.policy?.state === "disabled") {
        model.model_picker_enabled = true
      }
    }
    consola.info(`Loaded ${models.data.length} models from local file`)
    return models
  }

  consola.info(`Fetching models from ${copilotBaseUrl(state)}/models`)
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotModelsHeaders(state),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()

    consola.error("Failed to get models response body", errorText)

    throw new HTTPError("Failed to get models", response)
  }

  return (await response.json()) as ModelsResponse
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
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
}
