import consola from "consola"
import { randomBytes } from "node:crypto"
import fs from "node:fs"

import { PATHS } from "./paths"

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
    adminApiKey?: string
  }
  providers?: Record<string, ProviderConfig>
  modelMappings?: Record<string, string>
  extraPrompts?: Record<string, string>
  contextManagement?: ContextManagementConfig
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  // Copilot rejects Anthropic's web_search server tool on /v1/messages, so a
  // Claude request that only asks for web search is switched to this model.
  // A `provider/model` alias is passed straight through to that provider's
  // (websearch-capable) message API, while a plain GPT model runs the search
  // via /responses. Leave unset to disable (the tool is then stripped).
  // Mixing web_search with other tools is not supported.
  messageApiWebSearchModel?: string
  claudeTokenMultiplier?: number
  responsesImageOptimization?: boolean
  responsesPayloadBudgetBytes?: number
  responsesPayloadRetryBudgetBytes?: number
  responsesPayloadSendHardLimitBytes?: number
  responsesImageNearBudgetRatio?: number
  responsesImagePreserveLatestUserGroup?: boolean
  responsesImageCompression?: boolean
  responsesImageCompressionFormat?: "jpeg" | "webp" | "auto"
  responsesImageCompressionConcurrency?: number
  responsesImageCompressionCacheEntries?: number
  responsesImageCompressionCacheBytes?: number
  responsesImageCompressionTimeoutMs?: number
  responsesImageCompressionMaxActionsPerRequest?: number
  responsesImageDecodeMaxPixels?: number
  responsesImageDecodeMaxLongEdge?: number
  responsesImageDecodeMaxFrames?: number
  responsesImageDecodeMaxBytesEstimate?: number
  responsesImageAllowReplacingLatestOnHardLimit?: boolean
  responsesImageAllowReplacingLatestOnRetry?: boolean
  responsesImageAllowNormalReplacement?: boolean
  responsesImageRetryRequiresHttp?: boolean
}

export interface ContextManagementConfig {
  messages?: boolean
  responses?: boolean
}

export interface ModelConfig {
  temperature?: number
  topP?: number
  topK?: number
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  pricing?: TokenUsagePricingConfig
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
  type?: ProviderType
}

export interface TokenUsagePricingTier {
  cachedInput?: number
  cacheCreationInput?: number
  explicitCachedInput?: number
  input?: number
  maxInputTokens?: number
  output?: number
}

export interface TokenUsagePricingConfig extends TokenUsagePricingTier {
  tiers?: Array<TokenUsagePricingTier>
}

export type ProviderAuthType = "authorization" | "oauth2" | "x-api-key"
export const SUPPORTED_PROVIDER_TYPES = [
  "anthropic",
  "openai-compatible",
  "openai-responses",
] as const
export type ProviderType = (typeof SUPPORTED_PROVIDER_TYPES)[number]
export type ToolContentSupportType = "array" | "image" | "pdf"

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
}

export interface ResolvedProviderConfig {
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  authType: ProviderAuthType
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
}

const GPT_MODEL_PATTERN = /^gpt-(\d+)(?:\.(\d+))?/

function isGpt53OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 3
}

