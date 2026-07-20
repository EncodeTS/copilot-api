import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

interface LockRecord {
  createdAtMs: number
  ownerToken: string
  pid: number
}

interface ObservedOwner {
  abandoned: boolean
  mtimeMs: number
  ownerDirectory: string
  ownerToken: string
  pid?: number
}

interface ObservedReclaimClaim {
  abandoned: boolean
  mtimeMs: number
  ownerDirectory?: string
  ownerToken?: string
  pid?: number
}

const abandonedOwnerDirectories = new Set<string>()
const abandonedReclaimDirectories = new Set<string>()

export interface CredentialFileLockOptions {
  afterReclaimClaimed?: () => Promise<void>
  afterReclaimOwnerCreated?: () => Promise<void>
  afterReclaimRename?: (tombstonePath: string) => Promise<void>
  afterOwnerCreated?: () => Promise<void>
  beforeReclaimRename?: () => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  now?: () => number
  onReclaimClaimLost?: () => Promise<void>
  releaseAttempts?: number
  releaseRetryMs?: number
  rename?: (source: string, destination: string) => Promise<void>
  retryMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  staleMs?: number
  timeoutMs?: number
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function parseLockRecord(raw: string, ownerToken: string): LockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    if (
      typeof parsed.createdAtMs !== "number"
      || !Number.isFinite(parsed.createdAtMs)
      || parsed.ownerToken !== ownerToken
      || typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
    ) {
      return null
    }
    return parsed as LockRecord
  } catch {
    return null
  }
}

function parseOwnerPid(ownerToken: string): number | undefined {
  const separator = ownerToken.indexOf("-")
  if (separator <= 0) return undefined
  const pid = Number(ownerToken.slice(0, separator))
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
  }
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory)
  } catch (error) {
    if (
      isNodeError(error)
      && (error.code === "ENOENT"
        || error.code === "ENOTEMPTY"
        || error.code === "EEXIST")
    ) {
      return
    }
    throw error
  }
}

