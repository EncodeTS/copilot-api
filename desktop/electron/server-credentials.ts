import { createHash } from 'node:crypto'

import { readToken } from './auth'
import { getEnabledDesktopProviders } from './provider-auth'

export type ServerCredentialMode = 'copilot' | 'provider'

export interface ResolvedServerCredentials {
  generation: number
  mode: ServerCredentialMode
  token: string | null
}

export interface ServerCredentialResolverDependencies {
  listEnabledProviders: () => string[]
  readToken: () => Promise<string | null>
}

export interface ServerCredentialResolver {
  getGeneration: () => number
  markChanged: () => void
  resolve: (
    preferredMode?: ServerCredentialMode,
    allowFallback?: boolean,
  ) => Promise<ResolvedServerCredentials | null>
}

const credentialFingerprint = (
  token: string | null,
  providers: string[],
): string =>
  createHash('sha256')
    .update(token ?? '')
    .update('\0')
    .update([...providers].sort().join('\0'))
    .digest('hex')

export const createServerCredentialResolver = (
  dependencies: ServerCredentialResolverDependencies,
): ServerCredentialResolver => {
  let generation = 0
  let lastFingerprint: string | null = null

  const observe = (fingerprint: string): void => {
    if (lastFingerprint === null) {
      generation = Math.max(1, generation)
    } else if (lastFingerprint !== fingerprint) {
      generation += 1
    }
    lastFingerprint = fingerprint
  }

  return {
    getGeneration: () => generation,
    markChanged: () => {
      generation = Math.max(1, generation + 1)
      lastFingerprint = null
    },
    resolve: async (preferredMode, allowFallback = true) => {
      const [token, providers] = await Promise.all([
        dependencies.readToken(),
        Promise.resolve(dependencies.listEnabledProviders()),
      ])
      observe(credentialFingerprint(token, providers))

      const providerAvailable = providers.length > 0
      if (
        preferredMode === 'provider'
        && !providerAvailable
        && !allowFallback
      ) {
        return null
      }
      const mode =
        preferredMode === 'provider' && providerAvailable ? 'provider'
        : preferredMode === 'copilot' && token ? 'copilot'
        : token ? 'copilot'
        : providerAvailable ? 'provider'
        : null
      if (!mode) return null

      return {
        generation,
        mode,
        token: mode === 'copilot' ? token : null,
      }
    },
  }
}

const desktopServerCredentialResolver = createServerCredentialResolver({
  listEnabledProviders: getEnabledDesktopProviders,
  readToken,
})

export const getDesktopServerCredentialGeneration =
  desktopServerCredentialResolver.getGeneration
export const markDesktopServerCredentialsChanged =
  desktopServerCredentialResolver.markChanged
export const resolveDesktopServerCredentials =
  desktopServerCredentialResolver.resolve