export function isGpt56OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 6
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:  
- Share intermediary updates in \`commentary\` channel.  
- After you have completed all your work, send a message to the \`final\` channel.  

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements (“Done —”, “Got it”, “Great question, ”) or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

const legacyResponsesApiCompactThresholds: Record<string, number> = {
  "gpt-5.4": 217_600,
  "gpt-5.5": 217_600,
  "gpt-5.6-sol": 231_200,
  "gpt-5.6-terra": 231_200,
  "gpt-5.6-luna": 231_200,
}

const defaultContextManagement = {
  messages: false,
  responses: false,
} satisfies Required<ContextManagementConfig>

const responsesImageConfigDefaults = {
  responsesImageOptimization: true,
  responsesPayloadBudgetBytes: 4_980_736,
  responsesPayloadRetryBudgetBytes: 4_718_592,
  responsesPayloadSendHardLimitBytes: 5_226_496,
  responsesImageNearBudgetRatio: 0.92,
  responsesImagePreserveLatestUserGroup: true,
  responsesImageCompression: true,
  responsesImageCompressionFormat: "jpeg" as const,
  responsesImageCompressionConcurrency: 8,
  responsesImageCompressionCacheEntries: 128,
  responsesImageCompressionCacheBytes: 268_435_456,
  responsesImageCompressionTimeoutMs: 2000,
  responsesImageCompressionMaxActionsPerRequest: 64,
  responsesImageDecodeMaxPixels: 67_108_864,
  responsesImageDecodeMaxLongEdge: 16_384,
  responsesImageDecodeMaxFrames: 1,
  responsesImageDecodeMaxBytesEstimate: 268_435_456,
  responsesImageAllowReplacingLatestOnHardLimit: true,
  responsesImageAllowReplacingLatestOnRetry: false,
  responsesImageAllowNormalReplacement: false,
  responsesImageRetryRequiresHttp: true,
}

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  modelMappings: {},
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
  },
  contextManagement: defaultContextManagement,
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
  },
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  useResponsesApiWebSearch: true,
  messageApiWebSearchModel: "gpt-5-mini",
  ...responsesImageConfigDefaults,
}

let cachedConfig: AppConfig | null = null
const warnedInvalidConfigKeys = new Set<string>()

function normalizeAdminApiKey(adminApiKey: unknown): string | null {
  if (typeof adminApiKey !== "string") {
    if (adminApiKey !== undefined) {
      consola.warn(
        "Invalid auth.adminApiKey config. Expected a non-empty string.",
      )
    }
    return null
  }

  const normalizedAdminApiKey = adminApiKey.trim()
  if (!normalizedAdminApiKey) {
    consola.warn(
      "Invalid auth.adminApiKey config. Expected a non-empty string.",
    )
    return null
  }

  return normalizedAdminApiKey
}

function generateAdminApiKey(): string {
  return randomBytes(32).toString("hex")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      return
    }
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return defaultConfig
  }
}

function readEditableConfigFromDisk(): AppConfig {
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {}
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is not valid JSON: ${PATHS.CONFIG_PATH}`)
    }
    throw error
  }
}

function writeConfigToDisk(config: AppConfig): void {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.writeFileSync(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
}

export function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalizedConfig = { ...config } as AppConfig & {
    parityFirst?: unknown
    smallModel?: unknown
  }
  const hasDeprecatedRequestRewriteConfig =
    Object.hasOwn(normalizedConfig, "parityFirst")
    || Object.hasOwn(normalizedConfig, "smallModel")
  delete normalizedConfig.parityFirst
  delete normalizedConfig.smallModel

  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}
  const responsesApiCompactThresholds =
    config.modelResponsesApiCompactThresholds ?? {}
  const migratedResponsesApiCompactThresholds = Object.fromEntries(
    Object.entries(responsesApiCompactThresholds).filter(
      ([model, threshold]) =>
        legacyResponsesApiCompactThresholds[model] !== threshold,
    ),
  )
  const hasLegacyResponsesApiCompactThresholds =
    Object.keys(migratedResponsesApiCompactThresholds).length
    !== Object.keys(responsesApiCompactThresholds).length
  const modelReasoningEfforts = config.modelReasoningEfforts ?? {}
  const defaultModelReasoningEfforts = defaultConfig.modelReasoningEfforts ?? {}
  const contextManagement = normalizeContextManagementConfig(
    config.contextManagement,
  )
  const defaultContextManagementConfig = defaultConfig.contextManagement ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  const missingReasoningEffortModels = Object.keys(
    defaultModelReasoningEfforts,
  ).filter((model) => !Object.hasOwn(modelReasoningEfforts, model))
  const missingContextManagementKeys = Object.keys(
    defaultContextManagementConfig,
  ).filter((key) => !Object.hasOwn(contextManagement, key))

  const hasExtraPromptChanges = missingExtraPromptModels.length > 0
  const hasReasoningEffortChanges = missingReasoningEffortModels.length > 0
  const hasContextManagementChanges = missingContextManagementKeys.length > 0
  const missingResponsesImageConfigKeys = Object.keys(
    responsesImageConfigDefaults,
  ).filter((key) => !Object.hasOwn(config, key))
  const hasResponsesImageConfigChanges =
    missingResponsesImageConfigKeys.length > 0

  if (
    !hasExtraPromptChanges
    && !hasReasoningEffortChanges
    && !hasLegacyResponsesApiCompactThresholds
    && !hasContextManagementChanges
    && !hasDeprecatedRequestRewriteConfig
    && !hasResponsesImageConfigChanges
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...normalizedConfig,
      contextManagement: {
        ...defaultContextManagementConfig,
        ...contextManagement,
      },
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
      ...(config.modelResponsesApiCompactThresholds !== undefined && {
        modelResponsesApiCompactThresholds:
          migratedResponsesApiCompactThresholds,
      }),
      modelReasoningEfforts: {
        ...defaultModelReasoningEfforts,
        ...modelReasoningEfforts,
      },
      ...Object.fromEntries(
        Object.entries(responsesImageConfigDefaults).map(([key, value]) => [
          key,
          (config as Record<string, unknown>)[key] ?? value,
        ]),
      ),
    },
    changed: true,
  }
}

