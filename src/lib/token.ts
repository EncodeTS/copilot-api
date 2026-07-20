import consola from "consola"

import { isOpencodeOauthApp } from "~/lib/api-config"
import {
  AuthProtocolError,
  AuthRequestError,
  AuthTransportError,
  type AuthRequestOptions,
} from "~/lib/auth-request"
import {
  CodexTokenManager,
  type CodexLoginSession,
  type CodexTokenCredentialStore,
  type PersistCodexCredentialsOptions,
} from "~/lib/codex-token-manager"
import { getRawProviderConfig, setProviderConfig } from "~/lib/config"
import {
  readCodexCredentialSnapshot,
  readGitHubTokenSnapshot,
  reserveCodexCredentialRevision,
  writeCodexCredentials,
} from "~/lib/credential-store"
import { CopilotTokenManager } from "~/lib/copilot-token-manager"
import { startGitHubDeviceLogin } from "~/lib/github-login"
import {
  refreshCodexCredentials,
  type CodexCredentials,
  type RefreshCodexCredentialsOptions,
} from "~/lib/oauth/codex"
import type { State } from "~/lib/state"
import type {
  TokenLogger,
  TokenSetupOptions,
  TokenSleep,
} from "~/lib/token-manager-types"
import { CODEX_API_BASE_URL } from "~/services/codex/create-responses"
import {
  getCopilotToken,
  type GetCopilotTokenResponse,
} from "~/services/github/get-copilot-token"
import {
  CopilotUsageFetchError,
  getCopilotUsage,
  getCopilotUsageScopeId,
  invalidateCopilotUsageScope,
  resolveCopilotAccountType,
} from "~/services/github/get-copilot-usage"
import { getGitHubUser } from "~/services/github/get-user"

import { state } from "./state"

export type {
  CodexLoginSession,
  PersistCodexCredentialsOptions,
  TokenLogger,
  TokenSetupOptions,
}
export {
  getAuthRetryDelayMs,
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
} from "./token-refresh-policy"

export const tokenUserDependencies = {
  criticalUsageTimeoutMs: 750,
  getGitHubUser,
}

export interface TokenManagerDependencies {
  credentialStore: CodexTokenCredentialStore
  enableBackgroundLoops?: boolean
  getCopilotToken: (
    options?: AuthRequestOptions,
  ) => Promise<GetCopilotTokenResponse>
  isOpencodeOauthApp: () => boolean
  logger: TokenLogger
  now?: () => number
  random?: () => number
  refreshCodexCredentials: (
    credentials: CodexCredentials,
    options?: RefreshCodexCredentialsOptions,
  ) => Promise<CodexCredentials>
  sleep?: TokenSleep
  state: State
  syncCodexProviderConfig: (options?: { enabled?: boolean }) => void
}

export class TokenManager {
  private readonly codex: CodexTokenManager
  private readonly copilot: CopilotTokenManager

  constructor(dependencies: TokenManagerDependencies) {
    this.codex = new CodexTokenManager({
      credentialStore: dependencies.credentialStore,
      enableBackgroundLoops: dependencies.enableBackgroundLoops,
      logger: dependencies.logger,
      now: dependencies.now,
      random: dependencies.random,
      refreshCodexCredentials: dependencies.refreshCodexCredentials,
      sleep: dependencies.sleep,
      state: dependencies.state,
      syncCodexProviderConfig: dependencies.syncCodexProviderConfig,
    })
    this.copilot = new CopilotTokenManager({
      enableBackgroundLoops: dependencies.enableBackgroundLoops,
      getCopilotToken: dependencies.getCopilotToken,
      isOpencodeOauthApp: dependencies.isOpencodeOauthApp,
      logger: dependencies.logger,
      now: dependencies.now,
      random: dependencies.random,
      sleep: dependencies.sleep,
      state: dependencies.state,
    })
  }

  stopCopilotRefreshLoop(): void {
    this.copilot.stop()
  }

  stopCodexRefreshLoop(): void {
    this.codex.stop()
  }

  setupCopilotToken(options?: TokenSetupOptions): Promise<void> {
    return this.copilot.setup(options)
  }

  setupCodexToken(options?: TokenSetupOptions): Promise<void> {
    return this.codex.setup(options)
  }

  beginCodexLogin(options?: TokenSetupOptions): Promise<CodexLoginSession> {
    return this.codex.beginLogin(options)
  }

  cancelCodexLogin(session: CodexLoginSession): void {
    this.codex.cancelLogin(session)
  }

  persistCodexCredentials(
    credentials: CodexCredentials,
    options?: PersistCodexCredentialsOptions,
  ): Promise<void> {
    return this.codex.persistCredentials(credentials, options)
  }
}

