import {
  AuthProtocolError,
  AuthRequestError,
  AuthTransportError,
} from "~/lib/auth-request"
import {
  CredentialConflictError,
  type CodexCredentialSnapshot,
  type CredentialRevisionReservationOptions,
  type CredentialWriteOptions,
  type CredentialWriteResult,
} from "~/lib/credential-store"
import {
  isCodexCredentialsExpired,
  type CodexCredentials,
  type RefreshCodexCredentialsOptions,
} from "~/lib/oauth/codex"
import {
  RefreshLifecycle,
  type RefreshLifecycleLease,
} from "~/lib/refresh-lifecycle"
import type { State } from "~/lib/state"
import type {
  TokenLogger,
  TokenSetupOptions,
  TokenSleep,
} from "~/lib/token-manager-types"
import {
  defaultTokenSleep,
  EARLY_REFRESH_BUFFER_MS,
  getAuthRetryDelayMs,
  getPersistenceRetryDelayMs,
  getRefreshPollDelayMs,
  isAbortError,
  isPermanentAuthError,
  PERSIST_ATTEMPTS,
} from "~/lib/token-refresh-policy"

type CodexLifecycleLease = RefreshLifecycleLease<"codex">

export interface CodexTokenCredentialStore {
  readCodexCredentialSnapshot: () => Promise<CodexCredentialSnapshot>
  reserveCodexCredentialRevision: (
    options?: CredentialRevisionReservationOptions,
  ) => Promise<CredentialWriteResult>
  writeCodexCredentials: (
    credentials: CodexCredentials,
    options?: CredentialWriteOptions,
  ) => Promise<CredentialWriteResult>
}

export interface CodexLoginSession {
  readonly credentialRevision: string
  readonly lifecycleEpoch: number
  readonly signal: AbortSignal
}

export interface PersistCodexCredentialsOptions {
  enableProvider?: boolean
  expectedCredentialRevision?: string
  loginSession?: CodexLoginSession
  signal?: AbortSignal
}

export interface CodexTokenManagerDependencies {
  credentialStore: CodexTokenCredentialStore
  enableBackgroundLoops?: boolean
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

interface PendingCodexPersistence {
  credentialRevision: string
  credentials: CodexCredentials
}

interface PermanentCodexFailure {
  credentialRevision: string
  error: AuthProtocolError | AuthRequestError
}

export class CodexTokenManager {
  private credentialRevision: string | null = null
  private readonly credentialStore: CodexTokenCredentialStore
  private readonly enableBackgroundLoops: boolean
  private readonly lifecycle = new RefreshLifecycle<"codex", CodexCredentials>(
    "codex",
    "Codex token",
  )
  private readonly loginLeases = new WeakMap<
    CodexLoginSession,
    CodexLifecycleLease
  >()
  private readonly logger: TokenLogger
  private readonly now: () => number
  private pendingPersistence: PendingCodexPersistence | null = null
  private permanentFailure: PermanentCodexFailure | null = null
  private readonly random: () => number
  private readonly refreshCredentials: CodexTokenManagerDependencies["refreshCodexCredentials"]
  private readonly runtimeState: State
  private readonly sleep: TokenSleep
  private readonly syncProviderConfig: CodexTokenManagerDependencies["syncCodexProviderConfig"]

  constructor(dependencies: CodexTokenManagerDependencies) {
    this.credentialStore = dependencies.credentialStore
    this.enableBackgroundLoops = dependencies.enableBackgroundLoops ?? true
    this.logger = dependencies.logger
    this.now = dependencies.now ?? Date.now
    this.random = dependencies.random ?? Math.random
    this.refreshCredentials = dependencies.refreshCodexCredentials
    this.runtimeState = dependencies.state
    this.sleep = dependencies.sleep ?? defaultTokenSleep
    this.syncProviderConfig = dependencies.syncCodexProviderConfig
  }

  stop(): void {
    this.lifecycle.stop()
  }