function normalizeContextManagementConfig(
  value: ContextManagementConfig | undefined,
): ContextManagementConfig {
  if (!value || typeof value !== "object") {
    return {}
  }

  return {
    ...(typeof value.messages === "boolean" ?
      { messages: value.messages }
    : {}),
    ...(typeof value.responses === "boolean" ?
      { responses: value.responses }
    : {}),
  }
}

function ensureAdminApiKey(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalizedAdminApiKey = normalizeAdminApiKey(config.auth?.adminApiKey)
  if (normalizedAdminApiKey) {
    if (config.auth?.adminApiKey === normalizedAdminApiKey) {
      return { mergedConfig: config, changed: false }
    }

    return {
      mergedConfig: {
        ...config,
        auth: {
          ...config.auth,
          adminApiKey: normalizedAdminApiKey,
        },
      },
      changed: true,
    }
  }

  const editableConfig = readEditableConfigFromDisk()
  const { mergedConfig } = mergeDefaultConfig({
    ...editableConfig,
    auth: {
      ...editableConfig.auth,
      adminApiKey: generateAdminApiKey(),
    },
  })

  return { mergedConfig, changed: true }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()
  const { mergedConfig, changed } = mergeDefaultConfig(config)
  const {
    mergedConfig: mergedConfigWithAdminApiKey,
    changed: adminApiKeyChanged,
  } = ensureAdminApiKey(mergedConfig)
  const shouldPersistConfig = changed || adminApiKeyChanged

  if (shouldPersistConfig) {
    try {
      writeConfigToDisk(mergedConfigWithAdminApiKey)
    } catch (writeError) {
      if (adminApiKeyChanged) {
        throw writeError
      }

      consola.warn(
        "Failed to write merged default config to config file",
        writeError,
      )
    }
  }

  cachedConfig = mergedConfigWithAdminApiKey
  return mergedConfigWithAdminApiKey
}

export function getConfig(): AppConfig {
  cachedConfig ??= mergeDefaultConfig(readConfigFromDisk()).mergedConfig
  return cachedConfig
}

export function reloadConfig(): AppConfig {
  return mergeConfigWithDefaults()
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const userPrompt = config.extraPrompts?.[model]
  if (userPrompt !== undefined) {
    return userPrompt
  }
  return isGpt53OrAbove(model) ? gpt5CommentaryPrompt : ""
}

export function getModelMappings(): Record<string, string> {
  const config = getConfig()
  const modelMappings = config.modelMappings
  if (!modelMappings) {
    return { ...defaultConfig.modelMappings }
  }

  const validMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (
      !sourceModel
      || typeof targetModel !== "string"
      || targetModel.length === 0
    ) {
      continue
    }
    validMappings[sourceModel] = targetModel
  }

  return validMappings
}

function validateModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const validatedMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (!sourceModel || !targetModel) {
      throw new Error(
        "Each model mapping must use non-empty source and target values.",
      )
    }
    validatedMappings[sourceModel] = targetModel
  }

  return validatedMappings
}

export function setModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const nextConfig = {
    ...readEditableConfigFromDisk(),
    modelMappings: validateModelMappings(modelMappings),
  }

  writeConfigToDisk(nextConfig)
  cachedConfig = reloadConfig()
  return getModelMappings()
}

export function resolveMappedModel(model: string): string {
  return getModelMappings()[model] ?? model
}

export function isContextManagementEnabledForMessages(): boolean {
  const config = getConfig()
  return config.contextManagement?.messages ?? defaultContextManagement.messages
}

