import { describe, expect, test } from "bun:test"

import type { CredentialWriteOptions } from "../src/lib/credential-store"
import {
  GitHubLoginManager,
  type GitHubLoginDependencies,
} from "../src/lib/github-login"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not reached")
}

describe("GitHub login ordering", () => {
  test("manual abort after reservation releases the active lifecycle", async () => {
    const controller = new AbortController()
    const dependencies: GitHubLoginDependencies = {
      getDeviceCode: () => Promise.reject(new Error("unused")),
      pollAccessToken: () => Promise.reject(new Error("unused")),
      reserveGitHubTokenRevision: () =>
        Promise.resolve({
          get generation() {
            queueMicrotask(() => controller.abort())
            return "manual-reservation"
          },
          value: null,
        }),
      writeGitHubToken: () => Promise.reject(new Error("unused")),
    }
    const manager = new GitHubLoginManager(dependencies)

    const error: unknown = await manager
      .beginManualLogin({ signal: controller.signal })
      .catch((caught: unknown) => caught)
    const activeLease = (
      manager as unknown as {
        lifecycle: { getActiveLease: () => unknown }
      }
    ).lifecycle.getActiveLease()

    expect(error).toMatchObject({ kind: "aborted" })
    expect(activeLease).toBeNull()
  })

  test("later-started flow wins and stale poll cannot rename credentials", async () => {
    let credentialRevision = "revision-0"
    let reservationSequence = 0
    let deviceSequence = 0
    const polls = new Map<string, Deferred<string>>()
    const persisted: Array<string> = []
    const pendingWrites: Array<{ commit: () => void }> = []
    const dependencies: GitHubLoginDependencies = {
      getDeviceCode: () => {
        deviceSequence += 1
        const id = `device-${deviceSequence}`
        polls.set(id, deferred<string>())
        return Promise.resolve({
          device_code: id,
          expires_in: 900,
          interval: 5,
          user_code: id,
          verification_uri: "https://github.com/login/device",
        })
      },
      pollAccessToken: (deviceCode) =>
        polls.get(deviceCode.device_code)!.promise,
      reserveGitHubTokenRevision: (options) => {
        options?.preCommit?.()
        if (options?.signal?.aborted) {
          const error = new Error("reservation aborted")
          error.name = "AbortError"
          return Promise.reject(error)
        }
        reservationSequence += 1
        credentialRevision = `reservation-${reservationSequence}`
        return Promise.resolve({ generation: credentialRevision, value: null })
      },
      writeGitHubToken: (token: string, options?: CredentialWriteOptions) =>
        new Promise((resolve, reject) => {
          pendingWrites.push({
            commit() {
              try {
                options?.preCommit?.()
                if (options?.signal?.aborted) {
                  const error = new Error("write aborted")
                  error.name = "AbortError"
                  throw error
                }
                if (options?.expectedGeneration !== credentialRevision) {
                  throw new Error("credential revision conflict")
                }
                persisted.push(token)
                credentialRevision = `revision-${persisted.length}`
                resolve({ generation: credentialRevision })
              } catch (error) {
                reject(
                  error instanceof Error ? error : new Error("write failed"),
                )
              }
            },
          })
        }),
    }
    const manager = new GitHubLoginManager(dependencies)

    const earlier = await manager.start()
    polls.get("device-1")!.resolve("earlier-token")
    await waitFor(() => pendingWrites.length === 1)
    const later = await manager.start()
    expect(earlier.signal.aborted).toBe(true)

    pendingWrites[0].commit()
    const earlierResult: unknown = await earlier.completion.catch(
      (error: unknown) => error,
    )
    expect(earlierResult).toMatchObject({ kind: "aborted" })
    expect(persisted).toEqual([])

    polls.get("device-2")!.resolve("later-token")
    await waitFor(() => pendingWrites.length === 2)
    pendingWrites[1].commit()
    await later.completion
    expect(persisted).toEqual(["later-token"])
  })

  test("a device flow started after manual login wins the shared lifecycle", async () => {
    let credentialRevision = "revision-0"
    let reservationSequence = 0
    const poll = deferred<string>()
    const persisted: Array<string> = []
    const dependencies: GitHubLoginDependencies = {
      getDeviceCode: () =>
        Promise.resolve({
          device_code: "device-later",
          expires_in: 900,
          interval: 5,
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
        }),
      pollAccessToken: () => poll.promise,
      reserveGitHubTokenRevision: (options) => {
        options?.preCommit?.()
        reservationSequence += 1
        credentialRevision = `reservation-${reservationSequence}`
        return Promise.resolve({ generation: credentialRevision, value: null })
      },
      writeGitHubToken: (token, options) => {
        options?.preCommit?.()
        if (options?.signal?.aborted) {
          const error = new Error("write aborted")
          error.name = "AbortError"
          return Promise.reject(error)
        }
        if (options?.expectedGeneration !== credentialRevision) {
          return Promise.reject(new Error("credential revision conflict"))
        }
        persisted.push(token)
        credentialRevision = `write-${persisted.length}`
        return Promise.resolve({ generation: credentialRevision })
      },
    }
    const manager = new GitHubLoginManager(dependencies)

    const manual = await manager.beginManualLogin()
    const laterDevice = await manager.start()
    expect(manual.signal.aborted).toBe(true)

    const manualResult: unknown = await manager
      .persistManualToken(manual, "manual-token")
      .catch((error: unknown) => error)
    expect(manualResult).toMatchObject({ kind: "aborted" })

    poll.resolve("device-token")
    await laterDevice.completion
    expect(persisted).toEqual(["device-token"])
  })
})
