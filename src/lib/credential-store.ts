import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { CodexCredentials } from "~/lib/oauth/codex"

import {
  CredentialFileLock,
  type CredentialFileLockOptions,
} from "./credential-lock"
import { PATHS } from "./paths"

const CREDENTIAL_STATE_VERSION = 3

interface CredentialStateEnvelope {
  committedAtMs: number
  content: string | null
  mirrorHash: string
  mirrorSynchronized: boolean
  previousMirrorHash: string | null
  revision: string
  version: typeof CREDENTIAL_STATE_VERSION
}

export interface CredentialStorePaths {
  codexCredentialPath: string
  githubTokenPath: string
}

export interface CredentialSnapshot<T> {
  generation: string
  value: T | null
}

export interface CodexCredentialSnapshot {
  credentials: CodexCredentials | null
  generation: string
}

export interface CredentialWriteOptions {
  expectedGeneration?: string
  preCommit?: () => void
  signal?: AbortSignal
}

export interface CredentialWriteResult {
  generation: string
}

export interface CredentialRevisionReservationOptions {
  preCommit?: () => void
  signal?: AbortSignal
}

export interface CredentialProtectionGuarantee {
  level: "best-effort" | "owner-only"
  mechanism: "configured-directory-acl-and-atomic-replace" | "posix-mode-0600"
}

export type CredentialFileProtector = (
  filePath: string,
  platform: NodeJS.Platform,
) => Promise<void>

export interface CredentialStoreOptions {
  afterCanonicalCommit?: () => Promise<void>
  afterMirrorCommit?: () => Promise<void>
  fileProtector?: CredentialFileProtector
  lock?: CredentialFileLockOptions
  platform?: NodeJS.Platform
}

function hashContent(content: string | null): string {
  return createHash("sha256")
    .update(content === null ? "missing\0" : `present\0${content}`)
    .digest("hex")
}

export class CredentialConflictError extends Error {
  constructor() {
    super("Credential file changed since it was read")
    this.name = "CredentialConflictError"
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null
    throw error
  }
}

function getStatePath(filePath: string): string {
  return `${filePath}.state.json`
}

