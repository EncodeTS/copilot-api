#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

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
    description: "Provider to log in with (copilot or codex)",
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

type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number]

const BUILTIN_PROVIDER_LABELS: Record<BuiltinProviderName, string> = {
  copilot: "GitHub Copilot",
  codex: "OpenAI Codex",
}

function isBuiltinProviderName(
  providerName: string,
): providerName is BuiltinProviderName {
  return BUILTIN_PROVIDER_NAMES.includes(providerName as BuiltinProviderName)
}

async function resolveProviderSelection(
  providerArg: string | undefined,
): Promise<BuiltinProviderName> {
  const availableProviders = [...BUILTIN_PROVIDER_NAMES]

  if (providerArg !== undefined) {
    const providerName = providerArg.trim()
    if (!isBuiltinProviderName(providerName)) {
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
      label: `${BUILTIN_PROVIDER_LABELS[providerName]} (${providerName})`,
      value: providerName,
    })),
  })

  if (!provider || !isBuiltinProviderName(provider)) {
    throw new Error("No provider selected")
  }

  return provider
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

async function loginWithProvider(provider: BuiltinProviderName): Promise<void> {
  if (provider === "copilot") {
    await setupGitHubToken({ force: true })
    consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
    return
  }

  await loginWithCodex()
}

export async function runAuthLogin(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await ensurePaths()
  const provider = await resolveProviderSelection(options.provider)

  consola.info(`Logging in with ${BUILTIN_PROVIDER_LABELS[provider]}`)
  await loginWithProvider(provider)
}

const authLogin = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate a builtin provider without running the server",
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