function syncDefaultCodexProviderConfig(options?: { enabled?: boolean }): void {
  const existingProviderConfig = getRawProviderConfig("codex") ?? {}
  setProviderConfig("codex", {
    ...existingProviderConfig,
    type: "openai-responses",
    enabled: options?.enabled ?? existingProviderConfig.enabled,
    baseUrl: CODEX_API_BASE_URL,
    authType: "oauth2",
    pricingCurrency: "USD",
  })
}

const defaultTokenManager = new TokenManager({
  credentialStore: {
    readCodexCredentialSnapshot,
    reserveCodexCredentialRevision,
    writeCodexCredentials,
  },
  getCopilotToken,
  isOpencodeOauthApp,
  logger: consola,
  refreshCodexCredentials,
  state,
  syncCodexProviderConfig: syncDefaultCodexProviderConfig,
})

export const stopCopilotRefreshLoop = () =>
  defaultTokenManager.stopCopilotRefreshLoop()
export const stopCodexRefreshLoop = () =>
  defaultTokenManager.stopCodexRefreshLoop()
export const setupCopilotToken = (options?: TokenSetupOptions) =>
  defaultTokenManager.setupCopilotToken(options)
export const setupCodexToken = (options?: TokenSetupOptions) =>
  defaultTokenManager.setupCodexToken(options)
export const beginCodexLogin = (options?: TokenSetupOptions) =>
  defaultTokenManager.beginCodexLogin(options)
export const cancelCodexLogin = (session: CodexLoginSession) =>
  defaultTokenManager.cancelCodexLogin(session)
export const persistCodexCredentials = (
  credentials: CodexCredentials,
  options?: PersistCodexCredentialsOptions,
) => defaultTokenManager.persistCodexCredentials(credentials, options)

interface SetupGitHubTokenOptions extends AuthRequestOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options: SetupGitHubTokenOptions = {},
): Promise<void> {
  try {
    const snapshot = await readGitHubTokenSnapshot()
    const githubToken = snapshot.value

    if (githubToken && !options.force) {
      state.githubToken = githubToken
      if (state.showToken) consola.info("GitHub token:", githubToken)
      await logUser(options)
      return
    }

    consola.info("Not logged in, getting new access token")
    const loginSession = await startGitHubDeviceLogin(options)
    consola.info(
      `Please enter the code "${loginSession.deviceCode.user_code}" in ${loginSession.deviceCode.verification_uri}`,
    )

    const token = await loginSession.completion
    state.githubToken = token
    if (state.showToken) consola.info("GitHub token:", token)
    await logUser(options)
  } catch (error) {
    const failureKind =
      error instanceof AuthRequestError || error instanceof AuthTransportError ?
        error.kind
      : error instanceof AuthProtocolError ? error.retryDisposition
      : "unknown"
    consola.error(`Failed to get GitHub token (${failureKind})`)
    throw error
  }
}

export async function logUser(options: AuthRequestOptions = {}): Promise<void> {
  const previousUserName = state.userName
  const user = await tokenUserDependencies.getGitHubUser(undefined, options)
  const githubToken = state.githubToken
  const currentUsageScope =
    githubToken ? getCopilotUsageScopeId(githubToken) : null
  const accountChanged =
    previousUserName !== undefined && previousUserName !== user.login
  if (accountChanged && githubToken) {
    invalidateCopilotUsageScope(githubToken)
  }
  if (
    !currentUsageScope
    || state.copilotUsageScope !== currentUsageScope
    || accountChanged
  ) {
    state.copilotApiUrl = undefined
    state.copilotUsageScope = currentUsageScope ?? undefined
    state.tokenBasedBilling = undefined
    // Without a validated current-account endpoint, use the public individual
    // endpoint as a safe availability fallback and never reuse the prior account.
    state.accountType = "individual"
  }
  state.userName = user.login
  consola.info(`Logged in as ${user.login}`)

  try {
    // Endpoint selection remains synchronous when GitHub responds. The usage
    // fetch owns a strict timeout, so quota/display enrichment cannot hang
    // startup; a changed credential falls back to the safe public endpoint.
    const copilotUser = await getCopilotUsage(undefined, {
      signal: options.signal,
      expectedLogin: user.login,
      maxAttempts: 1,
      requestTimeoutMs: tokenUserDependencies.criticalUsageTimeoutMs,
    })
    if (!copilotUser) {
      consola.warn("Copilot usage enrichment skipped: token unavailable")
      return
    }

    state.copilotApiUrl = copilotUser.endpoints.api
    state.accountType = resolveCopilotAccountType(copilotUser)
    state.tokenBasedBilling = copilotUser.token_based_billing
  } catch (error) {
    if (
      error instanceof CopilotUsageFetchError
      && (error.code === "unauthorized" || error.code === "forbidden")
    ) {
      state.accountType = "individual"
      state.copilotApiUrl = undefined
      state.tokenBasedBilling = undefined
    }
    consola.warn(
      "Copilot usage enrichment unavailable; using safe public account endpoint",
    )
  }
}
