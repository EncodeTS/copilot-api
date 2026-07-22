#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import {
  getModelMappings,
  listEnabledProviders,
  mergeConfigWithDefaults,
} from "~/lib/config"
import { resolveServerNetworkOptions } from "~/lib/network-security"
import { getConfiguredApiKeys } from "~/lib/request-auth"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import { responsesReasoningRecoveryRegistry } from "~/services/copilot/responses-reasoning-recovery-registry"
import type { ModelsResponse } from "~/services/copilot/get-models"
import { codexStartupCatalogManager } from "~/services/codex/startup-catalog"

import { runProviderSetup } from "./auth"
import { readGitHubToken } from "./lib/credential-store"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths, PATHS } from "./lib/paths"
import { initProxyFromEnv, isProxyRequired } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import {
  assertProviderSetupAllowed,
  launchStartupAuthentication,
  parseDesktopStartupAuthMode,
  resolveStartupAuthentication,
  type DesktopStartupAuthMode,
} from "./lib/start-auth-mode"
import { state } from "./lib/state"
import { logUser, setupCopilotToken } from "./lib/token"
import {
  cacheMacMachineId,
  cacheModels,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"

export interface RunServerOptions {
  port: number
  verbose: boolean
  githubToken?: string
  claudeCode: boolean
  lan?: boolean
  showToken: boolean
  proxyEnv: boolean
  proxyRequired?: boolean
  desktopAuthMode?: DesktopStartupAuthMode
}

export const startDependencies = {
  getModelMappings,
  refreshStartupCatalog: codexStartupCatalogManager.refresh,
}

export async function refreshCodexStartupCatalog(
  models: ModelsResponse,
): Promise<void> {
  const result = await startDependencies.refreshStartupCatalog({
    copilotModels: models.data,
    modelMappings: startDependencies.getModelMappings(),
  })
  if (result.status === "updated") {
    consola.info("Codex startup catalog updated", result)
  } else {
    consola.debug("Codex startup catalog refresh", result)
  }
}

async function setupCopilotMode(
  githubToken: string,
  fromCli: boolean,
  serverUrl: string,
  claudeCode: boolean,
): Promise<void> {
  state.githubToken = githubToken
  consola.info(
    fromCli ?
      "Using provided GitHub token"
    : "Using GitHub token from local file",
  )

  await logUser()

  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  await setupCopilotToken()
  await cacheModels(undefined, undefined, refreshCodexStartupCatalog)

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  if (claudeCode) {
    await runClaudeCode(serverUrl)
  }
}

async function runClaudeCode(serverUrl: string): Promise<void> {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )

  invariant(state.models, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    {
      type: "select",
      options: state.models.data.map((model) => model.id),
    },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: state.models.data.map((model) => model.id),
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

export async function setupProviderMode(
  serverUrl: string,
  claudeCode: boolean,
  allowInteractiveSetup: boolean,
  getEnabledProviders: () => string[] = listEnabledProviders,
): Promise<void> {
  const enabledProviders = getEnabledProviders()

  if (enabledProviders.length > 0) {
    consola.info(`Using enabled providers: ${enabledProviders.join(", ")}`)
    return
  }

  assertProviderSetupAllowed(allowInteractiveSetup, enabledProviders.length)

  consola.info("No enabled providers found. Setting one up...")
  await runProviderSetup()

  if (state.githubToken) {
    await setupCopilotMode(state.githubToken, false, serverUrl, claudeCode)
    return
  }

  const providersAfterSetup = listEnabledProviders()
  if (providersAfterSetup.length === 0) {
    throw new Error(
      "Failed to configure any provider. Run `copilot-api auth login` to set one up.",
    )
  }
  consola.info(`Configured providers: ${providersAfterSetup.join(", ")}`)
}

export interface StartupAuthenticationDependencies {
  readStoredGitHubToken: () => Promise<string | null>
  startCopilot: typeof setupCopilotMode
  startProvider: typeof setupProviderMode
}

const defaultStartupAuthenticationDependencies: StartupAuthenticationDependencies =
  {
    readStoredGitHubToken: readGitHubToken,
    startCopilot: setupCopilotMode,
    startProvider: setupProviderMode,
  }

export async function startSelectedAuthentication(
  options: Pick<
    RunServerOptions,
    "claudeCode" | "desktopAuthMode" | "githubToken"
  >,
  serverUrl: string,
  enabledProviderCount: number,
  dependencies: StartupAuthenticationDependencies = defaultStartupAuthenticationDependencies,
): Promise<void> {
  const authentication = await resolveStartupAuthentication({
    desktopAuthMode: options.desktopAuthMode,
    enabledProviderCount,
    explicitGitHubToken: options.githubToken,
    readStoredGitHubToken: dependencies.readStoredGitHubToken,
  })
  await launchStartupAuthentication(authentication, {
    startCopilot: (githubToken) =>
      dependencies.startCopilot(
        githubToken,
        Boolean(options.githubToken),
        serverUrl,
        options.claudeCode,
      ),
    startProvider: (allowInteractiveSetup) =>
      dependencies.startProvider(
        serverUrl,
        options.claudeCode,
        allowInteractiveSetup,
      ),
  })
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const tlsModule = await import("./lib/tls")
  tlsModule.enableSystemCACompat()

  consola.options.throttle = 0

  await ensurePaths()
  mergeConfigWithDefaults()

  const networkOptions = resolveServerNetworkOptions({
    apiKeys: getConfiguredApiKeys(),
    lan: options.lan === true,
  })

  await initOpencodeVersion()

  const proxyRequired = options.proxyRequired === true || isProxyRequired()
  if (options.proxyEnv || proxyRequired) {
    initProxyFromEnv({ required: proxyRequired })
  }

  state.verbose = options.verbose
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  await responsesReasoningRecoveryRegistry.initialize(
    PATHS.REASONING_RECOVERY_PATH,
  )
  registerProcessCleanup(() => responsesReasoningRecoveryRegistry.flush())

  const serverUrl = `http://${networkOptions.displayHost}:${options.port}`

  await startSelectedAuthentication(
    options,
    serverUrl,
    listEnabledProviders().length,
  )

  consola.box(`🌐 Usage Viewer: ${serverUrl}/usage-viewer`)

  const { server } = await import("./server")

  serve({
    fetch: server.fetch as ServerHandler,
    hostname: networkOptions.listenerHost,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    lan: {
      type: "boolean",
      default: false,
      description:
        "Listen on all network interfaces (requires auth.apiKeys in config.json)",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "proxy-required": {
      type: "boolean",
      default: false,
      description:
        "Require proxy routing except for explicit NO_PROXY destinations",
    },
    "desktop-auth-mode": {
      type: "string",
      description: "Require Copilot or provider-only Desktop startup",
    },
  },
  run({ args }) {
    return runServer(createRunServerOptions(args))
  },
})

interface StartCommandArgs {
  "claude-code": boolean
  "desktop-auth-mode"?: string
  "github-token"?: string
  "proxy-env": boolean
  "proxy-required"?: boolean
  "show-token": boolean
  lan?: boolean
  port: string
  verbose: boolean
}

export function createRunServerOptions(
  args: StartCommandArgs,
): RunServerOptions {
  return {
    port: Number.parseInt(args.port, 10),
    verbose: args.verbose,
    githubToken: args["github-token"],
    claudeCode: args["claude-code"],
    showToken: args["show-token"],
    proxyEnv: args["proxy-env"],
    desktopAuthMode: parseDesktopStartupAuthMode(args["desktop-auth-mode"]),
    ...(args.lan === undefined ? {} : { lan: args.lan }),
    ...(args["proxy-required"] === undefined ?
      {}
    : { proxyRequired: args["proxy-required"] }),
  }
}