  setup(options: TokenSetupOptions = {}): Promise<void> {
    const setupFlight = this.lifecycle.getSetupFlight()
    if (setupFlight) {
      return this.lifecycle.waitForSetup(options.signal)
    }
    const refreshFlight = this.lifecycle.getRefreshFlight()
    if (refreshFlight) {
      return this.lifecycle
        .waitFor(refreshFlight.promise, options.signal)
        .then((credentials) => {
          this.lifecycle.assertCurrent(refreshFlight.lease)
          this.applyCredentials(credentials)
        })
    }

    const loadedCredentials = this.getLoadedCredentials()
    if (
      this.lifecycle.getActiveLease()
      && loadedCredentials
      && !isCodexCredentialsExpired(loadedCredentials, this.now())
    ) {
      return this.lifecycle.waitFor(Promise.resolve(), options.signal)
    }

    return this.lifecycle.runSetup(options.signal, (lease) =>
      this.performSetup(lease),
    )
  }

  async beginLogin(
    options: TokenSetupOptions = {},
  ): Promise<CodexLoginSession> {
    const lease = this.lifecycle.beginExclusive({
      linkSignal: true,
      signal: options.signal,
    })
    try {
      const snapshot =
        await this.credentialStore.reserveCodexCredentialRevision({
          preCommit: () => this.lifecycle.assertCurrent(lease),
          signal: lease.signal,
        })
      this.lifecycle.assertCurrent(lease)
      const session: CodexLoginSession = Object.freeze({
        credentialRevision: snapshot.generation,
        lifecycleEpoch: lease.lifecycleEpoch,
        signal: lease.signal,
      })
      if (this.pendingPersistence) {
        this.pendingPersistence = {
          ...this.pendingPersistence,
          credentialRevision: snapshot.generation,
        }
      }
      this.loginLeases.set(session, lease)
      return session
    } catch (error) {
      this.lifecycle.cancel(lease)
      throw error
    }
  }

  cancelLogin(session: CodexLoginSession): void {
    const lease = this.loginLeases.get(session)
    if (!lease) return
    this.loginLeases.delete(session)
    this.lifecycle.cancel(lease)
  }

  async persistCredentials(
    credentials: CodexCredentials,
    options: PersistCodexCredentialsOptions = {},
  ): Promise<void> {
    let sessionLease: CodexLifecycleLease | undefined
    if (options.loginSession) {
      sessionLease = this.loginLeases.get(options.loginSession)
      if (!sessionLease) {
        throw new AuthTransportError(
          "Codex login session is no longer active",
          "aborted",
        )
      }
    }
    const lease =
      sessionLease
      ?? this.lifecycle.beginExclusive({
        linkSignal: true,
        signal: options.signal,
      })

    try {
      this.lifecycle.assertCurrent(lease)
      let credentialRevision = options.loginSession?.credentialRevision
      if (!credentialRevision) {
        const snapshot =
          await this.credentialStore.readCodexCredentialSnapshot()
        this.lifecycle.assertCurrent(lease)
        credentialRevision =
          options.expectedCredentialRevision ?? snapshot.generation
      }
      this.pendingPersistence = null
      this.permanentFailure = null
      const result = await this.credentialStore.writeCodexCredentials(
        credentials,
        {
          expectedGeneration: credentialRevision,
          preCommit: () => this.lifecycle.assertCurrent(lease),
          signal: lease.signal,
        },
      )
      this.lifecycle.assertCurrent(lease)
      this.credentialRevision = result.generation
      this.syncProviderConfig({
        enabled: options.enableProvider ? true : undefined,
      })
      this.applyCredentials(credentials)
    } finally {
      if (options.loginSession) this.loginLeases.delete(options.loginSession)
      this.lifecycle.release(lease)
    }
  }

  private applyCredentials(credentials: CodexCredentials): void {
    const credentialsChanged =
      this.runtimeState.codexAccessToken !== credentials.accessToken
      || this.runtimeState.codexRefreshToken !== credentials.refreshToken
      || this.runtimeState.codexExpiresAt !== credentials.expiresAt
      || this.runtimeState.codexAccountId !== credentials.accountId
    this.runtimeState.codexAccessToken = credentials.accessToken
    this.runtimeState.codexRefreshToken = credentials.refreshToken
    this.runtimeState.codexExpiresAt = credentials.expiresAt
    this.runtimeState.codexAccountId = credentials.accountId
    if (credentialsChanged) {
      this.runtimeState.codexCredentialRevision =
        (this.runtimeState.codexCredentialRevision ?? 0) + 1
    }

    this.logger.debug("Codex credentials loaded successfully")
    if (this.runtimeState.showToken) {
      this.logger.info("Codex access token:", credentials.accessToken)
    }
  }