async function writeOwnerRecord(
  ownerDirectory: string,
  ownerToken: string,
  createdAtMs: number,
  afterDirectoryCreated?: () => Promise<void>,
): Promise<void> {
  await fs.mkdir(ownerDirectory, { mode: 0o700 })
  await afterDirectoryCreated?.()
  const ownerFile = path.join(ownerDirectory, "owner.json")
  const handle = await fs.open(ownerFile, "wx", 0o600)
  try {
    const record: LockRecord = {
      createdAtMs,
      ownerToken,
      pid: process.pid,
    }
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function markOwnerDirectoryAbandoned(
  ownerDirectory: string,
  ownerToken: string,
  registry: Set<string>,
): Promise<void> {
  registry.add(ownerDirectory)
  const markerPath = path.join(ownerDirectory, "abandoned")
  try {
    const handle = await fs.open(markerPath, "wx", 0o600)
    try {
      await handle.writeFile(`${ownerToken}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (
      isNodeError(error)
      && (error.code === "EEXIST" || error.code === "ENOENT")
    ) {
      return
    }
    // The in-process registry still permits recovery. Other processes can
    // recover after this PID exits even if the marker itself could not persist.
  }
}

export class CredentialFileLockLease {
  private released = false
  private readonly lockPath: string
  private readonly ownerDirectory: string
  private readonly ownerToken: string
  private readonly releaseAttempts: number
  private readonly releaseRetryMs: number
  private readonly rename: (
    source: string,
    destination: string,
  ) => Promise<void>
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(
    lockPath: string,
    ownerToken: string,
    options: {
      releaseAttempts: number
      releaseRetryMs: number
      rename: (source: string, destination: string) => Promise<void>
      sleep: (milliseconds: number) => Promise<void>
    },
  ) {
    this.lockPath = lockPath
    this.ownerToken = ownerToken
    this.ownerDirectory = path.join(lockPath, ownerToken)
    this.releaseAttempts = options.releaseAttempts
    this.releaseRetryMs = options.releaseRetryMs
    this.rename = options.rename
    this.sleep = options.sleep
  }

  async release(): Promise<void> {
    if (this.released) return
    const tombstone = `${this.lockPath}.release-${this.ownerToken}-${randomUUID()}`
    for (let attempt = 0; attempt < this.releaseAttempts; attempt += 1) {
      try {
        // The source path contains this lease's unguessable owner token. If the
        // root was reclaimed and replaced, this rename cannot touch the new
        // owner's differently named child directory.
        await this.rename(this.ownerDirectory, tombstone)
        this.released = true
        abandonedOwnerDirectories.delete(this.ownerDirectory)
        await removeDirectoryIfEmpty(this.lockPath)
        await fs.rm(tombstone, { force: true, recursive: true })
        return
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          this.released = true
          abandonedOwnerDirectories.delete(this.ownerDirectory)
          return
        }
        const retryable =
          isNodeError(error) && (error.code === "EPERM" || error.code === "EIO")
        if (!retryable) {
          await this.markAbandoned()
          throw error
        }
        if (attempt + 1 >= this.releaseAttempts) {
          await this.markAbandoned()
          throw error
        }
        await this.sleep(this.releaseRetryMs * (attempt + 1))
      }
    }
  }

  private async markAbandoned(): Promise<void> {
    await markOwnerDirectoryAbandoned(
      this.ownerDirectory,
      this.ownerToken,
      abandonedOwnerDirectories,
    )
  }
}

export class CredentialFileLock {
  readonly lockPath: string
  private readonly afterReclaimRename?: (tombstonePath: string) => Promise<void>
  private readonly afterReclaimClaimed?: () => Promise<void>
  private readonly afterReclaimOwnerCreated?: () => Promise<void>
  private readonly afterOwnerCreated?: () => Promise<void>
  private readonly beforeReclaimRename?: () => Promise<void>
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly now: () => number
  private readonly onReclaimClaimLost?: () => Promise<void>
  private readonly retryMs: number
  private readonly releaseAttempts: number
  private readonly releaseRetryMs: number
  private readonly rename: (
    source: string,
    destination: string,
  ) => Promise<void>
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly staleMs: number
  private readonly timeoutMs: number

  constructor(lockPath: string, options: CredentialFileLockOptions = {}) {
    this.lockPath = lockPath
    this.afterReclaimClaimed = options.afterReclaimClaimed
    this.afterReclaimOwnerCreated = options.afterReclaimOwnerCreated
    this.afterReclaimRename = options.afterReclaimRename
    this.afterOwnerCreated = options.afterOwnerCreated
    this.beforeReclaimRename = options.beforeReclaimRename
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
    this.now = options.now ?? Date.now
    this.onReclaimClaimLost = options.onReclaimClaimLost
    this.retryMs = options.retryMs ?? 10
    this.releaseAttempts = options.releaseAttempts ?? 3
    this.releaseRetryMs = options.releaseRetryMs ?? 10
    this.rename = options.rename ?? fs.rename
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds))
    this.staleMs = options.staleMs ?? 30_000
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  async acquire(signal?: AbortSignal): Promise<CredentialFileLockLease> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true })
    const deadlineMs = this.now() + this.timeoutMs

    while (this.now() < deadlineMs) {
      if (signal?.aborted) {
        const error = new Error("Credential lock acquisition was aborted")
        error.name = "AbortError"
        throw error
      }

      const ownerToken = `${process.pid}-${randomUUID()}`
      let rootCreated = false
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 })
        rootCreated = true
        const ownerDirectory = path.join(this.lockPath, ownerToken)
        await writeOwnerRecord(ownerDirectory, ownerToken, this.now())
        const lease = this.createLease(ownerToken)
        await this.afterOwnerCreated?.()
        if (signal?.aborted) {
          await lease.release()
          const error = new Error("Credential lock acquisition was aborted")
          error.name = "AbortError"
          throw error
        }
        return lease
      } catch (error) {
        if (rootCreated) {
          await this.createLease(ownerToken).release()
          await removeDirectoryIfEmpty(this.lockPath)
          throw error
        }
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
      }

      await this.reclaimIfStale()
      await this.sleep(this.retryMs)
    }

    throw new Error("Timed out waiting for credential file lock")
  }

  private createLease(ownerToken: string): CredentialFileLockLease {
    return new CredentialFileLockLease(this.lockPath, ownerToken, {
      releaseAttempts: this.releaseAttempts,
      releaseRetryMs: this.releaseRetryMs,
      rename: this.rename,
      sleep: this.sleep,
    })
  }

  private async observeOwners(): Promise<{
    lockMtimeMs: number
    owners: Array<ObservedOwner>
    reclaimClaim?: ObservedReclaimClaim
  } | null> {
    try {
      const [entries, lockStat] = await Promise.all([
        fs.readdir(this.lockPath, { withFileTypes: true }),
        fs.stat(this.lockPath),
      ])
      const owners: Array<ObservedOwner> = []
      let reclaimClaim: ObservedReclaimClaim | undefined
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === ".reclaim") {
          reclaimClaim = await this.observeReclaimClaim(
            path.join(this.lockPath, entry.name),
          )
          continue
        }
        const ownerToken = entry.name
        const ownerDirectory = path.join(this.lockPath, ownerToken)
        const stat = await fs.stat(ownerDirectory)
        const raw = await fs
          .readFile(path.join(ownerDirectory, "owner.json"), "utf8")
          .catch(() => "")
        const record = parseLockRecord(raw, ownerToken)
        owners.push({
          abandoned:
            abandonedOwnerDirectories.has(ownerDirectory)
            || (await fs.access(path.join(ownerDirectory, "abandoned")).then(
              () => true,
              () => false,
            )),
          mtimeMs: stat.mtimeMs,
          ownerDirectory,
          ownerToken,
          pid: record?.pid ?? parseOwnerPid(ownerToken),
        })
      }
      return { lockMtimeMs: lockStat.mtimeMs, owners, reclaimClaim }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }
  }

  private async observeReclaimClaim(
    reclaimDirectory: string,
  ): Promise<ObservedReclaimClaim> {
    const reclaimStat = await fs.stat(reclaimDirectory)
    const entries = await fs
      .readdir(reclaimDirectory, { withFileTypes: true })
      .catch(() => [])
    const ownerEntry = entries.find(
      (entry) =>
        entry.isDirectory() && entry.name !== "." && entry.name !== "..",
    )
    if (!ownerEntry) {
      return { abandoned: false, mtimeMs: reclaimStat.mtimeMs }
    }
    const ownerToken = ownerEntry.name
    const ownerDirectory = path.join(reclaimDirectory, ownerToken)
    const ownerStat = await fs.stat(ownerDirectory).catch(() => reclaimStat)
    const raw = await fs
      .readFile(path.join(ownerDirectory, "owner.json"), "utf8")
      .catch(() => "")
    const record = parseLockRecord(raw, ownerToken)
    return {
      abandoned:
        abandonedReclaimDirectories.has(ownerDirectory)
        || (await fs.access(path.join(ownerDirectory, "abandoned")).then(
          () => true,
          () => false,
        )),
      mtimeMs: Math.max(reclaimStat.mtimeMs, ownerStat.mtimeMs),
      ownerDirectory,
      ownerToken,
      pid: record?.pid ?? parseOwnerPid(ownerToken),
    }
  }

  private async reclaimIfStale(): Promise<void> {
    const observed = await this.observeOwners()
    if (!observed) return
    if (observed.reclaimClaim) {
      const removed = await this.removeStaleReclaimClaim(observed.reclaimClaim)
      if (!removed) return
      const afterRemoval = await this.observeOwners()
      if (!afterRemoval) return
      const liveAfterRemoval = afterRemoval.owners.find(
        (owner) =>
          !owner.abandoned
          && owner.pid !== undefined
          && this.isProcessAlive(owner.pid),
      )
      if (liveAfterRemoval) return
      await this.reclaimCorruptRoot()
      return
    }

    const liveOwner = observed.owners.find(
      (owner) =>
        !owner.abandoned
        && owner.pid !== undefined
        && this.isProcessAlive(owner.pid),
    )
    if (liveOwner) return

    if (observed.owners.length === 1 && observed.owners[0].abandoned) {
      await this.reclaimOwnerDirectory(observed.owners[0])
      return
    }

    const newestMtime = Math.max(
      observed.lockMtimeMs,
      ...observed.owners.map((owner) => owner.mtimeMs),
    )
    if (this.now() - newestMtime <= this.staleMs) return

    if (observed.owners.length === 1) {
      await this.reclaimOwnerDirectory(observed.owners[0])
      return
    }

    await this.reclaimCorruptRoot()
  }

  private async removeStaleReclaimClaim(
    claim: ObservedReclaimClaim,
  ): Promise<boolean> {
    if (
      !claim.abandoned
      && claim.pid !== undefined
      && this.isProcessAlive(claim.pid)
    ) {
      return false
    }
    if (!claim.abandoned && this.now() - claim.mtimeMs <= this.staleMs) {
      return false
    }
    const reclaimDirectory = path.join(this.lockPath, ".reclaim")
    const tombstone = `${this.lockPath}.stale-reclaim-${randomUUID()}`
    try {
      await this.rename(reclaimDirectory, tombstone)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false
      throw error
    }
    if (claim.ownerDirectory) {
      abandonedReclaimDirectories.delete(claim.ownerDirectory)
    }
    await fs.rm(tombstone, { force: true, recursive: true })
    return true
  }

  private async reclaimCorruptRoot(): Promise<void> {
    const reclaimDirectory = path.join(this.lockPath, ".reclaim")
    const ownerToken = `${process.pid}-${randomUUID()}`
    await this.beforeReclaimRename?.()
    try {
      // Fixed-name mkdir is the atomic reaper election. While it exists, the
      // old root cannot be removed or replaced, so delayed reapers can never
      // operate on a third acquirer's new root.
      await fs.mkdir(reclaimDirectory, { mode: 0o700 })
    } catch (error) {
      if (
        isNodeError(error)
        && (error.code === "EEXIST" || error.code === "ENOENT")
      ) {
        if (error.code === "EEXIST") await this.onReclaimClaimLost?.()
        return
      }
      throw error
    }

    try {
      await writeOwnerRecord(
        path.join(reclaimDirectory, ownerToken),
        ownerToken,
        this.now(),
        this.afterReclaimOwnerCreated,
      )
      await this.afterReclaimClaimed?.()
    } catch (error) {
      await this.abandonIncompleteReclaimClaim(ownerToken)
      if (isNodeError(error) && error.code === "ENOENT") return
      throw error
    }

    if (!(await this.ownsReclaimClaim(ownerToken))) return

    const tombstone = `${this.lockPath}.stale-root-${randomUUID()}`
    try {
      // Only the process that created .reclaim can move the old root. Delayed
      // reapers failed that O_EXCL claim and therefore can never rename a new
      // root created at the same path after this atomic move.
      await this.rename(this.lockPath, tombstone)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return
      await this.releaseReclaimClaim(ownerToken)
      throw error
    }
    abandonedReclaimDirectories.delete(path.join(reclaimDirectory, ownerToken))
    await this.afterReclaimRename?.(tombstone)
    await fs.rm(tombstone, { force: true, recursive: true })
  }

  private async ownsReclaimClaim(ownerToken: string): Promise<boolean> {
    const raw = await fs
      .readFile(
        path.join(this.lockPath, ".reclaim", ownerToken, "owner.json"),
        "utf8",
      )
      .catch(() => "")
    const record = parseLockRecord(raw, ownerToken)
    return record?.pid === process.pid
  }

  private async releaseReclaimClaim(ownerToken: string): Promise<void> {
    if (!(await this.ownsReclaimClaim(ownerToken))) return
    const reclaimDirectory = path.join(this.lockPath, ".reclaim")
    const tombstone = `${this.lockPath}.reclaim-release-${ownerToken}-${randomUUID()}`
    try {
      await this.rename(reclaimDirectory, tombstone)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return
      await this.abandonIncompleteReclaimClaim(ownerToken)
      return
    }
    abandonedReclaimDirectories.delete(path.join(reclaimDirectory, ownerToken))
    await fs
      .rm(tombstone, { force: true, recursive: true })
      .catch(() => undefined)
  }

  private async abandonIncompleteReclaimClaim(
    ownerToken: string,
  ): Promise<void> {
    const reclaimDirectory = path.join(this.lockPath, ".reclaim")
    const ownerDirectory = path.join(reclaimDirectory, ownerToken)
    const ownerExists = await fs.access(ownerDirectory).then(
      () => true,
      () => false,
    )
    if (ownerExists) {
      await markOwnerDirectoryAbandoned(
        ownerDirectory,
        ownerToken,
        abandonedReclaimDirectories,
      )
      return
    }
    await removeDirectoryIfEmpty(reclaimDirectory)
  }

  private async reclaimOwnerDirectory(owner: ObservedOwner): Promise<void> {
    const tombstone = `${this.lockPath}.stale-owner-${owner.ownerToken}-${randomUUID()}`
    await this.beforeReclaimRename?.()
    try {
      await this.rename(owner.ownerDirectory, tombstone)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return
      throw error
    }
    abandonedOwnerDirectories.delete(owner.ownerDirectory)
    await removeDirectoryIfEmpty(this.lockPath)
    await this.afterReclaimRename?.(tombstone)
    await fs.rm(tombstone, { force: true, recursive: true })
  }
}
