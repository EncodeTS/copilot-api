export type DesktopStartupAuthMode = "copilot" | "provider"

interface StartupAuthenticationInput {
  desktopAuthMode: DesktopStartupAuthMode | undefined
  enabledProviderCount: number
  explicitGitHubToken: string | undefined
  storedGitHubToken: string | null
}

export type StartupAuthentication =
  | { githubToken: string; kind: "copilot" }
  | { allowInteractiveSetup: boolean; kind: "provider" }

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

  const githubToken = explicitGitHubToken?.trim() || storedGitHubToken?.trim()
  if (githubToken) return { githubToken, kind: "copilot" }

  if (desktopAuthMode === "copilot") {
    throw new Error("GitHub credential is unavailable for Copilot startup")
  }

  return { allowInteractiveSetup: true, kind: "provider" }
}

interface ResolveStartupAuthenticationInput {
  desktopAuthMode: DesktopStartupAuthMode | undefined
  enabledProviderCount: number
  explicitGitHubToken: string | undefined
  readStoredGitHubToken: () => Promise<string | null>
}

export async function resolveStartupAuthentication({
  desktopAuthMode,
  enabledProviderCount,
  explicitGitHubToken,
  readStoredGitHubToken,
}: ResolveStartupAuthenticationInput): Promise<StartupAuthentication> {
  const storedGitHubToken =
    desktopAuthMode === "provider" || explicitGitHubToken?.trim() ?
      null
    : await readStoredGitHubToken()
  return selectStartupAuthentication({
    desktopAuthMode,
    enabledProviderCount,
    explicitGitHubToken,
    storedGitHubToken,
  })
}

interface StartupAuthenticationHandlers {
  startCopilot: (githubToken: string) => Promise<void>
  startProvider: (allowInteractiveSetup: boolean) => Promise<void>
}

export async function launchStartupAuthentication(
  authentication: StartupAuthentication,
  handlers: StartupAuthenticationHandlers,
): Promise<void> {
  if (authentication.kind === "copilot") {
    await handlers.startCopilot(authentication.githubToken)
    return
  }
  await handlers.startProvider(authentication.allowInteractiveSetup)
}
