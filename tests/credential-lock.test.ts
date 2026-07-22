import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { CredentialFileLock } from "../src/lib/credential-lock"

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

const tempDirs: Array<string> = []

async function createLock(
  options: {
    afterReclaimRename?: (tombstonePath: string) => Promise<void>
    timeoutMs?: number
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-lock-"))
  tempDirs.push(root)
  const lockPath = path.join(root, "credentials.lock")
  return {
    lock: new CredentialFileLock(lockPath, {
      afterReclaimRename: options.afterReclaimRename,
      retryMs: 1,
      staleMs: 5,
      timeoutMs: options.timeoutMs ?? 500,
    }),
    lockPath,
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  )
})

describe("credential file lock ownership", () => {
  test("an old owner release cannot delete an ABA replacement lock", async () => {
    const { lock, lockPath } = await createLock()
    const first = await lock.acquire()
    await fs.rm(lockPath, { recursive: true })
    const replacement = await lock.acquire()

    await first.release()

    expect(await pathExists(lockPath)).toBe(true)
    await replacement.release()
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("release retries transient Windows-style rename failures", async () => {
    const { lockPath } = await createLock()
    let renameAttempt = 0
    const lock = new CredentialFileLock(lockPath, {
      releaseRetryMs: 1,
      rename: async (source, destination) => {
        renameAttempt += 1
        if (renameAttempt === 1) {
          throw Object.assign(new Error("temporarily busy"), { code: "EPERM" })
        }
        await fs.rename(source, destination)
      },
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })
    const lease = await lock.acquire()

    await lease.release()

    expect(renameAttempt).toBe(2)
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("failed release remains retryable on a later call", async () => {
    const { lockPath } = await createLock()
    let renameAttempt = 0
    const lock = new CredentialFileLock(lockPath, {
      releaseAttempts: 3,
      releaseRetryMs: 1,
      rename: async (source, destination) => {
        renameAttempt += 1
        if (renameAttempt <= 3) {
          throw Object.assign(new Error("I/O unavailable"), { code: "EIO" })
        }
        await fs.rename(source, destination)
      },
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })
    const lease = await lock.acquire()

    const firstError: unknown = await lease
      .release()
      .catch((error: unknown) => error)
    expect(firstError).toMatchObject({ code: "EIO" })
    expect(await pathExists(lockPath)).toBe(true)

    await lease.release()
    expect(renameAttempt).toBe(4)
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("abort after owner creation releases the lock before returning", async () => {
    const { lockPath } = await createLock()
    const controller = new AbortController()
    const lock = new CredentialFileLock(lockPath, {
      afterOwnerCreated: () => {
        controller.abort()
        return Promise.resolve()
      },
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })

    const error: unknown = await lock
      .acquire(controller.signal)
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("does not reclaim a slow owner while its PID is still alive", async () => {
    const { lock, lockPath } = await createLock({ timeoutMs: 25 })
    const live = await lock.acquire()
    const ownerToken = (await fs.readdir(lockPath))[0]
    await fs.rm(path.join(lockPath, ownerToken, "owner.json"))
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    await fs.utimes(path.join(lockPath, ownerToken), old, old)

    const error: unknown = await lock
      .acquire()
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      message: "Timed out waiting for credential file lock",
    })
    expect(await pathExists(lockPath)).toBe(true)
    await live.release()
  })

  test("reclaims an old crash-halfwritten empty lock root", async () => {
    const { lock, lockPath } = await createLock()
    await fs.mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)

    const lease = await lock.acquire()

    expect(await pathExists(lockPath)).toBe(true)
    await lease.release()
  })

  test("recovers a stale reclaim claim left before the root rename", async () => {
    const { lockPath } = await createLock()
    await fs.mkdir(path.join(lockPath, ".reclaim"), { recursive: true })
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    await fs.utimes(path.join(lockPath, ".reclaim"), old, old)

    const lease = await new CredentialFileLock(lockPath, {
      isProcessAlive: () => false,
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    }).acquire()

    expect(await pathExists(lockPath)).toBe(true)
    await lease.release()
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("recovers a dead reaper after it durably owns the reclaim claim", async () => {
    const { lockPath } = await createLock()
    await fs.mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    const crashedReaper = new CredentialFileLock(lockPath, {
      afterReclaimClaimed: () =>
        Promise.reject(new Error("simulated reaper crash")),
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })

    const crash: unknown = await crashedReaper
      .acquire()
      .catch((error: unknown) => error)
    expect(crash).toMatchObject({ message: "simulated reaper crash" })

    const lease = await new CredentialFileLock(lockPath, {
      isProcessAlive: () => false,
      now: () => Date.now() + 60_000,
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    }).acquire()

    await lease.release()
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("a failed root move cannot strand a live reaper claim", async () => {
    const { lockPath } = await createLock()
    await fs.mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    let renameAttempt = 0
    const lock = new CredentialFileLock(lockPath, {
      rename: async (source, destination) => {
        renameAttempt += 1
        if (renameAttempt <= 2) {
          throw Object.assign(new Error("I/O unavailable"), { code: "EIO" })
        }
        await fs.rename(source, destination)
      },
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })

    const firstError: unknown = await lock
      .acquire()
      .catch((error: unknown) => error)
    expect(firstError).toMatchObject({ code: "EIO" })

    const lease = await lock.acquire()
    expect(renameAttempt).toBeGreaterThanOrEqual(3)
    await lease.release()
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("an owner-record failure cannot strand a live reaper claim", async () => {
    const { lockPath } = await createLock()
    await fs.mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    let ownerCreationAttempt = 0
    const lock = new CredentialFileLock(lockPath, {
      afterReclaimOwnerCreated: () => {
        ownerCreationAttempt += 1
        if (ownerCreationAttempt === 1) {
          return Promise.reject(
            Object.assign(new Error("owner record unavailable"), {
              code: "EIO",
            }),
          )
        }
        return Promise.resolve()
      },
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 500,
    })

    const firstError: unknown = await lock
      .acquire()
      .catch((error: unknown) => error)
    expect(firstError).toMatchObject({ code: "EIO" })

    const lease = await lock.acquire()
    expect(ownerCreationAttempt).toBe(2)
    await lease.release()
    expect(await pathExists(lockPath)).toBe(false)
  })

  test("reclaims a stale owner whose PID is no longer alive", async () => {
    const { lock, lockPath } = await createLock()
    const ownerToken = "dead-owner"
    const ownerDirectory = path.join(lockPath, ownerToken)
    await fs.mkdir(ownerDirectory, { recursive: true })
    await fs.writeFile(
      path.join(ownerDirectory, "owner.json"),
      JSON.stringify({
        createdAtMs: Date.now() - 60_000,
        ownerToken,
        pid: 2_147_483_647,
      }),
    )
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    await fs.utimes(ownerDirectory, old, old)

    const lease = await lock.acquire()

    expect(await pathExists(lockPath)).toBe(true)
    await lease.release()
  })

  test("two reapers and a third acquirer never delete a replacement root", async () => {
    const aClaimed = deferred<void>()
    const bLostClaim = deferred<void>()
    const oldRootMoved = deferred<void>()
    const allowCleanup = deferred<void>()
    const bothReapersObserved = deferred<void>()
    const thirdAcquired = deferred<void>()
    let reaperObservations = 0
    const { lockPath } = await createLock()
    await fs.mkdir(lockPath)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)

    const reaperAController = new AbortController()
    const reaperBController = new AbortController()
    const arriveAtObservationBarrier = async () => {
      reaperObservations += 1
      if (reaperObservations === 2) bothReapersObserved.resolve()
      await bothReapersObserved.promise
    }
    const reaperA = new CredentialFileLock(lockPath, {
      afterReclaimClaimed: async () => {
        aClaimed.resolve()
        await bLostClaim.promise
      },
      afterReclaimRename: async () => {
        oldRootMoved.resolve()
        await allowCleanup.promise
      },
      beforeReclaimRename: arriveAtObservationBarrier,
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 1_000,
    }).acquire(reaperAController.signal)
    const reaperB = new CredentialFileLock(lockPath, {
      beforeReclaimRename: async () => {
        await arriveAtObservationBarrier()
        await aClaimed.promise
      },
      onReclaimClaimLost: () => {
        bLostClaim.resolve()
        return Promise.resolve()
      },
      retryMs: 1,
      sleep: async () => {
        await thirdAcquired.promise
      },
      staleMs: 5,
      timeoutMs: 1_000,
    }).acquire(reaperBController.signal)

    await oldRootMoved.promise
    const thirdLease = await new CredentialFileLock(lockPath, {
      retryMs: 1,
      staleMs: 5,
      timeoutMs: 1_000,
    }).acquire()
    thirdAcquired.resolve()
    expect(await pathExists(lockPath)).toBe(true)
    allowCleanup.resolve()
    reaperAController.abort()
    reaperBController.abort()
    await Promise.allSettled([reaperA, reaperB])
    expect(await pathExists(lockPath)).toBe(true)
    await thirdLease.release()
    expect(await pathExists(lockPath)).toBe(false)
  })
})
