import type { DesktopAuthMode } from '../../shared-types'

export type DesktopServerLaunchMode = 'copilot' | 'provider'

interface DesktopServerStartPolicyInput {
  authMode: DesktopAuthMode | undefined
  enabledProviderCount: number
  hasGitHubCredential: boolean
}

export type DesktopServerStartDecision =
  | { launchMode: DesktopServerLaunchMode; ok: true }
  | { ok: false; reason: 'auth_required' }

const GITHUB_CREDENTIAL_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_COPILOT_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_TOKEN',
] as const

export function buildServerStartArgs(
  port: number,
  launchMode: DesktopServerLaunchMode,
): string[] {
  return ['start', '--port', String(port), '--desktop-auth-mode', launchMode]
}

export function buildServerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' }
  for (const [key, value] of Object.entries(source)) {
    if (
      GITHUB_CREDENTIAL_ENV_KEYS.includes(
        key.toUpperCase() as (typeof GITHUB_CREDENTIAL_ENV_KEYS)[number],
      )
    ) {
      continue
    }
    env[key] = value
  }
  env.NODE_ENV = 'production'
  return env
}

export function resolveDesktopServerStart({
  authMode,
  enabledProviderCount,
  hasGitHubCredential,
}: DesktopServerStartPolicyInput): DesktopServerStartDecision {
  if (authMode === 'copilot') {
    return hasGitHubCredential ?
        { launchMode: 'copilot', ok: true }
      : { ok: false, reason: 'auth_required' }
  }

  if (authMode === 'provider') {
    return enabledProviderCount > 0 ?
        { launchMode: 'provider', ok: true }
      : { ok: false, reason: 'auth_required' }
  }

  if (hasGitHubCredential) return { launchMode: 'copilot', ok: true }
  if (enabledProviderCount > 0) return { launchMode: 'provider', ok: true }
  return { ok: false, reason: 'auth_required' }
}
