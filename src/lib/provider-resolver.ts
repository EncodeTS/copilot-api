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

export interface ProviderResolverPort {
  resolveConfig: (
    providerName: string,
    options?: ResolveProviderOptions,
  ) => Promise<ResolvedProviderConfig | null>
  resolveModel: (
    providerName: string,
    model: string,
    options?: ResolveProviderOptions,
  ) => Promise<ResolvedProviderModel | null>
}

export interface ProviderResolverComposition {
  getCodexAccessToken?: () => string | undefined
  getProviderConfig?: typeof getProviderConfig
  getRawProviderConfig?: typeof getRawProviderConfig
  setupCodexToken?: typeof setupCodexToken
}

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

export interface ResolvedProviderModel {
  config: ResolvedProviderConfig
  forwardingConfig: ResolvedProviderConfig
  modelConfig: ModelConfig | undefined
  type: ProviderType
}

export const createProviderResolver = (
  composition: ProviderResolverComposition = {},
): ProviderResolverPort => {
  const dependencies = Object.freeze({
    getCodexAccessToken:
      composition.getCodexAccessToken ?? (() => state.codexAccessToken),
    getProviderConfig: composition.getProviderConfig ?? getProviderConfig,
    getRawProviderConfig:
      composition.getRawProviderConfig ?? getRawProviderConfig,
    setupCodexToken: composition.setupCodexToken ?? setupCodexToken,
  })

  const resolveConfig: ProviderResolverPort["resolveConfig"] = async (
    providerName,
    options = {},
  ) => {
    const normalizedProviderName = providerName.trim()
    if (!normalizedProviderName) {
      return null
    }

    if (normalizedProviderName === "codex") {
      const rawProviderConfig = dependencies.getRawProviderConfig(
        normalizedProviderName,
      )
      if (rawProviderConfig?.enabled === false) {
        return null
      }

      try {
        await dependencies.setupCodexToken({ signal: options.signal })
      } catch (error) {
        if (isMissingCodexCredentialsError(error)) {
          return null
        }
        throw error
      }

      const providerConfig = dependencies.getProviderConfig(
        normalizedProviderName,
      )
      if (!providerConfig) {
        return null
      }

      return {
        ...providerConfig,
        apiKey: dependencies.getCodexAccessToken() ?? providerConfig.apiKey,
      }
    }

    return dependencies.getProviderConfig(normalizedProviderName)
  }

  const resolveModel: ProviderResolverPort["resolveModel"] = async (
    providerName,
    model,
    options = {},
  ) => {
    const config = await resolveConfig(providerName, options)
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
              dependencies.getRawProviderConfig(config.name)?.authType,
              type,
            ),
          },
      modelConfig: config.models?.[model],
      type,
    }
  }

  return Object.freeze({ resolveConfig, resolveModel })
}

export const resolveProviderConfig: ProviderResolverPort["resolveConfig"] =
  async (providerName, options) =>
    await createProviderResolver().resolveConfig(providerName, options)

export const resolveProviderModel: ProviderResolverPort["resolveModel"] =
  async (providerName, model, options) =>
    await createProviderResolver().resolveModel(providerName, model, options)
