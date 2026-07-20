import { describe, expect, test } from "bun:test"

import type { CodexCredentials } from "../src/lib/oauth/codex"
import type { State } from "../src/lib/state"
import { AuthRequestError } from "../src/lib/auth-request"
import {
  CredentialConflictError,
  type CodexCredentialSnapshot,
  type CredentialWriteOptions,
  type CredentialWriteResult,
} from "../src/lib/credential-store"
import {
  getAuthRetryDelayMs,
  TokenManager,
  type TokenManagerDependencies,
} from "../src/lib/token"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createState(): State {
  return {
    accountType: "individual",
    showToken: false,
    verbose: false,
    vsCodeDeviceId: "test-device",
  }
}

const expiredCredentials: CodexCredentials = {
  accessToken: "expired-access",
  accountId: "expired-account",
  expiresAt: 0,
  refreshToken: "expired-refresh",
}

function refreshedCredentials(label: string): CodexCredentials {
  return {
    accessToken: `${label}-access`,
    accountId: `${label}-account`,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: `${label}-refresh`,
  }
}

function createHarness(
  overrides: {
    enableBackgroundLoops?: boolean
    getCopilotToken?: TokenManagerDependencies["getCopilotToken"]
    now?: () => number
    refreshCodexCredentials?: TokenManagerDependencies["refreshCodexCredentials"]
    sleep?: TokenManagerDependencies["sleep"]
    syncCodexProviderConfig?: TokenManagerDependencies["syncCodexProviderConfig"]
    writeCodexCredentials?: (
      credentials: CodexCredentials,
      options?: CredentialWriteOptions,
    ) => Promise<CredentialWriteResult>
  } = {},
) {
  const runtimeState = createState()
  let snapshot: CodexCredentialSnapshot = {
    credentials: expiredCredentials,
    generation: "generation-0",
  }
  let writeSequence = 0
  let reservationSequence = 0
  const writes: Array<{
    credentials: CodexCredentials
    expectedGeneration?: string
  }> = []
  const logs: Array<string> = []

  const writeCodexCredentials =
    overrides.writeCodexCredentials
    ?? ((credentials: CodexCredentials, options?: CredentialWriteOptions) => {
      options?.preCommit?.()
      if (options?.signal?.aborted) {
        const error = new Error("credential write aborted")
        error.name = "AbortError"
        return Promise.reject(error)
      }
      if (
        options?.expectedGeneration !== undefined
        && options.expectedGeneration !== snapshot.generation
      ) {
        return Promise.reject(new CredentialConflictError())
      }
      writes.push({
        credentials: structuredClone(credentials),
        expectedGeneration: options?.expectedGeneration,
      })
      writeSequence += 1
      snapshot = {
        credentials: structuredClone(credentials),
        generation: `generation-${writeSequence}`,
      }
      return Promise.resolve({ generation: snapshot.generation })
    })

  const manager = new TokenManager({
    credentialStore: {
      readCodexCredentialSnapshot: () =>
        Promise.resolve(structuredClone(snapshot)),
      reserveCodexCredentialRevision: (options) => {
        options?.preCommit?.()
        if (options?.signal?.aborted) {
          const error = new Error("reservation aborted")
          error.name = "AbortError"
          return Promise.reject(error)
        }
        reservationSequence += 1
        snapshot = {
          ...snapshot,
          generation: `reservation-${reservationSequence}`,
        }
        return Promise.resolve(structuredClone(snapshot))
      },
      writeCodexCredentials,
    },
    enableBackgroundLoops: overrides.enableBackgroundLoops ?? false,
    getCopilotToken:
      overrides.getCopilotToken
      ?? (() =>
        Promise.resolve({
          expires_at: 10_000,
          refresh_in: 1_800,
          token: "copilot-token",
        })),
    isOpencodeOauthApp: () => false,
    logger: {
      debug: (...values) => logs.push(values.join(" ")),
      error: (...values) => logs.push(values.join(" ")),
      info: (...values) => logs.push(values.join(" ")),
      warn: (...values) => logs.push(values.join(" ")),
    },
    now: overrides.now,
    refreshCodexCredentials:
      overrides.refreshCodexCredentials
      ?? (() => Promise.resolve(refreshedCredentials("default"))),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    state: runtimeState,
    syncCodexProviderConfig: overrides.syncCodexProviderConfig ?? (() => {}),
  })

  return {
    getSnapshot: () => structuredClone(snapshot),
    logs,
    manager,
    runtimeState,
    setSnapshot: (next: CodexCredentialSnapshot) => {
      snapshot = structuredClone(next)
    },
    writes,
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not reached")
}

describe("token manager", () => {
  test("twenty concurrent expired Codex setups issue one refresh", async () => {
    let refreshCount = 0
    const nextCredentials = refreshedCredentials("singleflight")
    const harness = createHarness({
      refreshCodexCredentials: () => {
        refreshCount += 1
        return Promise.resolve(nextCredentials)
      },
    })

    await Promise.all(
      Array.from({ length: 20 }, () => harness.manager.setupCodexToken()),
    )

    expect(refreshCount).toBe(1)
    expect(harness.writes).toHaveLength(1)
    expect(harness.runtimeState.codexAccessToken).toBe(
      nextCredentials.accessToken,
    )
  })

  test("stop and a newer setup prevent a stale refresh from writing or applying", async () => {
    const refreshes: Array<{
      deferred: Deferred<CodexCredentials>
      signal?: AbortSignal
    }> = []
    const harness = createHarness({
      refreshCodexCredentials: (_credentials, options) => {
        const pending = deferred<CodexCredentials>()
        refreshes.push({ deferred: pending, signal: options?.signal })
        return pending.promise
      },
    })

    const staleSetup = harness.manager
      .setupCodexToken()
      .catch((error: unknown) => error)
    await waitFor(() => refreshes.length === 1)
    harness.manager.stopCodexRefreshLoop()
    expect(refreshes[0].signal?.aborted).toBe(true)

    const currentSetup = harness.manager.setupCodexToken()
    await waitFor(() => refreshes.length === 2)
    const currentCredentials = refreshedCredentials("current")
    refreshes[1].deferred.resolve(currentCredentials)
    await currentSetup

    refreshes[0].deferred.resolve(refreshedCredentials("stale"))
    await staleSetup

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].credentials).toEqual(currentCredentials)
    expect(harness.runtimeState.codexAccessToken).toBe(
      currentCredentials.accessToken,
    )
  })

  test("retries durable persistence with the rotated credential", async () => {
    let refreshCount = 0
    let writeCount = 0
    const writes: Array<CodexCredentials> = []
    const rotated = refreshedCredentials("rotated")
    const harness = createHarness({
      refreshCodexCredentials: () => {
        refreshCount += 1
        return Promise.resolve(rotated)
      },
      writeCodexCredentials: (credentials) => {
        writeCount += 1
        writes.push(structuredClone(credentials))
        if (writeCount === 1) {
          return Promise.reject(
            Object.assign(new Error("temporary disk failure"), {
              code: "EIO",
            }),
          )
        }
        return Promise.resolve({ generation: "generation-rotated" })
      },
    })

    await harness.manager.setupCodexToken()

    expect(refreshCount).toBe(1)
    expect(writes).toEqual([rotated, rotated])
    expect(harness.runtimeState.codexRefreshToken).toBe(rotated.refreshToken)
  })

  test("stop after rotation capture leaves the rotated credential durable", async () => {
    const afterCapture = deferred<void>()
    const rotated = refreshedCredentials("captured-before-stop")
    let refreshCount = 0
    const harness = createHarness({
      refreshCodexCredentials: async (_credentials, options) => {
        refreshCount += 1
        await options?.onRotatedCredentials?.(rotated)
        await afterCapture.promise
        return rotated
      },
    })

    const setup = harness.manager
      .setupCodexToken()
      .catch((error: unknown) => error)
    await waitFor(
      () =>
        harness.getSnapshot().credentials?.refreshToken
        === rotated.refreshToken,
    )
    harness.manager.stopCodexRefreshLoop()
    afterCapture.resolve()
    await setup

    expect(harness.getSnapshot().credentials).toEqual(rotated)
    await harness.manager.setupCodexToken()
    expect(refreshCount).toBe(1)
    expect(harness.runtimeState.codexRefreshToken).toBe(rotated.refreshToken)
  })

  test("write failure and stop recover the pending rotation without old-token reuse", async () => {
    const rotated = refreshedCredentials("pending-after-stop")
    let refreshCount = 0
    let writeCount = 0
    const holder: {
      setSnapshot?: (snapshot: CodexCredentialSnapshot) => void
    } = {}
    const harness = createHarness({
      refreshCodexCredentials: async (_credentials, options) => {
        refreshCount += 1
        await options?.onRotatedCredentials?.(rotated)
        return rotated
      },
      writeCodexCredentials: (credentials, options) => {
        writeCount += 1
        if (writeCount <= 3) {
          return Promise.reject(new Error("disk temporarily unavailable"))
        }
        options?.preCommit?.()
        holder.setSnapshot?.({
          credentials,
          generation: `recovered-${writeCount}`,
        })
        return Promise.resolve({ generation: `recovered-${writeCount}` })
      },
    })
    holder.setSnapshot = harness.setSnapshot

    await harness.manager.setupCodexToken().catch(() => undefined)
    harness.manager.stopCodexRefreshLoop()
    await harness.manager.setupCodexToken()

    expect(refreshCount).toBe(1)
    expect(writeCount).toBe(4)
    expect(harness.runtimeState.codexRefreshToken).toBe(rotated.refreshToken)
  })

  test("a later login reservation defeats an older in-flight rotation commit", async () => {
    const rotated = refreshedCredentials("old-rotation")
    const loginCredentials = refreshedCredentials("new-login")
    const holder: {
      getSnapshot?: () => CodexCredentialSnapshot
      setSnapshot?: (snapshot: CodexCredentialSnapshot) => void
    } = {}
    const pendingWrites: Array<{ commit: () => void }> = []
    const harness = createHarness({
      refreshCodexCredentials: async (_credentials, options) => {
        await options?.onRotatedCredentials?.(rotated)
        return rotated
      },
      writeCodexCredentials: (credentials, options) =>
        new Promise((resolve, reject) => {
          pendingWrites.push({
            commit() {
              try {
                options?.preCommit?.()
                const snapshot = holder.getSnapshot?.()
                if (options?.expectedGeneration !== snapshot?.generation) {
                  throw new CredentialConflictError()
                }
                const generation = `commit-${pendingWrites.length}`
                holder.setSnapshot?.({ credentials, generation })
                resolve({ generation })
              } catch (error) {
                reject(
                  error instanceof Error ? error : new Error("write failed"),
                )
              }
            },
          })
        }),
    })
    holder.getSnapshot = harness.getSnapshot
    holder.setSnapshot = harness.setSnapshot

    const refreshSetup = harness.manager
      .setupCodexToken()
      .catch((error: unknown) => error)
    await waitFor(() => pendingWrites.length === 1)
    const loginSession = await harness.manager.beginCodexLogin()
    pendingWrites[0].commit()
    await refreshSetup

    const loginPersist = harness.manager.persistCodexCredentials(
      loginCredentials,
      { loginSession },
    )
    await waitFor(() => pendingWrites.length === 2)
    pendingWrites[1].commit()
    await loginPersist

    expect(harness.getSnapshot().credentials).toEqual(loginCredentials)
    expect(harness.runtimeState.codexRefreshToken).toBe(
      loginCredentials.refreshToken,
    )
  })

  test("adopts a newer external login when credential CAS fails", async () => {
    const external = refreshedCredentials("external")
    const holder: {
      setSnapshot?: (next: CodexCredentialSnapshot) => void
    } = {}
    const harness = createHarness({
      refreshCodexCredentials: () =>
        Promise.resolve(refreshedCredentials("stale")),
      writeCodexCredentials: () => {
        holder.setSnapshot?.({
          credentials: external,
          generation: "generation-external",
        })
        return Promise.reject(new CredentialConflictError())
      },
    })
    holder.setSnapshot = harness.setSnapshot

    await harness.manager.setupCodexToken()

    expect(harness.getSnapshot().credentials).toEqual(external)
    expect(harness.runtimeState.codexAccessToken).toBe(external.accessToken)
    expect(harness.runtimeState.codexRefreshToken).toBe(external.refreshToken)
  })

  test("manual persistence does not masquerade as an active refresh loop", async () => {
    const harness = createHarness()
    const manual = refreshedCredentials("manual")
    const external = refreshedCredentials("external-after-manual")

    await harness.manager.persistCodexCredentials(manual)
    harness.setSnapshot({
      credentials: external,
      generation: "generation-external-after-manual",
    })
    await harness.manager.setupCodexToken()

    expect(harness.runtimeState.codexAccessToken).toBe(external.accessToken)
  })

  test("twenty concurrent Copilot setups issue one token request", async () => {
    let requestCount = 0
    const harness = createHarness({
      getCopilotToken: () => {
        requestCount += 1
        return Promise.resolve({
          expires_at: 10_000,
          refresh_in: 1_800,
          token: "single-copilot-token",
        })
      },
    })

    await Promise.all(
      Array.from({ length: 20 }, () => harness.manager.setupCopilotToken()),
    )

    expect(requestCount).toBe(1)
    expect(harness.runtimeState.copilotToken).toBe("single-copilot-token")
  })

  test("Copilot stop aborts an in-flight request and ignores its stale result", async () => {
    const pending = deferred<{
      expires_at: number
      refresh_in: number
      token: string
    }>()
    let requestSignal: AbortSignal | undefined
    const harness = createHarness({
      getCopilotToken: (options) => {
        requestSignal = options?.signal
        return pending.promise
      },
    })

    const setup = harness.manager
      .setupCopilotToken()
      .catch((error: unknown) => error)
    await waitFor(() => requestSignal !== undefined)
    harness.manager.stopCopilotRefreshLoop()

    expect(requestSignal?.aborted).toBe(true)
    pending.resolve({
      expires_at: 10_000,
      refresh_in: 1_800,
      token: "stale-copilot-token",
    })
    await setup
    expect(harness.runtimeState.copilotToken).toBeUndefined()
  })

  test("setup joins an in-flight background Copilot refresh", async () => {
    let now = 1_000
    let requestCount = 0
    const backgroundRequest = deferred<{
      expires_at: number
      refresh_in: number
      token: string
    }>()
    const signals: Array<AbortSignal | undefined> = []
    const harness = createHarness({
      enableBackgroundLoops: true,
      getCopilotToken: (options) => {
        requestCount += 1
        signals.push(options?.signal)
        if (requestCount === 1) {
          return Promise.resolve({
            expires_at: 10_000,
            refresh_in: 1,
            token: "initial-copilot-token",
          })
        }
        return backgroundRequest.promise
      },
      now: () => now,
      sleep: (milliseconds) => {
        now += milliseconds
        return Promise.resolve()
      },
    })

    await harness.manager.setupCopilotToken()
    await waitFor(() => requestCount === 2)
    const joinedSetup = harness.manager.setupCopilotToken()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requestCount).toBe(2)
    expect(signals[1]?.aborted).toBe(false)
    backgroundRequest.resolve({
      expires_at: 20_000,
      refresh_in: 1_800,
      token: "current-copilot-token",
    })
    await joinedSetup
    expect(harness.runtimeState.copilotToken).toBe("current-copilot-token")
    harness.manager.stopCopilotRefreshLoop()
  })

  test("Codex stop aborts an in-flight background refresh", async () => {
    const now = 1_000
    const backgroundRefresh = deferred<CodexCredentials>()
    const signals: Array<AbortSignal | undefined> = []
    let refreshCount = 0
    const firstRefresh = {
      ...refreshedCredentials("first"),
      expiresAt: now + 60_000,
    }
    const harness = createHarness({
      enableBackgroundLoops: true,
      now: () => now,
      refreshCodexCredentials: (_credentials, options) => {
        refreshCount += 1
        signals.push(options?.signal)
        return refreshCount === 1 ?
            Promise.resolve(firstRefresh)
          : backgroundRefresh.promise
      },
    })

    await harness.manager.setupCodexToken()
    await waitFor(() => refreshCount === 2)
    harness.manager.stopCodexRefreshLoop()

    expect(signals[1]?.aborted).toBe(true)
    backgroundRefresh.resolve(refreshedCredentials("stale-background"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.runtimeState.codexAccessToken).toBe(firstRefresh.accessToken)
  })

  test("setup joins an in-flight background Codex refresh", async () => {
    const now = 1_000
    const backgroundRefresh = deferred<CodexCredentials>()
    const signals: Array<AbortSignal | undefined> = []
    let refreshCount = 0
    const harness = createHarness({
      enableBackgroundLoops: true,
      now: () => now,
      refreshCodexCredentials: (_credentials, options) => {
        refreshCount += 1
        signals.push(options?.signal)
        if (refreshCount === 1) {
          return Promise.resolve({
            ...refreshedCredentials("first"),
            expiresAt: now + 60_000,
          })
        }
        return backgroundRefresh.promise
      },
    })

    await harness.manager.setupCodexToken()
    await waitFor(() => refreshCount === 2)
    const joinedSetup = harness.manager.setupCodexToken()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(refreshCount).toBe(2)
    expect(signals[1]?.aborted).toBe(false)

    const current = refreshedCredentials("background-current")
    backgroundRefresh.resolve(current)
    await joinedSetup
    expect(harness.runtimeState.codexAccessToken).toBe(current.accessToken)
    harness.manager.stopCodexRefreshLoop()
  })

  test("aborting one Codex waiter does not cancel the shared refresh", async () => {
    const refresh = deferred<CodexCredentials>()
    let refreshSignal: AbortSignal | undefined
    const harness = createHarness({
      refreshCodexCredentials: (_credentials, options) => {
        refreshSignal = options?.signal
        refreshSignal?.addEventListener(
          "abort",
          () => {
            const error = new Error("refresh aborted")
            error.name = "AbortError"
            refresh.reject(error)
          },
          { once: true },
        )
        return refresh.promise
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = harness.manager
      .setupCodexToken({ signal: firstController.signal })
      .catch((error: unknown) => error)
    await waitFor(() => refreshSignal !== undefined)
    const second = harness.manager.setupCodexToken({
      signal: secondController.signal,
    })

    firstController.abort()
    const firstResult = await first
    expect(firstResult).toMatchObject({ kind: "aborted" })
    expect(refreshSignal?.aborted).toBe(false)

    const sharedCredentials = refreshedCredentials("shared-waiter")
    refresh.resolve(sharedCredentials)
    await second
    expect(harness.runtimeState.codexAccessToken).toBe(
      sharedCredentials.accessToken,
    )
  })

  test("aborting the last Codex waiter cancels the real refresh", async () => {
    const refresh = deferred<CodexCredentials>()
    let refreshSignal: AbortSignal | undefined
    const harness = createHarness({
      refreshCodexCredentials: (_credentials, options) => {
        refreshSignal = options?.signal
        return refresh.promise
      },
    })
    const controller = new AbortController()
    const setup = harness.manager
      .setupCodexToken({ signal: controller.signal })
      .catch((error: unknown) => error)
    await waitFor(() => refreshSignal !== undefined)

    controller.abort()
    const result = await setup

    expect(result).toMatchObject({ kind: "aborted" })
    expect(refreshSignal?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.runtimeState.codexAccessToken).toBeUndefined()
    expect(harness.writes).toHaveLength(0)
  })

  test("retryable background auth errors use bounded backoff", async () => {
    const now = 1_000
    const sleeps: Array<number> = []
    const blockedSleep = deferred<void>()
    let refreshCount = 0
    const harness = createHarness({
      enableBackgroundLoops: true,
      now: () => now,
      refreshCodexCredentials: () => {
        refreshCount += 1
        if (refreshCount === 1) {
          return Promise.resolve({
            ...refreshedCredentials("first"),
            expiresAt: now + 60_000,
          })
        }
        return Promise.reject(
          Object.assign(new Error("network unavailable"), {
            kind: "retryable",
          }),
        )
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        await blockedSleep.promise
      },
    })

    await harness.manager.setupCodexToken()
    await waitFor(() => sleeps.length === 1)

    expect(sleeps[0]).toBeGreaterThanOrEqual(15_000)
    expect(sleeps[0]).toBeLessThanOrEqual(30_000)
    harness.manager.stopCodexRefreshLoop()
    blockedSleep.resolve()
  })

  test("permanent background auth errors stop without retrying", async () => {
    const now = 1_000
    const sleeps: Array<number> = []
    const blockedSleep = deferred<void>()
    let refreshCount = 0
    const harness = createHarness({
      enableBackgroundLoops: true,
      now: () => now,
      refreshCodexCredentials: () => {
        refreshCount += 1
        if (refreshCount === 1) {
          return Promise.resolve({
            ...refreshedCredentials("first"),
            expiresAt: now + 60_000,
          })
        }
        return Promise.reject(
          new AuthRequestError({
            action: "Codex token refresh",
            kind: "permanent",
            oauthCode: "invalid_grant",
            status: 400,
          }),
        )
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        await blockedSleep.promise
      },
    })

    await harness.manager.setupCodexToken()
    await waitFor(() => refreshCount === 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sleeps).toEqual([])
    expect(refreshCount).toBe(2)
    harness.manager.stopCodexRefreshLoop()
    blockedSleep.resolve()
  })

  test("permanent Copilot auth errors stop without entering retry backoff", async () => {
    let now = 1_000
    let requestCount = 0
    const sleeps: Array<number> = []
    const harness = createHarness({
      enableBackgroundLoops: true,
      getCopilotToken: () => {
        requestCount += 1
        if (requestCount === 1) {
          return Promise.resolve({
            expires_at: 10_000,
            refresh_in: 1,
            token: "initial-copilot-token",
          })
        }
        return Promise.reject(
          new AuthRequestError({
            action: "GitHub Copilot token request",
            kind: "permanent",
            oauthCode: "invalid_grant",
            status: 401,
          }),
        )
      },
      now: () => now,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        return Promise.resolve()
      },
    })

    await harness.manager.setupCopilotToken()
    await waitFor(() => requestCount === 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sleeps).toEqual([1_000])
    expect(requestCount).toBe(2)
    harness.manager.stopCopilotRefreshLoop()
  })

  test("permanent Codex auth failure waits for a newer credential generation", async () => {
    let refreshCount = 0
    const recovered = refreshedCredentials("recovered")
    const harness = createHarness({
      refreshCodexCredentials: () => {
        refreshCount += 1
        if (refreshCount === 1) {
          return Promise.reject(
            new AuthRequestError({
              action: "Codex token refresh",
              kind: "permanent",
              oauthCode: "invalid_grant",
              status: 400,
            }),
          )
        }
        return Promise.resolve(recovered)
      },
    })

    const firstError: unknown = await harness.manager
      .setupCodexToken()
      .catch((error: unknown) => error)
    const cachedError: unknown = await harness.manager
      .setupCodexToken()
      .catch((error: unknown) => error)
    expect(refreshCount).toBe(1)
    expect(firstError).toMatchObject({
      downstreamStatus: 400,
      kind: "permanent",
      upstreamStatus: 400,
    })
    expect(cachedError).toMatchObject({
      downstreamStatus: 400,
      kind: "permanent",
      upstreamStatus: 400,
    })

    harness.setSnapshot({
      credentials: expiredCredentials,
      generation: "generation-new-login",
    })
    await harness.manager.setupCodexToken()

    expect(refreshCount).toBe(2)
    expect(harness.runtimeState.codexAccessToken).toBe(recovered.accessToken)
  })

  test("a programmer TypeError is not cached as a permanent auth rejection", async () => {
    let refreshCount = 0
    const recovered = refreshedCredentials("type-error-recovered")
    const harness = createHarness({
      refreshCodexCredentials: () => {
        refreshCount += 1
        return refreshCount === 1 ?
            Promise.reject(new TypeError("programmer defect"))
          : Promise.resolve(recovered)
      },
    })

    await harness.manager.setupCodexToken().catch(() => undefined)
    await harness.manager.setupCodexToken()

    expect(refreshCount).toBe(2)
    expect(harness.runtimeState.codexAccessToken).toBe(recovered.accessToken)
  })

  test("config persistence failure releases lifecycle and reloads renamed credentials", async () => {
    let configAttempt = 0
    const manual = refreshedCredentials("manual-partial")
    const harness = createHarness({
      syncCodexProviderConfig: () => {
        configAttempt += 1
        if (configAttempt === 1) {
          throw new Error("config write failed")
        }
      },
    })
    harness.runtimeState.codexAccessToken = "old-access"
    harness.runtimeState.codexRefreshToken = "old-refresh"
    harness.runtimeState.codexExpiresAt = Date.now() + 3_600_000
    harness.runtimeState.codexAccountId = "old-account"

    await harness.manager.persistCodexCredentials(manual).catch(() => undefined)
    await harness.manager.setupCodexToken()

    expect(configAttempt).toBe(2)
    expect(harness.runtimeState.codexAccessToken).toBe(manual.accessToken)
    expect(harness.runtimeState.codexRefreshToken).toBe(manual.refreshToken)
  })

  test("a later-started Codex login session wins regardless of completion order", async () => {
    const harness = createHarness()
    const earlier = await harness.manager.beginCodexLogin()
    const later = await harness.manager.beginCodexLogin()
    const laterCredentials = refreshedCredentials("later-login")

    expect(earlier.signal.aborted).toBe(true)
    const staleResult: unknown = await harness.manager
      .persistCodexCredentials(refreshedCredentials("earlier-login"), {
        loginSession: earlier,
      })
      .catch((error: unknown) => error)

    expect(staleResult).toMatchObject({ kind: "aborted" })
    expect(harness.writes).toHaveLength(0)
    await harness.manager.persistCodexCredentials(laterCredentials, {
      loginSession: later,
    })
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].credentials).toEqual(laterCredentials)
  })

  test("ordinary lifecycle logs never contain returned credentials", async () => {
    const harness = createHarness()

    await harness.manager.setupCodexToken()
    await harness.manager.setupCopilotToken()

    const output = harness.logs.join("\n")
    expect(output).not.toContain("default-access")
    expect(output).not.toContain("default-refresh")
    expect(output).not.toContain("copilot-token")
  })

  test("auth retry delays use bounded exponential backoff and jitter", () => {
    expect(getAuthRetryDelayMs(0, () => 0)).toBe(15_000)
    expect(getAuthRetryDelayMs(1, () => 0)).toBe(30_000)
    expect(getAuthRetryDelayMs(99, () => 1)).toBe(600_000)
  })
})
