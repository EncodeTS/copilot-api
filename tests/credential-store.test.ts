import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  CredentialConflictError,
  CredentialStore,
  getCredentialProtectionGuarantee,
} from "../src/lib/credential-store"

const tempDirs: Array<string> = []

async function createStore(): Promise<{
  codexPath: string
  githubPath: string
  root: string
  store: CredentialStore
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "credential-store-"))
  tempDirs.push(root)
  const codexPath = path.join(root, "codex_credentials.json")
  const githubPath = path.join(root, "github_token")
  return {
    codexPath,
    githubPath,
    root,
    store: new CredentialStore({
      codexCredentialPath: codexPath,
      githubTokenPath: githubPath,
    }),
  }
}

const firstCredentials = {
  accessToken: "first-access-token",
  accountId: "first-account",
  expiresAt: 10_000,
  refreshToken: "first-refresh-token",
}

const secondCredentials = {
  accessToken: "second-access-token",
  accountId: "second-account",
  expiresAt: 20_000,
  refreshToken: "second-refresh-token",
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  )
})

describe("credential store", () => {
  test("atomically writes Codex credentials with owner-only permissions", async () => {
    const { codexPath, root, store } = await createStore()

    const result = await store.writeCodexCredentials(firstCredentials)

    expect(await store.readCodexCredentials()).toEqual(firstCredentials)
    expect((await fs.stat(codexPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(`${codexPath}.state.json`)).mode & 0o777).toBe(0o600)
    expect(result.generation).not.toContain(firstCredentials.accessToken)
    expect((await fs.readdir(root)).sort()).toEqual([
      "codex_credentials.json",
      "codex_credentials.json.state.json",
    ])
  })

  test("atomically writes GitHub tokens with owner-only permissions", async () => {
    const { githubPath, root, store } = await createStore()

    await store.writeGitHubToken("  github-secret-token  ")

    expect(await store.readGitHubToken()).toBe("github-secret-token")
    expect((await fs.stat(githubPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(`${githubPath}.state.json`)).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(root)).sort()).toEqual([
      "github_token",
      "github_token.state.json",
    ])
  })

  test("clears GitHub and Codex credentials through atomic protected writes", async () => {
    const { store } = await createStore()
    await store.writeGitHubToken("github-token")
    await store.writeCodexCredentials(firstCredentials)

    await store.clearGitHubToken()
    await store.clearCodexCredentials()

    expect(await store.readGitHubToken()).toBeNull()
    expect(await store.readCodexCredentials()).toBeNull()
    expect(await store.hasCodexCredentials()).toBe(false)
  })

  test("rejects malformed Codex credential files without echoing secrets", async () => {
    const { codexPath, store } = await createStore()
    const secret = "malformed-secret"
    await fs.writeFile(codexPath, `{ "accessToken": "${secret}"`, {
      encoding: "utf8",
      mode: 0o600,
    })

    const error: unknown = await store
      .readCodexCredentials()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(secret)
  })

  test("login reservation can repair malformed legacy Codex credentials", async () => {
    const { codexPath, store } = await createStore()
    await fs.writeFile(codexPath, "{ malformed legacy credential", "utf8")

    const reservation = await store.reserveCodexCredentialRevision()
    await store.writeCodexCredentials(firstCredentials, {
      expectedGeneration: reservation.generation,
    })

    expect(await store.readCodexCredentials()).toEqual(firstCredentials)
  })

  test("cancelled reservation cannot rotate the credential revision", async () => {
    const { store } = await createStore()
    const before = await store.readCodexCredentialSnapshot()
    const controller = new AbortController()

    const error: unknown = await store
      .reserveCodexCredentialRevision({
        preCommit: () => controller.abort(),
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught)
    const after = await store.readCodexCredentialSnapshot()

    expect(error).toMatchObject({ name: "AbortError" })
    expect(after.generation).toBe(before.generation)
  })

  test("rejects a stale generation instead of overwriting a newer login", async () => {
    const { store } = await createStore()
    const initial = await store.readCodexCredentialSnapshot()
    const firstWrite = await store.writeCodexCredentials(firstCredentials, {
      expectedGeneration: initial.generation,
    })

    await store.writeCodexCredentials(secondCredentials)
    const error = await store
      .writeCodexCredentials(firstCredentials, {
        expectedGeneration: firstWrite.generation,
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CredentialConflictError)
    expect(await store.readCodexCredentials()).toEqual(secondCredentials)
  })

  test("changes persistent revision for same-content and A-to-B-to-A writes", async () => {
    const { store } = await createStore()
    const firstA = await store.writeCodexCredentials(firstCredentials)
    const secondA = await store.writeCodexCredentials(firstCredentials)
    await store.writeCodexCredentials(secondCredentials)
    const finalA = await store.writeCodexCredentials(firstCredentials)

    expect(secondA.generation).not.toBe(firstA.generation)
    expect(finalA.generation).not.toBe(firstA.generation)
    const staleResult: unknown = await store
      .writeCodexCredentials(secondCredentials, {
        expectedGeneration: firstA.generation,
      })
      .catch((error: unknown) => error)
    expect(staleResult).toBeInstanceOf(CredentialConflictError)
    expect(await store.readCodexCredentials()).toEqual(firstCredentials)
  })

  test("canonical state survives state-new raw-old crash and repairs mirror", async () => {
    const { codexPath, githubPath, store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const before = await store.readCodexCredentialSnapshot()
    const rotatedCredentials = {
      ...secondCredentials,
      refreshToken: "rotated-refresh-token",
    }
    const crashingStore = new CredentialStore(
      { codexCredentialPath: codexPath, githubTokenPath: githubPath },
      {
        afterCanonicalCommit: () =>
          Promise.reject(new Error("crash before mirror commit")),
      },
    )

    await crashingStore
      .writeCodexCredentials(rotatedCredentials, {
        expectedGeneration: before.generation,
      })
      .catch(() => undefined)
    expect(JSON.parse(await fs.readFile(codexPath, "utf8"))).toEqual(
      firstCredentials,
    )

    const recoveredStore = new CredentialStore({
      codexCredentialPath: codexPath,
      githubTokenPath: githubPath,
    })
    expect(await recoveredStore.readCodexCredentials()).toEqual(
      rotatedCredentials,
    )
    expect(JSON.parse(await fs.readFile(codexPath, "utf8"))).toEqual(
      rotatedCredentials,
    )
  })

  test("finalizes a raw-new pending-state crash without losing rotation", async () => {
    const { codexPath, githubPath, store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const before = await store.readCodexCredentialSnapshot()
    const crashingStore = new CredentialStore(
      { codexCredentialPath: codexPath, githubTokenPath: githubPath },
      {
        afterMirrorCommit: () =>
          Promise.reject(new Error("crash before mirror completion marker")),
      },
    )

    await crashingStore
      .writeCodexCredentials(secondCredentials, {
        expectedGeneration: before.generation,
      })
      .catch(() => undefined)
    expect(JSON.parse(await fs.readFile(codexPath, "utf8"))).toEqual(
      secondCredentials,
    )
    const pendingState = JSON.parse(
      await fs.readFile(`${codexPath}.state.json`, "utf8"),
    ) as { mirrorSynchronized?: unknown }
    expect(pendingState.mirrorSynchronized).toBe(false)

    const recoveredStore = new CredentialStore({
      codexCredentialPath: codexPath,
      githubTokenPath: githubPath,
    })
    expect(await recoveredStore.readCodexCredentials()).toEqual(
      secondCredentials,
    )
    const recoveredState = JSON.parse(
      await fs.readFile(`${codexPath}.state.json`, "utf8"),
    ) as { mirrorSynchronized?: unknown }
    expect(recoveredState.mirrorSynchronized).toBe(true)
  })

  test("adopts a newer lock-external raw login instead of repairing it away", async () => {
    const { codexPath, store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const before = await store.readCodexCredentialSnapshot()
    await fs.writeFile(
      codexPath,
      `${JSON.stringify(secondCredentials, null, 2)}\n`,
      "utf8",
    )
    const future = new Date(Date.now() + 5_000)
    await fs.utimes(codexPath, future, future)

    const after = await store.readCodexCredentialSnapshot()

    expect(after.credentials).toEqual(secondCredentials)
    expect(after.generation).not.toBe(before.generation)
  })

  test("adopts a lock-external raw login when state and mirror mtimes are equal", async () => {
    const { codexPath, store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const before = await store.readCodexCredentialSnapshot()
    await fs.writeFile(
      codexPath,
      `${JSON.stringify(secondCredentials, null, 2)}\n`,
      "utf8",
    )
    const sameTime = new Date(Date.now() + 5_000)
    await fs.utimes(codexPath, sameTime, sameTime)
    await fs.utimes(`${codexPath}.state.json`, sameTime, sameTime)

    const after = await store.readCodexCredentialSnapshot()

    expect(after.credentials).toEqual(secondCredentials)
    expect(after.generation).not.toBe(before.generation)
  })

  test("adopts a lock-external credential deletion as logout", async () => {
    const { codexPath, store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const before = await store.readCodexCredentialSnapshot()
    await fs.rm(codexPath)

    const after = await store.readCodexCredentialSnapshot()

    expect(after.credentials).toBeNull()
    expect(after.generation).not.toBe(before.generation)
    expect(
      await fs.access(codexPath).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("a store release failure cannot strand a live-process lock", async () => {
    const { codexPath, githubPath } = await createStore()
    let renameAttempt = 0
    const store = new CredentialStore(
      { codexCredentialPath: codexPath, githubTokenPath: githubPath },
      {
        lock: {
          releaseAttempts: 3,
          releaseRetryMs: 1,
          rename: async (source, destination) => {
            renameAttempt += 1
            if (renameAttempt <= 3) {
              throw Object.assign(new Error("I/O unavailable"), {
                code: "EIO",
              })
            }
            await fs.rename(source, destination)
          },
          retryMs: 1,
          staleMs: 5,
          timeoutMs: 100,
        },
      },
    )

    await store.writeGitHubToken("durable-token")

    expect(await store.readGitHubToken()).toBe("durable-token")
  })

  test("later cross-process device-flow reservation prevents old flow revival", async () => {
    const { codexPath, githubPath, store: firstProcess } = await createStore()
    const secondProcess = new CredentialStore({
      codexCredentialPath: codexPath,
      githubTokenPath: githubPath,
    })
    const earlier = await firstProcess.reserveGitHubTokenRevision()
    const later = await secondProcess.reserveGitHubTokenRevision()

    const staleResult: unknown = await firstProcess
      .writeGitHubToken("earlier-token", {
        expectedGeneration: earlier.generation,
      })
      .catch((error: unknown) => error)
    await secondProcess.writeGitHubToken("later-token", {
      expectedGeneration: later.generation,
    })

    expect(staleResult).toBeInstanceOf(CredentialConflictError)
    expect(await firstProcess.readGitHubToken()).toBe("later-token")
  })

  test("checks lifecycle cancellation immediately before credential rename", async () => {
    const { store } = await createStore()
    await store.writeCodexCredentials(firstCredentials)
    const snapshot = await store.readCodexCredentialSnapshot()
    const controller = new AbortController()

    const error: unknown = await store
      .writeCodexCredentials(secondCredentials, {
        expectedGeneration: snapshot.generation,
        preCommit: () => controller.abort(),
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: "AbortError" })
    expect(await store.readCodexCredentials()).toEqual(firstCredentials)
  })

  test("allows only one concurrent compare-and-swap writer", async () => {
    const { store } = await createStore()
    const snapshot = await store.readCodexCredentialSnapshot()

    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...secondCredentials,
      accessToken: `candidate-access-${index}`,
      refreshToken: `candidate-refresh-${index}`,
    }))
    const results = await Promise.allSettled(
      candidates.map((credentials) =>
        store.writeCodexCredentials(credentials, {
          expectedGeneration: snapshot.generation,
        }),
      ),
    )

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected).toHaveLength(19)
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(CredentialConflictError)
    }
    const finalCredentials = await store.readCodexCredentials()
    expect(finalCredentials).not.toBeNull()
    expect(candidates).toContainEqual(finalCredentials!)
  })

  test("reports Windows credential protection as best-effort rather than owner-only", () => {
    expect(getCredentialProtectionGuarantee("win32")).toEqual({
      level: "best-effort",
      mechanism: "configured-directory-acl-and-atomic-replace",
    })
    expect(getCredentialProtectionGuarantee("darwin")).toEqual({
      level: "owner-only",
      mechanism: "posix-mode-0600",
    })
  })

  test("routes Windows protection through an explicit best-effort seam", async () => {
    const { codexPath, githubPath, store: _store } = await createStore()
    const protectedPaths: Array<string> = []
    const store = new CredentialStore(
      { codexCredentialPath: codexPath, githubTokenPath: githubPath },
      {
        fileProtector: (filePath, platform) => {
          expect(platform).toBe("win32")
          protectedPaths.push(filePath)
          return Promise.resolve()
        },
        platform: "win32",
      },
    )

    await store.writeGitHubToken("windows-token")

    expect(protectedPaths.length).toBeGreaterThanOrEqual(4)
    expect(await store.readGitHubToken()).toBe("windows-token")
  })
})
