import { AuthTransportError, type AuthRequestOptions } from "~/lib/auth-request"
import {
  reserveGitHubTokenRevision,
  writeGitHubToken,
  type CredentialRevisionReservationOptions,
  type CredentialSnapshot,
  type CredentialWriteOptions,
  type CredentialWriteResult,
} from "~/lib/credential-store"
import {
  RefreshLifecycle,
  type RefreshLifecycleLease,
} from "~/lib/refresh-lifecycle"
import {
  getDeviceCode,
  type DeviceCodeResponse,
} from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"

type GitHubLoginLease = RefreshLifecycleLease<"github-login">

export interface GitHubLoginDependencies {
  getDeviceCode: (options?: AuthRequestOptions) => Promise<DeviceCodeResponse>
  pollAccessToken: (
    deviceCode: DeviceCodeResponse,
    options?: AuthRequestOptions,
  ) => Promise<string>
  reserveGitHubTokenRevision: (
    options?: CredentialRevisionReservationOptions,
  ) => Promise<CredentialSnapshot<string>>
  writeGitHubToken: (
    token: string,
    options?: CredentialWriteOptions,
  ) => Promise<CredentialWriteResult>
}

export interface GitHubDeviceLoginSession {
  readonly completion: Promise<string>
  readonly credentialRevision: string
  readonly deviceCode: DeviceCodeResponse
  readonly lifecycleEpoch: number
  readonly signal: AbortSignal
}

export interface GitHubManualLoginSession {
  readonly credentialRevision: string
  readonly lifecycleEpoch: number
  readonly signal: AbortSignal
}

export class GitHubLoginManager {
  private readonly dependencies: GitHubLoginDependencies
  private readonly lifecycle = new RefreshLifecycle<"github-login", string>(
    "github-login",
    "GitHub login",
  )
  private readonly manualLeases = new WeakMap<
    GitHubManualLoginSession,
    GitHubLoginLease
  >()

  constructor(dependencies: GitHubLoginDependencies) {
    this.dependencies = dependencies
  }

  async start(
    options: AuthRequestOptions = {},
  ): Promise<GitHubDeviceLoginSession> {
    const { credentialRevision, lease } = await this.reserveLoginLease(options)
    try {
      this.lifecycle.assertCurrent(lease)
      const deviceCode = await this.dependencies.getDeviceCode({
        ...options,
        signal: lease.signal,
      })
      this.lifecycle.assertCurrent(lease)
      const completion = this.complete(
        lease,
        credentialRevision,
        deviceCode,
        options,
      )
      return Object.freeze({
        completion,
        credentialRevision,
        deviceCode,
        lifecycleEpoch: lease.lifecycleEpoch,
        signal: lease.signal,
      })
    } catch (error) {
      this.lifecycle.cancel(lease)
      throw error
    }
  }

  cancel(session: GitHubDeviceLoginSession): void {
    const active = this.lifecycle.getActiveLease()
    if (
      active
      && active.lifecycleEpoch === session.lifecycleEpoch
      && active.scope === "github-login"
    ) {
      this.lifecycle.cancel(active)
    }
  }

  async beginManualLogin(
    options: AuthRequestOptions = {},
  ): Promise<GitHubManualLoginSession> {
    const { credentialRevision, lease } = await this.reserveLoginLease(options)
    try {
      this.lifecycle.assertCurrent(lease)
      const session: GitHubManualLoginSession = Object.freeze({
        credentialRevision,
        lifecycleEpoch: lease.lifecycleEpoch,
        signal: lease.signal,
      })
      this.manualLeases.set(session, lease)
      return session
    } catch (error) {
      this.lifecycle.cancel(lease)
      throw error
    }
  }

  private async reserveLoginLease(options: AuthRequestOptions): Promise<{
    credentialRevision: string
    lease: GitHubLoginLease
  }> {
    const lease = this.lifecycle.beginExclusive({
      linkSignal: true,
      signal: options.signal,
    })
    try {
      const snapshot = await this.dependencies.reserveGitHubTokenRevision({
        preCommit: () => this.lifecycle.assertCurrent(lease),
        signal: lease.signal,
      })
      this.lifecycle.assertCurrent(lease)
      return { credentialRevision: snapshot.generation, lease }
    } catch (error) {
      this.lifecycle.cancel(lease)
      throw error
    }
  }

  cancelManualLogin(session: GitHubManualLoginSession): void {
    const lease = this.manualLeases.get(session)
    if (!lease) return
    this.manualLeases.delete(session)
    this.lifecycle.cancel(lease)
  }

  async persistManualToken(
    session: GitHubManualLoginSession,
    token: string,
  ): Promise<void> {
    const lease = this.manualLeases.get(session)
    if (!lease) {
      throw new AuthTransportError(
        "GitHub manual login session is no longer active",
        "aborted",
      )
    }
    try {
      this.lifecycle.assertCurrent(lease)
      await this.dependencies.writeGitHubToken(token, {
        expectedGeneration: session.credentialRevision,
        preCommit: () => this.lifecycle.assertCurrent(lease),
        signal: lease.signal,
      })
      this.lifecycle.assertCurrent(lease)
    } finally {
      this.manualLeases.delete(session)
      this.lifecycle.release(lease)
    }
  }

  private complete(
    lease: GitHubLoginLease,
    credentialRevision: string,
    deviceCode: DeviceCodeResponse,
    options: AuthRequestOptions,
  ): Promise<string> {
    const completion = this.lifecycle.runRefresh(lease, async () => {
      const token = await this.dependencies.pollAccessToken(deviceCode, {
        ...options,
        signal: lease.signal,
      })
      this.lifecycle.assertCurrent(lease)
      await this.dependencies.writeGitHubToken(token, {
        expectedGeneration: credentialRevision,
        preCommit: () => this.lifecycle.assertCurrent(lease),
        signal: lease.signal,
      })
      this.lifecycle.assertCurrent(lease)
      return token
    })
    completion.then(
      () => this.lifecycle.release(lease),
      () => this.lifecycle.release(lease),
    )
    return completion
  }
}

const defaultGitHubLoginManager = new GitHubLoginManager({
  getDeviceCode,
  pollAccessToken,
  reserveGitHubTokenRevision,
  writeGitHubToken,
})

export const startGitHubDeviceLogin = (options?: AuthRequestOptions) =>
  defaultGitHubLoginManager.start(options)
export const cancelGitHubDeviceLogin = (session: GitHubDeviceLoginSession) =>
  defaultGitHubLoginManager.cancel(session)
export const beginGitHubManualLogin = (options?: AuthRequestOptions) =>
  defaultGitHubLoginManager.beginManualLogin(options)
export const cancelGitHubManualLogin = (session: GitHubManualLoginSession) =>
  defaultGitHubLoginManager.cancelManualLogin(session)
export const persistGitHubManualToken = (
  session: GitHubManualLoginSession,
  token: string,
) => defaultGitHubLoginManager.persistManualToken(session, token)
