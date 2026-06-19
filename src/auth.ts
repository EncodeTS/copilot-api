#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  getRawProviderConfig,
  isSupportedProviderType,
  normalizeProviderBaseUrl,
  setProviderConfig,
  SUPPORTED_PROVIDER_TYPES,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from "./lib/config"
import { loginCodex } from "./lib/oauth/codex"
import { PATHS, ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { persistCodexCredentials, setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  provider?: string
  verbose: boolean
  showToken: boolean
}

const authArgs = {
  provider: {
    type: "string",
    description:
      "Provider to log in with or configure (copilot, codex, custom)",
  },
  verbose: {
    alias: "v",
    type: "boolean",
    default: false,
    description: "Enable verbose logging",
  },
  "show-token": {
    type: "boolean",
    default: false,
    description: "Show provider access token on auth",
  },
} as const

const BUILTIN_PROVIDER_NAMES = ["copilot", "codex"] as const
const AUTH_PROVIDER_NAMES = [...BUILTIN_PROVIDER_NAMES, "custom"] as const
const CUSTOM_PROVIDER_AUTH_TYPE_OPTION = "__default__"
const CUSTOM_PROVIDER_AUTH_TYPES = ["x-api-key", "authorization"] as const

type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number]
type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number]
type CustomProviderAuthType = (typeof CUSTOM_PROVIDER_AUTH_TYPES)[number]

const BUILTIN_PROVIDER_LABELS: Record<BuiltinProviderName, string> = {
  copilot: "GitHub Copilot",
  codex: "OpenAI Codex",
}
const AUTH_PROVIDER_LABELS: Record<AuthProviderName, string> = {
  ...BUILTIN_PROVIDER_LABELS,
  custom: "Custom provider",
}

function isAuthProviderName(
  providerName: string,
): providerName is AuthProviderName {
  return AUTH_PROVIDER_NAMES.includes(providerName as AuthProviderName)
}

function isCustomProviderAuthType(
  value: string,
): value is CustomProviderAuthType {
  return CUSTOM_PROVIDER_AUTH_TYPES.includes(value as CustomProviderAuthType)
}

async function resolveProviderSelection(
  providerArg: string | undefined,
): Promise<AuthProviderName> {
  const availableProviders = [...AUTH_PROVIDER_NAMES]

  if (providerArg !== undefined) {
    const providerName = providerArg.trim()
    if (!isAuthProviderName(providerName)) {
      throw new Error(
        `Unknown provider '${providerArg}'. Expected one of: ${availableProviders.join(", ")}`,
      )
    }
    return providerName
  }

  if (availableProviders.length === 1) {
    return availableProviders[0]
  }

  const provider = await consola.prompt("Select a provider to log in with", {
    type: "select",
    options: availableProviders.map((providerName) => ({
      label: `${AUTH_PROVIDER_LABELS[providerName]} (${providerName})`,
      value: providerName,
    })),
  })

  if (!provider || !isAuthProviderName(provider)) {
    throw new Error("No provider selected")
  }

  return provider
}

function assertCustomProviderName(providerName: string): void {
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(providerName)) {
    throw new Error(
      "Provider name must start with a letter or number and contain only letters, numbers, underscores, or hyphens",
    )
  }

  if (providerName === "copilot" || providerName === "codex") {
    throw new Error(
      `Provider name '${providerName}' is reserved for a builtin provider`,
    )
  }
}