  private getLoadedCredentials(): CodexCredentials | null {
    if (
      !this.runtimeState.codexAccessToken
      || !this.runtimeState.codexRefreshToken
      || !this.runtimeState.codexExpiresAt
      || !this.runtimeState.codexAccountId
    ) {
      return null
    }
    return {
      accessToken: this.runtimeState.codexAccessToken,
      refreshToken: this.runtimeState.codexRefreshToken,
      expiresAt: this.runtimeState.codexExpiresAt,
      accountId: this.runtimeState.codexAccountId,
    }
  }

  private async performSetup(lease: CodexLifecycleLease): Promise<void> {
    let credentials: CodexCredentials
    let credentialRevision: string

    if (this.pendingPersistence) {
      credentials = await this.persistPendingCredentials(lease)
      credentialRevision = this.credentialRevision ?? "missing"
    } else {
      const snapshot = await this.credentialStore.readCodexCredentialSnapshot()
      this.lifecycle.assertCurrent(lease)
      if (!snapshot.credentials) {
        throw new Error(
          "Codex credentials not found. Run `copilot-api auth login --provider codex` first.",
        )
      }
      credentials = snapshot.credentials
      credentialRevision = snapshot.generation
      this.credentialRevision = credentialRevision
      if (this.permanentFailure) {
        if (this.permanentFailure.credentialRevision === snapshot.generation) {
          throw this.permanentFailure.error
        }
        this.permanentFailure = null
      }
    }

    this.syncProviderConfig()
    if (isCodexCredentialsExpired(credentials, this.now())) {
      credentials = await this.refreshOnce(
        credentials,
        credentialRevision,
        lease,
      )
    }
    this.lifecycle.assertCurrent(lease)
    this.applyCredentials(credentials)
    if (this.enableBackgroundLoops) this.startRefreshLoop(lease)
  }

  private refreshOnce(
    credentials: CodexCredentials,
    credentialRevision: string,
    lease: CodexLifecycleLease,
  ): Promise<CodexCredentials> {
    return this.lifecycle.runRefresh(lease, async () => {
      if (this.pendingPersistence) {
        return await this.persistPendingCredentials(lease)
      }

      this.logger.debug("Refreshing Codex credentials")
      let refreshed: CodexCredentials
      let rotationCaptured = false
      try {
        refreshed = await this.refreshCredentials(credentials, {
          onRotatedCredentials: async (rotatedCredentials) => {
            rotationCaptured = true
            await this.captureRotatedCredentials(
              rotatedCredentials,
              credentialRevision,
            )
          },
          signal: lease.signal,
        })
        if (!rotationCaptured) {
          await this.captureRotatedCredentials(refreshed, credentialRevision)
        }
      } catch (error) {
        if (error instanceof CredentialConflictError) {
          const external =
            await this.credentialStore.readCodexCredentialSnapshot()
          this.lifecycle.assertCurrent(lease)
          this.pendingPersistence = null
          this.credentialRevision = external.generation
          this.permanentFailure = null
          if (!external.credentials) throw error
          this.logger.warn(
            "Codex credentials changed externally; using the newer login",
          )
          return external.credentials
        }
        if (isPermanentAuthError(error) && this.lifecycle.isCurrent(lease)) {
          const safeError =
            (
              error instanceof AuthRequestError
              || error instanceof AuthProtocolError
            ) ?
              error
            : new AuthProtocolError(
                "Codex credentials were rejected permanently",
              )
          this.permanentFailure = {
            credentialRevision,
            error: safeError,
          }
        }
        throw error
      }
      this.lifecycle.assertCurrent(lease)
      this.permanentFailure = null
      return refreshed
    })
  }