export function isContextManagementEnabledForResponses(): boolean {
  const config = getConfig()
  return (
    config.contextManagement?.responses ?? defaultContextManagement.responses
  )
}

export function getModelResponsesApiCompactThreshold(
  model: string,
): number | undefined {
  const config = getConfig()
  const threshold = config.modelResponsesApiCompactThresholds?.[model]

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const config = getConfig()
  const userEffort = config.modelReasoningEfforts?.[model]
  if (userEffort !== undefined) {
    return userEffort
  }
  return isGpt53OrAbove(model) ? "xhigh" : "high"
}

export function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

export function isSupportedProviderType(value: string): value is ProviderType {
  return SUPPORTED_PROVIDER_TYPES.includes(value as ProviderType)
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

export function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
  providerType: ProviderType,
): ProviderAuthType {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  if (authType === undefined) {
    return defaultAuthType
  }

  if (authType === "x-api-key") {
    return "x-api-key"
  }

  if (authType === "oauth2") {
    if (providerName === "codex") {
      return authType
    }

    consola.warn(
      `Provider ${providerName} has authType 'oauth2', which is only supported by the builtin codex provider, falling back to ${defaultAuthType}`,
    )
    return defaultAuthType
  }

  if (authType === "authorization") {
    return authType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to ${defaultAuthType}`,
  )
  return defaultAuthType
}

function isProviderApiKeyRequired(
  providerName: string,
  authType: ProviderAuthType,
): boolean {
  return !(providerName === "codex" && authType === "oauth2")
}

export function getRawProviderConfig(name: string): ProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  return config.providers?.[providerName] ?? null
}

export function setProviderConfig(
  name: string,
  provider: ProviderConfig,
): ProviderConfig {
  const providerName = name.trim()
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (isReservedProviderName(providerName)) {
    throw new Error(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
  }

  const editableConfig = readEditableConfigFromDisk()
  const nextConfig = {
    ...editableConfig,
    providers: {
      ...editableConfig.providers,
      [providerName]: provider,
    },
  }

  writeConfigToDisk(nextConfig)
  cachedConfig = reloadConfig()
  return getRawProviderConfig(providerName) ?? provider
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  if (isReservedProviderName(providerName)) {
    consola.warn(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
    return null
  }

  const provider = getRawProviderConfig(providerName)
  if (!provider) {
    return null
  }

  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? "anthropic"
  if (!isSupportedProviderType(type)) {
    consola.warn(
      `Provider ${providerName} is ignored because type '${type}' is not supported`,
    )
    return null
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "")
  const authType = resolveProviderAuthType(
    providerName,
    provider.authType,
    type,
  )
  const apiKey = (provider.apiKey ?? "").trim()
  const missingFields = [
    ...(baseUrl ? [] : ["baseUrl"]),
    ...(isProviderApiKeyRequired(providerName, authType) && !apiKey ?
      ["apiKey"]
    : []),
  ]

  if (missingFields.length > 0) {
    consola.warn(
      `Provider ${providerName} is enabled but missing ${missingFields.join(" or ")}`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    apiKey,
    authType,
    pricingCurrency: normalizePricingCurrency(provider.pricingCurrency),
    models: provider.models,
  }
}

export function resolveEffectiveProviderType(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ProviderType {
  const modelConfig = providerConfig.models?.[model]
  if (modelConfig?.type && isSupportedProviderType(modelConfig.type)) {
    return modelConfig.type
  }
  return providerConfig.type
}

function normalizePricingCurrency(
  value: string | undefined,
): string | undefined {
  const currency = value?.trim().toUpperCase()
  return currency || undefined
}

export function listEnabledProviders(): Array<string> {
  const config = getConfig()
  const providerNames = Object.keys(config.providers ?? {})
  return providerNames.filter((name) => getProviderConfig(name) !== null)
}

export function isReservedProviderName(name: string): boolean {
  return name.trim() === "copilot"
}

export function isMessagesApiEnabled(): boolean {
  const config = getConfig()
  return config.useMessagesApi ?? true
}

export function isResponsesApiWebSocketEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSocket ?? true
}

export function isResponsesImageOptimizationEnabled(): boolean {
  return getBooleanConfig(
    "responsesImageOptimization",
    responsesImageConfigDefaults.responsesImageOptimization,
  )
}

export function getResponsesPayloadBudgetBytes(): number {
  const hardLimit = getResponsesPayloadSendHardLimitBytes()
  const budget = getIntegerConfig(
    "responsesPayloadBudgetBytes",
    responsesImageConfigDefaults.responsesPayloadBudgetBytes,
    { min: 1_048_576 },
  )

  if (budget > hardLimit) {
    warnInvalidConfigOnce(
      "responsesPayloadBudgetBytes:ordering",
      "Invalid responsesPayloadBudgetBytes config. Expected it to be <= responsesPayloadSendHardLimitBytes, using default.",
    )
    return Math.min(
      responsesImageConfigDefaults.responsesPayloadBudgetBytes,
      hardLimit,
    )
  }

  return budget
}

export function getResponsesPayloadRetryBudgetBytes(): number {
  const budget = getResponsesPayloadBudgetBytes()
  const retryBudget = getIntegerConfig(
    "responsesPayloadRetryBudgetBytes",
    responsesImageConfigDefaults.responsesPayloadRetryBudgetBytes,
    { min: 1_048_576 },
  )

  if (retryBudget > budget) {
    warnInvalidConfigOnce(
      "responsesPayloadRetryBudgetBytes:ordering",
      "Invalid responsesPayloadRetryBudgetBytes config. Expected it to be <= responsesPayloadBudgetBytes, using default.",
    )
    return Math.min(
      responsesImageConfigDefaults.responsesPayloadRetryBudgetBytes,
      budget,
    )
  }

  return retryBudget
}

export function getResponsesPayloadSendHardLimitBytes(): number {
  return getIntegerConfig(
    "responsesPayloadSendHardLimitBytes",
    responsesImageConfigDefaults.responsesPayloadSendHardLimitBytes,
    { min: 1_048_576 },
  )
}

export function getResponsesImageNearBudgetRatio(): number {
  return getNumberConfig(
    "responsesImageNearBudgetRatio",
    responsesImageConfigDefaults.responsesImageNearBudgetRatio,
    { max: 1, min: 0.01 },
  )
}

export function shouldPreserveLatestUserImageGroup(): boolean {
  return getBooleanConfig(
    "responsesImagePreserveLatestUserGroup",
    responsesImageConfigDefaults.responsesImagePreserveLatestUserGroup,
  )
}

export function isResponsesImageCompressionEnabled(): boolean {
  return getBooleanConfig(
    "responsesImageCompression",
    responsesImageConfigDefaults.responsesImageCompression,
  )
}

export function getResponsesImageCompressionFormat(): "jpeg" | "webp" | "auto" {
  const value = getConfig().responsesImageCompressionFormat
  if (value === "jpeg" || value === "webp" || value === "auto") {
    return value
  }

  if (value !== undefined) {
    warnInvalidConfigOnce(
      "responsesImageCompressionFormat",
      "Invalid responsesImageCompressionFormat config. Expected jpeg, webp, or auto; using default.",
    )
  }

  return responsesImageConfigDefaults.responsesImageCompressionFormat
}

export function getResponsesImageCompressionConcurrency(): number {
  return getIntegerConfig(
    "responsesImageCompressionConcurrency",
    responsesImageConfigDefaults.responsesImageCompressionConcurrency,
    { max: 8, min: 1 },
  )
}

export function getResponsesImageCompressionCacheEntries(): number {
  return getIntegerConfig(
    "responsesImageCompressionCacheEntries",
    responsesImageConfigDefaults.responsesImageCompressionCacheEntries,
    { min: 0 },
  )
}

export function getResponsesImageCompressionCacheBytes(): number {
  return getIntegerConfig(
    "responsesImageCompressionCacheBytes",
    responsesImageConfigDefaults.responsesImageCompressionCacheBytes,
    { min: 0 },
  )
}

export function getResponsesImageCompressionTimeoutMs(): number {
  return getIntegerConfig(
    "responsesImageCompressionTimeoutMs",
    responsesImageConfigDefaults.responsesImageCompressionTimeoutMs,
    { min: 1 },
  )
}

export function getResponsesImageCompressionMaxActionsPerRequest(): number {
  return getIntegerConfig(
    "responsesImageCompressionMaxActionsPerRequest",
    responsesImageConfigDefaults.responsesImageCompressionMaxActionsPerRequest,
    { min: 1 },
  )
}

export function getResponsesImageDecodeSafetyLimits(): {
  maxBytesEstimate: number
  maxFrames: number
  maxLongEdge: number
  maxPixels: number
} {
  return {
    maxBytesEstimate: getIntegerConfig(
      "responsesImageDecodeMaxBytesEstimate",
      responsesImageConfigDefaults.responsesImageDecodeMaxBytesEstimate,
      { min: 1 },
    ),
    maxFrames: getIntegerConfig(
      "responsesImageDecodeMaxFrames",
      responsesImageConfigDefaults.responsesImageDecodeMaxFrames,
      { min: 1 },
    ),
    maxLongEdge: getIntegerConfig(
      "responsesImageDecodeMaxLongEdge",
      responsesImageConfigDefaults.responsesImageDecodeMaxLongEdge,
      { min: 1 },
    ),
    maxPixels: getIntegerConfig(
      "responsesImageDecodeMaxPixels",
      responsesImageConfigDefaults.responsesImageDecodeMaxPixels,
      { min: 1 },
    ),
  }
}

export function isResponsesImageLatestReplacementAllowedOnRetry(): boolean {
  return getBooleanConfig(
    "responsesImageAllowReplacingLatestOnRetry",
    responsesImageConfigDefaults.responsesImageAllowReplacingLatestOnRetry,
  )
}

export function isResponsesImageLatestReplacementAllowedOnHardLimit(): boolean {
  return getBooleanConfig(
    "responsesImageAllowReplacingLatestOnHardLimit",
    responsesImageConfigDefaults.responsesImageAllowReplacingLatestOnHardLimit,
  )
}

export function isResponsesImageNormalReplacementAllowed(): boolean {
  return getBooleanConfig(
    "responsesImageAllowNormalReplacement",
    responsesImageConfigDefaults.responsesImageAllowNormalReplacement,
  )
}

export function shouldResponsesImageRetryRequireHttp(): boolean {
  return getBooleanConfig(
    "responsesImageRetryRequiresHttp",
    responsesImageConfigDefaults.responsesImageRetryRequiresHttp,
  )
}

function getBooleanConfig(key: keyof AppConfig, fallback: boolean): boolean {
  const value = getConfig()[key]
  if (value === undefined) {
    return fallback
  }
  if (typeof value === "boolean") {
    return value
  }

  warnInvalidConfigOnce(
    key,
    `Invalid ${key} config. Expected a boolean, using default.`,
  )
  return fallback
}

function getIntegerConfig(
  key: keyof AppConfig,
  fallback: number,
  options: { max?: number; min?: number } = {},
): number {
  const value = getNumberConfig(key, fallback, options)
  return Math.floor(value)
}

function getNumberConfig(
  key: keyof AppConfig,
  fallback: number,
  { max, min }: { max?: number; min?: number } = {},
): number {
  const value = getConfig()[key]
  if (value === undefined) {
    return fallback
  }
  if (
    typeof value === "number"
    && Number.isFinite(value)
    && (min === undefined || value >= min)
    && (max === undefined || value <= max)
  ) {
    return value
  }

  const range =
    min !== undefined && max !== undefined ? ` between ${min} and ${max}`
    : min !== undefined ? ` >= ${min}`
    : max !== undefined ? ` <= ${max}`
    : ""
  warnInvalidConfigOnce(
    key,
    `Invalid ${key} config. Expected a finite number${range}, using default.`,
  )
  return fallback
}

function warnInvalidConfigOnce(key: string, message: string): void {
  if (warnedInvalidConfigKeys.has(key)) {
    return
  }

  warnedInvalidConfigKeys.add(key)
  consola.warn(message)
}

export function getAnthropicApiKey(): string | undefined {
  const config = getConfig()
  return config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? undefined
}

export function isResponsesApiWebSearchEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSearch ?? true
}

export function getMessageApiWebSearchModel(): string | undefined {
  const config = getConfig()
  const model = config.messageApiWebSearchModel ?? "gpt-5-mini"
  return model && model.trim().length > 0 ? model : undefined
}

export function getClaudeTokenMultiplier(): number {
  const config = getConfig()
  return config.claudeTokenMultiplier ?? 1.15
}
