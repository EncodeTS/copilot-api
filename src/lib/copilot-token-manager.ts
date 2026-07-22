import type { AuthRequestOptions } from "~/lib/auth-request"
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
  getAuthRetryDelayMs,
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
  isAbortError,
  isPermanentAuthError,
} from "~/lib/token-refresh-policy"
import type { GetCopilotTokenResponse } from "~/services/github/get-copilot-token"

type CopilotLifecycleLease = RefreshLifecycleLease<"copilot">

export interface CopilotTokenManagerDependencies {
  enableBackgroundLoops?: boolean
  getCopilotToken: (
    options?: AuthRequestOptions,
  ) => Promise<GetCopilotTokenResponse>
  isOpencodeOauthApp: () => boolean
  logger: TokenLogger
  now?: () => number
  random?: () => number
  sleep?: TokenSleep
  state: State
}

export class CopilotTokenManager {
  private readonly enableBackgroundLoops: boolean
  private readonly getCopilotTokenRequest: CopilotTokenManagerDependencies["getCopilotToken"]
  private readonly isOpencodeOauthApp: () => boolean
  private readonly lifecycle = new RefreshLifecycle<
    "copilot",
    GetCopilotTokenResponse
  >("copilot", "Copilot token")
  private readonly logger: TokenLogger
  private readonly now: () => number
  private readonly random: () => number
  private readonly runtimeState: State
  private readonly sleep: TokenSleep

  constructor(dependencies: CopilotTokenManagerDependencies) {
    this.enableBackgroundLoops = dependencies.enableBackgroundLoops ?? true
    this.getCopilotTokenRequest = dependencies.getCopilotToken
    this.isOpencodeOauthApp = dependencies.isOpencodeOauthApp
    this.logger = dependencies.logger
    this.now = dependencies.now ?? Date.now
    this.random = dependencies.random ?? Math.random
    this.runtimeState = dependencies.state
    this.sleep = dependencies.sleep ?? defaultTokenSleep
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
        .then((result) => {
          this.lifecycle.assertCurrent(refreshFlight.lease)
          this.runtimeState.copilotToken = result.token
        })
    }
    if (this.lifecycle.getActiveLease() && this.runtimeState.copilotToken) {
      return this.lifecycle.waitFor(Promise.resolve(), options.signal)
    }

    return this.lifecycle.runSetup(options.signal, (lease) =>
      this.performSetup(lease),
    )
  }

  private async performSetup(lease: CopilotLifecycleLease): Promise<void> {
    if (this.isOpencodeOauthApp()) {
      if (!this.runtimeState.githubToken) {
        throw new Error("opencode token not found")
      }
      this.lifecycle.assertCurrent(lease)
      this.runtimeState.copilotToken = this.runtimeState.githubToken
      this.logger.debug("GitHub Copilot token set from opencode auth token")
      if (this.runtimeState.showToken) {
        this.logger.info("Copilot token:", this.runtimeState.copilotToken)
      }
      return
    }

    const result = await this.fetchOnce(lease)
    this.lifecycle.assertCurrent(lease)
    this.runtimeState.copilotToken = result.token
    this.logger.debug("GitHub Copilot token fetched successfully")
    if (this.runtimeState.showToken) {
      this.logger.info("Copilot token:", result.token)
    }

    if (this.enableBackgroundLoops) {
      this.startRefreshLoop(result.refresh_in, lease)
    }
  }

  private fetchOnce(
    lease: CopilotLifecycleLease,
  ): Promise<GetCopilotTokenResponse> {
    return this.lifecycle.runRefresh(lease, () =>
      this.getCopilotTokenRequest({ signal: lease.signal }),
    )
  }

  private startRefreshLoop(
    refreshIn: number,
    lease: CopilotLifecycleLease,
  ): void {
    this.runRefreshLoop(refreshIn, lease)
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.logger.warn("Copilot token refresh loop stopped after an error")
        }
      })
      .finally(() => this.lifecycle.release(lease))
  }

  private async runRefreshLoop(
    refreshIn: number,
    lease: CopilotLifecycleLease,
  ): Promise<void> {
    let refreshAtMs = getRefreshDeadlineMs(refreshIn, this.now())
    let retryAttempt = 0

    while (this.lifecycle.isCurrent(lease)) {
      const nextDelayMs = getRefreshPollDelayMs(refreshAtMs, this.now())
      if (nextDelayMs > 0) {
        await this.sleep(nextDelayMs, lease.signal)
        continue
      }

      try {
        const result = await this.fetchOnce(lease)
        this.lifecycle.assertCurrent(lease)
        this.runtimeState.copilotToken = result.token
        refreshAtMs = getRefreshDeadlineMs(result.refresh_in, this.now())
        retryAttempt = 0
        this.logger.debug("Copilot token refreshed")
        if (this.runtimeState.showToken) {
          this.logger.info("Refreshed Copilot token:", result.token)
        }
      } catch (error) {
        if (!this.lifecycle.isCurrent(lease)) return
        if (isPermanentAuthError(error)) {
          this.logger.error(
            "Copilot token refresh stopped after a permanent auth error",
          )
          return
        }
        const retryDelayMs = getAuthRetryDelayMs(retryAttempt, this.random)
        retryAttempt += 1
        refreshAtMs = this.now() + retryDelayMs
        this.logger.warn(
          `Retrying Copilot token refresh in ${Math.round(retryDelayMs / 1000)}s`,
        )
      }
    }
  }
}
