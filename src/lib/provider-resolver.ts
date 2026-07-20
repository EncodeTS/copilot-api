import {
  getRawProviderConfig,
  getProviderConfig,
  type ModelConfig,
  type ResolvedProviderConfig,
  resolveEffectiveProviderType,
  resolveProviderAuthType,
  type ProviderType,
} from "~/lib/config"
import { state } from "~/lib/state"
import { setupCodexToken } from "~/lib/token"

function isMissingCodexCredentialsError(error: unknown): boolean {
  return (
    error instanceof Error
    && error.message
      === "Codex credentials not found. Run `copilot-api auth login --provider codex` first."
  )
}

export interface ResolveProviderOptions {
  signal?: AbortSignal
}

export async function resolveProviderConfig(
  providerName: string,
  options: ResolveProviderOptions = {},
): Promise<ResolvedProviderConfig | null> {
  const normalizedProviderName = providerName.trim()
  if (!normalizedProviderName) {
    return null
  }

  if (normalizedProviderName === "codex") {
    const rawProviderConfig = getRawProviderConfig(normalizedProviderName)
    if (rawProviderConfig?.enabled === false) {
      return null
    }

    try {
      await setupCodexToken({ signal: options.signal })
    } catch (error) {
      if (isMissingCodexCredentialsError(error)) {
        return null
      }
      throw error
    }

    const providerConfig = getProviderConfig(normalizedProviderName)
    if (!providerConfig) {
      return null
    }

    return {
      ...providerConfig,
      apiKey: state.codexAccessToken ?? providerConfig.apiKey,
    }
  }

  return getProviderConfig(normalizedProviderName)
}

export interface ResolvedProviderModel {
  config: ResolvedProviderConfig
  forwardingConfig: ResolvedProviderConfig
  modelConfig: ModelConfig | undefined
  type: ProviderType
}

export async function resolveProviderModel(
  providerName: string,
  model: string,
  options: ResolveProviderOptions = {},
): Promise<ResolvedProviderModel | null> {
  const config = await resolveProviderConfig(providerName, options)
  if (!config) return null

  const type = resolveEffectiveProviderType(config, model)
  return {
    config,
    forwardingConfig:
      type === config.type ?
        config
      : {
          ...config,
          type,
          authType: resolveProviderAuthType(
            config.name,
            getRawProviderConfig(config.name)?.authType,
            type,
          ),
        },
    modelConfig: config.models?.[model],
    type,
  }
}