async function promptRequiredText(
  message: string,
  fieldName: string,
): Promise<string> {
  const value = await consola.prompt(message, { type: "text" })
  const normalizedValue = typeof value === "string" ? value.trim() : ""
  if (!normalizedValue) {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
  return normalizedValue
}

async function promptCustomProviderName(): Promise<string> {
  const providerName = await promptRequiredText(
    "Enter provider name",
    "Provider name",
  )
  assertCustomProviderName(providerName)
  return providerName
}

async function promptCustomProviderType(): Promise<ProviderType> {
  const providerType = await consola.prompt("Select provider type", {
    type: "select",
    options: SUPPORTED_PROVIDER_TYPES.map((type) => ({
      label: type,
      value: type,
    })),
  })

  if (
    typeof providerType !== "string"
    || !isSupportedProviderType(providerType)
  ) {
    throw new Error("No provider type selected")
  }

  return providerType
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

async function promptCustomProviderAuthType(
  providerType: ProviderType,
): Promise<ProviderAuthType | undefined> {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  const authType = await consola.prompt("Select provider auth type", {
    type: "select",
    options: [
      {
        label: `Default (${defaultAuthType})`,
        value: CUSTOM_PROVIDER_AUTH_TYPE_OPTION,
      },
      ...CUSTOM_PROVIDER_AUTH_TYPES.map((value) => ({
        label: value,
        value,
      })),
    ],
  })

  if (authType === CUSTOM_PROVIDER_AUTH_TYPE_OPTION) {
    return undefined
  }

  if (typeof authType === "string" && isCustomProviderAuthType(authType)) {
    return authType
  }

  throw new Error("No provider auth type selected")
}

function buildCustomProviderConfig(
  existingProviderConfig: ProviderConfig,
  options: {
    apiKey: string
    authType?: ProviderAuthType
    baseUrl: string
    type: ProviderType
  },
): ProviderConfig {
  return {
    type: options.type,
    enabled: true,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.authType ? { authType: options.authType } : {}),
    ...(existingProviderConfig.models ?
      { models: existingProviderConfig.models }
    : {}),
  }
}

async function configureCustomProvider(): Promise<void> {
  const providerName = await promptCustomProviderName()
  const type = await promptCustomProviderType()
  const baseUrl = normalizeProviderBaseUrl(
    await promptRequiredText("Enter provider baseUrl", "baseUrl"),
  )
  if (!baseUrl) {
    throw new Error("baseUrl must be a non-empty string")
  }

  const apiKey = await promptRequiredText("Enter provider apiKey", "apiKey")
  const authType = await promptCustomProviderAuthType(type)
  const existingProviderConfig = getRawProviderConfig(providerName) ?? {}

  setProviderConfig(
    providerName,
    buildCustomProviderConfig(existingProviderConfig, {
      apiKey,
      authType,
      baseUrl,
      type,
    }),
  )

  consola.success(
    `Custom provider '${providerName}' written to ${PATHS.CONFIG_PATH}`,
  )
}

async function loginWithCodex(): Promise<void> {
  const credentials = await loginCodex({
    onAuth(info) {
      consola.info("Open the following URL to authenticate with Codex:")
      consola.log(info.url)
      if (info.instructions) {
        consola.info(info.instructions)
      }
    },
    onPrompt(message) {
      return consola.prompt(message, {
        type: "text",
      })
    },
    onProgress(message) {
      consola.debug(message)
    },
  })

  await persistCodexCredentials(credentials, { enableProvider: true })
  consola.success(
    `Codex provider config written to ${PATHS.CONFIG_PATH} and credentials written to ${PATHS.CODEX_CREDENTIAL_PATH}`,
  )
}

async function loginWithProvider(provider: AuthProviderName): Promise<void> {
  if (provider === "copilot") {
    await setupGitHubToken({ force: true })
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    return
  }

  if (provider === "codex") {
    await loginWithCodex()
    return
  }

  await configureCustomProvider()
}

export async function runAuthLogin(options: RunAuthOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  const provider = await resolveProviderSelection(options.provider)

  consola.info(`Logging in with ${AUTH_PROVIDER_LABELS[provider]}`)
  await loginWithProvider(provider)
}

const authLogin = defineCommand({
  meta: {
    name: "login",
    description:
      "Authenticate or configure a provider without running the server",
  },
  args: authArgs,
  run({ args }) {
    return runAuthLogin({
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run authentication flows without running the server",
  },
  args: authArgs,
  subCommands: {
    login: authLogin,
  },
  run({ args }) {
    if ((args._[0] ?? "").trim()) {
      return
    }

    return runAuthLogin({
      provider: args.provider,
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