function parseStateEnvelope(
  raw: string,
  statePath: string,
): CredentialStateEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Credential state is not valid JSON: ${statePath}`, {
      cause: error,
    })
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || !(
      (parsed as { version?: unknown }).version === 1
      || (parsed as { version?: unknown }).version === 2
      || (parsed as { version?: unknown }).version === CREDENTIAL_STATE_VERSION
    )
    || typeof (parsed as { revision?: unknown }).revision !== "string"
    || !(parsed as { revision: string }).revision
    || !(
      typeof (parsed as { content?: unknown }).content === "string"
      || (parsed as { content?: unknown }).content === null
    )
  ) {
    throw new Error(`Credential state is missing required fields: ${statePath}`)
  }
  const legacy = parsed as {
    committedAtMs?: unknown
    content: string | null
    mirrorHash?: unknown
    mirrorSynchronized?: unknown
    previousMirrorHash?: unknown
    revision: string
    version?: unknown
  }
  const computedMirrorHash = hashContent(legacy.content)
  if (
    (legacy.version === 2 || legacy.version === CREDENTIAL_STATE_VERSION)
    && (typeof legacy.committedAtMs !== "number"
      || !Number.isFinite(legacy.committedAtMs)
      || legacy.mirrorHash !== computedMirrorHash
      || !(
        typeof legacy.previousMirrorHash === "string"
        || legacy.previousMirrorHash === null
      )
      || (legacy.version === CREDENTIAL_STATE_VERSION
        && typeof legacy.mirrorSynchronized !== "boolean"))
  ) {
    throw new Error(`Credential state is missing required fields: ${statePath}`)
  }
  return {
    committedAtMs:
      (
        typeof legacy.committedAtMs === "number"
        && Number.isFinite(legacy.committedAtMs)
      ) ?
        legacy.committedAtMs
      : 0,
    content: legacy.content,
    mirrorHash:
      typeof legacy.mirrorHash === "string" && legacy.mirrorHash ?
        legacy.mirrorHash
      : computedMirrorHash,
    mirrorSynchronized:
      legacy.version === CREDENTIAL_STATE_VERSION
      && legacy.mirrorSynchronized === true,
    previousMirrorHash:
      typeof legacy.previousMirrorHash === "string" ?
        legacy.previousMirrorHash
      : null,
    revision: legacy.revision,
    version: CREDENTIAL_STATE_VERSION,
  }
}

function serializeStateEnvelope(state: CredentialStateEnvelope): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function getCredentialProtectionGuarantee(
  platform: NodeJS.Platform = process.platform,
): CredentialProtectionGuarantee {
  return platform === "win32" ?
      {
        level: "best-effort",
        mechanism: "configured-directory-acl-and-atomic-replace",
      }
    : { level: "owner-only", mechanism: "posix-mode-0600" }
}

async function defaultFileProtector(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    // Node's chmod does not install an owner-only Windows ACL. The caller's
    // configured directory ACL is the actual boundary; chmod is only a
    // best-effort compatibility hint.
    await fs.chmod(filePath, 0o600).catch(() => undefined)
    return
  }
  await fs.chmod(filePath, 0o600)
}

async function fsyncDirectory(
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") return
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function assertCommitAllowed(options: CredentialWriteOptions): void {
  options.preCommit?.()
  if (options.signal?.aborted) {
    throw abortError("Credential write was aborted")
  }
}

async function writeTemporaryFile(options: {
  content: string
  filePath: string
  platform: NodeJS.Platform
  protectFile: CredentialFileProtector
}): Promise<void> {
  const handle = await fs.open(options.filePath, "wx", 0o600)
  try {
    await handle.writeFile(options.content, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await options.protectFile(options.filePath, options.platform)
  const readback = await fs.readFile(options.filePath, "utf8")
  if (readback !== options.content) {
    throw new Error("Credential temporary file readback did not match")
  }
}

async function commitStateOnly(options: {
  filePath: string
  platform: NodeJS.Platform
  reservation?: CredentialRevisionReservationOptions
  protectFile: CredentialFileProtector
  state: CredentialStateEnvelope
}): Promise<void> {
  const statePath = getStatePath(options.filePath)
  const temporaryStatePath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeTemporaryFile({
      content: serializeStateEnvelope(options.state),
      filePath: temporaryStatePath,
      platform: options.platform,
      protectFile: options.protectFile,
    })
    if (options.reservation) assertCommitAllowed(options.reservation)
    await fs.rename(temporaryStatePath, statePath)
    await options.protectFile(statePath, options.platform)
    await fsyncDirectory(path.dirname(options.filePath), options.platform)
  } finally {
    await fs.rm(temporaryStatePath, { force: true }).catch(() => undefined)
  }
}

async function repairCompatibilityMirror(options: {
  content: string | null
  filePath: string
  platform: NodeJS.Platform
  protectFile: CredentialFileProtector
}): Promise<void> {
  if (options.content === null) {
    await fs.rm(options.filePath, { force: true })
    await fsyncDirectory(path.dirname(options.filePath), options.platform)
    return
  }
  const temporaryPath = `${options.filePath}.${process.pid}.${randomUUID()}.repair`
  try {
    await writeTemporaryFile({
      content: options.content,
      filePath: temporaryPath,
      platform: options.platform,
      protectFile: options.protectFile,
    })
    await fs.rename(temporaryPath, options.filePath)
    await options.protectFile(options.filePath, options.platform)
    await fsyncDirectory(path.dirname(options.filePath), options.platform)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function readOrCreateStateUnderLock(options: {
  filePath: string
  platform: NodeJS.Platform
  protectFile: CredentialFileProtector
}): Promise<CredentialStateEnvelope> {
  const statePath = getStatePath(options.filePath)
  const [rawState, rawCredential] = await Promise.all([
    readOptionalFile(statePath),
    readOptionalFile(options.filePath),
  ])

  if (rawState !== null) {
    const state = parseStateEnvelope(rawState, statePath)
    if (state.content === rawCredential) {
      if (state.mirrorSynchronized) return state
      const synchronized = { ...state, mirrorSynchronized: true }
      await commitStateOnly({ ...options, state: synchronized })
      return synchronized
    }

    const rawMirrorHash = hashContent(rawCredential)
    if (
      !state.mirrorSynchronized
      && rawMirrorHash === state.previousMirrorHash
    ) {
      // Canonical state committed first and the process crashed before updating
      // the compatibility mirror. The pending phase and previous mirror hash
      // identify that crash without relying on filesystem timestamp precision.
      await repairCompatibilityMirror({
        content: state.content,
        filePath: options.filePath,
        platform: options.platform,
        protectFile: options.protectFile,
      })
      const synchronized = { ...state, mirrorSynchronized: true }
      await commitStateOnly({ ...options, state: synchronized })
      return synchronized
    }

    // A completed canonical/mirror pair cannot legitimately differ. A legacy
    // writer changed or removed the compatibility mirror, so adopt that later
    // login/logout as a new credential event. A pending state with any value
    // other than its previous mirror is also an external write, regardless of
    // equal or coarse filesystem mtimes.
    const migrated: CredentialStateEnvelope = {
      committedAtMs: Date.now(),
      content: rawCredential,
      mirrorHash: hashContent(rawCredential),
      mirrorSynchronized: true,
      previousMirrorHash: state.mirrorHash,
      revision: randomUUID(),
      version: CREDENTIAL_STATE_VERSION,
    }
    await commitStateOnly({ ...options, state: migrated })
    return migrated
  }

  const migrated: CredentialStateEnvelope = {
    committedAtMs: Date.now(),
    content: rawCredential,
    mirrorHash: hashContent(rawCredential),
    mirrorSynchronized: true,
    previousMirrorHash: null,
    revision: randomUUID(),
    version: CREDENTIAL_STATE_VERSION,
  }
  await commitStateOnly({ ...options, state: migrated })
  return migrated
}

async function withCredentialLock<Value>(
  filePath: string,
  storeOptions: CredentialStoreOptions,
  signal: AbortSignal | undefined,
  operation: (context: {
    platform: NodeJS.Platform
    protectFile: CredentialFileProtector
  }) => Promise<Value>,
): Promise<Value> {
  if (signal?.aborted) throw abortError("Credential operation was aborted")
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const lock = new CredentialFileLock(`${filePath}.lock`, storeOptions.lock)
  const lease = await lock.acquire(signal)
  try {
    return await operation({
      platform: storeOptions.platform ?? process.platform,
      protectFile: storeOptions.fileProtector ?? defaultFileProtector,
    })
  } finally {
    try {
      await lease.release()
    } catch {
      // Keep the lease alive for one more bounded background release cycle.
      // release() has already marked it abandoned, so even another failure
      // cannot leave this live PID as an unreclaimable owner.
      void lease.release().catch(() => undefined)
    }
  }
}

async function readProtectedSnapshot(
  filePath: string,
  storeOptions: CredentialStoreOptions,
): Promise<CredentialSnapshot<string>> {
  return await withCredentialLock(
    filePath,
    storeOptions,
    undefined,
    async ({ platform, protectFile }) => {
      const state = await readOrCreateStateUnderLock({
        filePath,
        platform,
        protectFile,
      })
      return { generation: state.revision, value: state.content }
    },
  )
}

async function reserveProtectedRevision(
  filePath: string,
  storeOptions: CredentialStoreOptions,
  options: CredentialRevisionReservationOptions = {},
): Promise<CredentialSnapshot<string>> {
  return await withCredentialLock(
    filePath,
    storeOptions,
    options.signal,
    async ({ platform, protectFile }) => {
      const current = await readOrCreateStateUnderLock({
        filePath,
        platform,
        protectFile,
      })
      const reserved: CredentialStateEnvelope = {
        ...current,
        committedAtMs: Date.now(),
        mirrorSynchronized: true,
        previousMirrorHash: current.mirrorHash,
        revision: randomUUID(),
      }
      await commitStateOnly({
        filePath,
        platform,
        reservation: options,
        protectFile,
        state: reserved,
      })
      return { generation: reserved.revision, value: reserved.content }
    },
  )
}

async function writeProtectedFile(
  filePath: string,
  content: string,
  options: CredentialWriteOptions = {},
  storeOptions: CredentialStoreOptions = {},
): Promise<CredentialWriteResult> {
  return await withCredentialLock(
    filePath,
    storeOptions,
    options.signal,
    async ({ platform, protectFile }) => {
      const current = await readOrCreateStateUnderLock({
        filePath,
        platform,
        protectFile,
      })
      if (
        options.expectedGeneration !== undefined
        && current.revision !== options.expectedGeneration
      ) {
        throw new CredentialConflictError()
      }

      const directory = path.dirname(filePath)
      const statePath = getStatePath(filePath)
      const temporaryCredentialPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      )
      const temporaryStatePath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
      const nextState: CredentialStateEnvelope = {
        committedAtMs: Date.now(),
        content,
        mirrorHash: hashContent(content),
        mirrorSynchronized: false,
        previousMirrorHash: current.mirrorHash,
        revision: randomUUID(),
        version: CREDENTIAL_STATE_VERSION,
      }

      try {
        await Promise.all([
          writeTemporaryFile({
            content,
            filePath: temporaryCredentialPath,
            platform,
            protectFile,
          }),
          writeTemporaryFile({
            content: serializeStateEnvelope(nextState),
            filePath: temporaryStatePath,
            platform,
            protectFile,
          }),
        ])

        // Re-read the canonical revision under the same owner lock and perform
        // the lifecycle guard at the final pre-commit point.
        const beforeCommit = await readOrCreateStateUnderLock({
          filePath,
          platform,
          protectFile,
        })
        if (beforeCommit.revision !== current.revision) {
          throw new CredentialConflictError()
        }
        assertCommitAllowed(options)

        // Canonical state is the commit point. Make it durable first, then
        // update the raw compatibility mirror. The final synchronized state
        // phase distinguishes an interrupted mirror update from a later
        // lock-external login or logout without relying on file mtimes.
        await fs.rename(temporaryStatePath, statePath)
        await protectFile(statePath, platform)
        await fsyncDirectory(directory, platform)
        await storeOptions.afterCanonicalCommit?.()
        await fs.rename(temporaryCredentialPath, filePath)
        await protectFile(filePath, platform)
        await fsyncDirectory(directory, platform)
        await storeOptions.afterMirrorCommit?.()
        await commitStateOnly({
          filePath,
          platform,
          protectFile,
          state: { ...nextState, mirrorSynchronized: true },
        })
        return { generation: nextState.revision }
      } finally {
        await Promise.all([
          fs
            .rm(temporaryCredentialPath, { force: true })
            .catch(() => undefined),
          fs.rm(temporaryStatePath, { force: true }).catch(() => undefined),
        ])
      }
    },
  )
}

function normalizeCodexCredentials(
  credentials: unknown,
): CodexCredentials | null {
  if (!credentials || typeof credentials !== "object") return null
  const candidate = credentials as Partial<CodexCredentials>
  if (
    typeof candidate.accessToken !== "string"
    || !candidate.accessToken
    || typeof candidate.refreshToken !== "string"
    || !candidate.refreshToken
    || typeof candidate.expiresAt !== "number"
    || !Number.isFinite(candidate.expiresAt)
    || typeof candidate.accountId !== "string"
    || !candidate.accountId
  ) {
    return null
  }
  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    accountId: candidate.accountId,
  }
}

function parseCodexSnapshot(
  snapshot: CredentialSnapshot<string>,
  credentialPath: string,
): CodexCredentialSnapshot {
  const raw = snapshot.value
  if (!raw?.trim()) {
    return { credentials: null, generation: snapshot.generation }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `Codex credentials file is not valid JSON: ${credentialPath}`,
      { cause: error },
    )
  }
  const credentials = normalizeCodexCredentials(parsed)
  if (!credentials) {
    throw new Error(
      `Codex credentials file is missing required fields: ${credentialPath}`,
    )
  }
  return { credentials, generation: snapshot.generation }
}

export class CredentialStore {
  readonly paths: CredentialStorePaths
  private readonly options: CredentialStoreOptions

  constructor(
    paths: CredentialStorePaths,
    options: CredentialStoreOptions = {},
  ) {
    this.paths = paths
    this.options = options
  }

  async readGitHubTokenSnapshot(): Promise<CredentialSnapshot<string>> {
    const snapshot = await readProtectedSnapshot(
      this.paths.githubTokenPath,
      this.options,
    )
    return {
      generation: snapshot.generation,
      value: snapshot.value?.trim() || null,
    }
  }

  async reserveGitHubTokenRevision(
    options?: CredentialRevisionReservationOptions,
  ): Promise<CredentialSnapshot<string>> {
    const snapshot = await reserveProtectedRevision(
      this.paths.githubTokenPath,
      this.options,
      options,
    )
    return {
      generation: snapshot.generation,
      value: snapshot.value?.trim() || null,
    }
  }

  async readGitHubToken(): Promise<string | null> {
    return (await this.readGitHubTokenSnapshot()).value
  }

  async writeGitHubToken(
    token: string,
    options?: CredentialWriteOptions,
  ): Promise<CredentialWriteResult> {
    return await writeProtectedFile(
      this.paths.githubTokenPath,
      token.trim(),
      options,
      this.options,
    )
  }

  async clearGitHubToken(
    options?: CredentialWriteOptions,
  ): Promise<CredentialWriteResult> {
    return await writeProtectedFile(
      this.paths.githubTokenPath,
      "",
      options,
      this.options,
    )
  }

  async readCodexCredentialSnapshot(): Promise<CodexCredentialSnapshot> {
    return parseCodexSnapshot(
      await readProtectedSnapshot(this.paths.codexCredentialPath, this.options),
      this.paths.codexCredentialPath,
    )
  }

  async reserveCodexCredentialRevision(
    options?: CredentialRevisionReservationOptions,
  ): Promise<CredentialWriteResult> {
    const snapshot = await reserveProtectedRevision(
      this.paths.codexCredentialPath,
      this.options,
      options,
    )
    return { generation: snapshot.generation }
  }

  async readCodexCredentials(): Promise<CodexCredentials | null> {
    return (await this.readCodexCredentialSnapshot()).credentials
  }

  async writeCodexCredentials(
    credentials: CodexCredentials,
    options?: CredentialWriteOptions,
  ): Promise<CredentialWriteResult> {
    return await writeProtectedFile(
      this.paths.codexCredentialPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      options,
      this.options,
    )
  }

  async clearCodexCredentials(
    options?: CredentialWriteOptions,
  ): Promise<CredentialWriteResult> {
    return await writeProtectedFile(
      this.paths.codexCredentialPath,
      "",
      options,
      this.options,
    )
  }

  async hasCodexCredentials(): Promise<boolean> {
    return (await this.readCodexCredentials()) !== null
  }
}

const defaultCredentialStore = new CredentialStore({
  codexCredentialPath: PATHS.CODEX_CREDENTIAL_PATH,
  githubTokenPath: PATHS.GITHUB_TOKEN_PATH,
})

export const readGitHubToken = () => defaultCredentialStore.readGitHubToken()
export const readGitHubTokenSnapshot = () =>
  defaultCredentialStore.readGitHubTokenSnapshot()
export const reserveGitHubTokenRevision = (
  options?: CredentialRevisionReservationOptions,
) => defaultCredentialStore.reserveGitHubTokenRevision(options)
export const writeGitHubToken = (
  token: string,
  options?: CredentialWriteOptions,
) => defaultCredentialStore.writeGitHubToken(token, options)
export const clearGitHubToken = (options?: CredentialWriteOptions) =>
  defaultCredentialStore.clearGitHubToken(options)
export const readCodexCredentials = () =>
  defaultCredentialStore.readCodexCredentials()
export const readCodexCredentialSnapshot = () =>
  defaultCredentialStore.readCodexCredentialSnapshot()
export const reserveCodexCredentialRevision = (
  options?: CredentialRevisionReservationOptions,
) => defaultCredentialStore.reserveCodexCredentialRevision(options)
export const writeCodexCredentials = (
  credentials: CodexCredentials,
  options?: CredentialWriteOptions,
) => defaultCredentialStore.writeCodexCredentials(credentials, options)
export const clearCodexCredentials = (options?: CredentialWriteOptions) =>
  defaultCredentialStore.clearCodexCredentials(options)
export const hasCodexCredentials = () =>
  defaultCredentialStore.hasCodexCredentials()
