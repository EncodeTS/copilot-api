export type DesktopStartupAuthMode = "copilot" | "provider"

interface StartupAuthenticationInput {
  desktopAuthMode: DesktopStartupAuthMode | undefined
  enabledProviderCount: number
  environmentGitHubToken: string | undefined
  explicitGitHubToken: string | undefined
  storedGitHubToken: string | null
}

export type StartupAuthentication =
  | {
      githubToken: string
      kind: "copilot"
      source: "cli" | "environment" | "file"
    }
  | { allowInteractiveSetup: boolean; kind: "provider" }

export function readEnvironmentGitHubToken(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return (
    environment.COPILOT_API_GITHUB_TOKEN?.trim()
    || environment.GH_TOKEN?.trim()
    || undefined
  )
}

export function parseDesktopStartupAuthMode(
  value: unknown,
): DesktopStartupAuthMode | undefined {
  if (value === undefined) return undefined
  if (value === "copilot" || value === "provider") return value
  throw new Error("--desktop-auth-mode must be copilot or provider")
}

export function assertProviderSetupAllowed(
  allowInteractiveSetup: boolean,
  enabledProviderCount: number,
): void {
  if (!allowInteractiveSetup && enabledProviderCount === 0) {
    throw new Error(
      "No enabled provider is available for provider-only startup",
    )
  }
}

export function selectStartupAuthentication({
  desktopAuthMode,
  enabledProviderCount,
  environmentGitHubToken,
  explicitGitHubToken,
  storedGitHubToken,
}: StartupAuthenticationInput): StartupAuthentication {
  if (desktopAuthMode === "provider") {
    if (enabledProviderCount === 0) {
      throw new Error(
        "No enabled provider is available for provider-only startup",
      )
    }
    return { allowInteractiveSetup: false, kind: "provider" }
  }

  const explicit = explicitGitHubToken?.trim()
  if (explicit) {
    return { githubToken: explicit, kind: "copilot", source: "cli" }
  }
  const environment = environmentGitHubToken?.trim()
  if (environment) {
    return { githubToken: environment, kind: "copilot", source: "environment" }
  }
  const stored = storedGitHubToken?.trim()
  if (stored) return { githubToken: stored, kind: "copilot", source: "file" }

  if (desktopAuthMode === "copilot") {
    throw new Error("GitHub credential is unavailable for Copilot startup")
  }

  return { allowInteractiveSetup: true, kind: "provider" }
}

interface ResolveStartupAuthenticationInput {
  desktopAuthMode: DesktopStartupAuthMode | undefined
  enabledProviderCount: number
  environmentGitHubToken: string | undefined
  explicitGitHubToken: string | undefined
  readStoredGitHubToken: () => Promise<string | null>
}

export async function resolveStartupAuthentication({
  desktopAuthMode,
  enabledProviderCount,
  environmentGitHubToken,
  explicitGitHubToken,
  readStoredGitHubToken,
}: ResolveStartupAuthenticationInput): Promise<StartupAuthentication> {
  const storedGitHubToken =
    (
      desktopAuthMode === "provider"
      || explicitGitHubToken?.trim()
      || environmentGitHubToken?.trim()
    ) ?
      null
    : await readStoredGitHubToken()
  return selectStartupAuthentication({
    desktopAuthMode,
    enabledProviderCount,
    environmentGitHubToken,
    explicitGitHubToken,
    storedGitHubToken,
  })
}

interface StartupAuthenticationHandlers {
  startCopilot: (
    githubToken: string,
    source: Extract<StartupAuthentication, { kind: "copilot" }>["source"],
  ) => Promise<void>
  startProvider: (allowInteractiveSetup: boolean) => Promise<void>
}

export async function launchStartupAuthentication(
  authentication: StartupAuthentication,
  handlers: StartupAuthenticationHandlers,
): Promise<void> {
  if (authentication.kind === "copilot") {
    await handlers.startCopilot(
      authentication.githubToken,
      authentication.source,
    )
    return
  }
  await handlers.startProvider(authentication.allowInteractiveSetup)
}