  private async captureRotatedCredentials(
    credentials: CodexCredentials,
    credentialRevision: string,
  ): Promise<void> {
    const pending: PendingCodexPersistence = {
      credentialRevision,
      credentials,
    }
    this.pendingPersistence = pending
    const durabilitySignal = new AbortController().signal

    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.credentialStore.writeCodexCredentials(
          credentials,
          { expectedGeneration: pending.credentialRevision },
        )
        if (this.pendingPersistence === pending) this.pendingPersistence = null
        this.credentialRevision = result.generation
        return
      } catch (error) {
        if (error instanceof CredentialConflictError) {
          throw error
        }
        if (attempt + 1 >= PERSIST_ATTEMPTS) throw error
        const retryDelayMs = getPersistenceRetryDelayMs(attempt, this.random)
        await this.sleep(retryDelayMs, durabilitySignal)
      }
    }
  }

  private async persistPendingCredentials(
    lease: CodexLifecycleLease,
  ): Promise<CodexCredentials> {
    const pending = this.pendingPersistence
    if (!pending) throw new Error("No pending Codex credentials to persist")

    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      this.lifecycle.assertCurrent(lease)
      try {
        const result = await this.credentialStore.writeCodexCredentials(
          pending.credentials,
          {
            expectedGeneration: pending.credentialRevision,
            preCommit: () => this.lifecycle.assertCurrent(lease),
            signal: lease.signal,
          },
        )
        this.lifecycle.assertCurrent(lease)
        if (this.pendingPersistence === pending) this.pendingPersistence = null
        this.credentialRevision = result.generation
        this.logger.debug("Codex credentials persisted successfully")
        return pending.credentials
      } catch (error) {
        if (error instanceof CredentialConflictError) {
          const external =
            await this.credentialStore.readCodexCredentialSnapshot()
          this.lifecycle.assertCurrent(lease)
          if (this.pendingPersistence === pending)
            this.pendingPersistence = null
          this.credentialRevision = external.generation
          this.permanentFailure = null
          if (!external.credentials) throw error
          this.logger.warn(
            "Codex credentials changed externally; using the newer login",
          )
          return external.credentials
        }

        if (attempt + 1 >= PERSIST_ATTEMPTS) throw error
        const retryDelayMs = getPersistenceRetryDelayMs(attempt, this.random)
        this.logger.warn(
          `Retrying Codex credential persistence in ${retryDelayMs}ms`,
        )
        await this.sleep(retryDelayMs, lease.signal)
      }
    }
    throw new Error("Codex credential persistence retry limit reached")
  }

  private startRefreshLoop(lease: CodexLifecycleLease): void {
    this.runRefreshLoop(lease)
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.logger.warn("Codex token refresh loop stopped after an error")
        }
      })
      .finally(() => this.lifecycle.release(lease))
  }

  private async runRefreshLoop(lease: CodexLifecycleLease): Promise<void> {
    let retryAttempt = 0

    while (this.lifecycle.isCurrent(lease)) {
      const credentials = this.getLoadedCredentials()
      if (!credentials) return
      const refreshAtMs = Math.max(
        credentials.expiresAt - EARLY_REFRESH_BUFFER_MS,
        this.now(),
      )
      const nextDelayMs = getRefreshPollDelayMs(refreshAtMs, this.now())
      if (nextDelayMs > 0) {
        await this.sleep(nextDelayMs, lease.signal)
        continue
      }

      try {
        const snapshot =
          await this.credentialStore.readCodexCredentialSnapshot()
        this.lifecycle.assertCurrent(lease)
        if (snapshot.generation !== this.credentialRevision) {
          if (!snapshot.credentials) return
          this.credentialRevision = snapshot.generation
          this.permanentFailure = null
          this.applyCredentials(snapshot.credentials)
          retryAttempt = 0
          continue
        }

        const refreshed = await this.refreshOnce(
          credentials,
          snapshot.generation,
          lease,
        )
        this.lifecycle.assertCurrent(lease)
        this.applyCredentials(refreshed)
        retryAttempt = 0
        this.logger.debug("Codex credentials refreshed")
      } catch (error) {
        if (!this.lifecycle.isCurrent(lease)) return
        if (isPermanentAuthError(error)) {
          this.logger.error(
            "Codex credential refresh stopped after a permanent auth error",
          )
          return
        }
        const retryDelayMs = getAuthRetryDelayMs(retryAttempt, this.random)
        retryAttempt += 1
        this.logger.warn(
          `Retrying Codex credential refresh in ${Math.round(retryDelayMs / 1000)}s`,
        )
        await this.sleep(retryDelayMs, lease.signal)
      }
    }
  }
}
