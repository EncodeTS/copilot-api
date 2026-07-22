import type { CodexProviderCatalogSnapshot } from "./provider-catalog-types"

export interface CodexCatalogRefresh {
  expiresAt: number
  generation: number
  promise: Promise<CodexProviderCatalogSnapshot>
  retired: boolean
}

export interface CodexCatalogLastKnownGood {
  credentialRevision: number
  expiresAt: number
  generation: number
  snapshot: CodexProviderCatalogSnapshot
}

interface CodexCatalogAccountEntry {
  lastKnownGood?: CodexCatalogLastKnownGood
  latestCredentialRevision?: number
  refresh?: CodexCatalogRefresh
  refreshKey?: string
  refreshRevision?: number
}

export class CodexProviderCatalogStore {
  readonly #accounts = new Map<string, CodexCatalogAccountEntry>()
  readonly #maxAccounts: number

  constructor(maxEntries: number) {
    this.#maxAccounts =
      Number.isFinite(maxEntries) && maxEntries > 0 ?
        Math.max(1, Math.floor(maxEntries))
      : 1
  }

  getLatestCredentialRevision(accountKey: string): number | undefined {
    const account = this.#accounts.get(accountKey)
    if (!account) return undefined
    this.#touch(accountKey, account)
    return account.latestCredentialRevision
  }

  getCachedRefresh(
    accountKey: string,
    refreshKey: string,
    credentialRevision: number,
    currentTime: number,
  ): CodexCatalogRefresh | undefined {
    const current = this.getCurrentRefresh(accountKey, currentTime)
    if (
      !current
      || current.refreshKey !== refreshKey
      || current.credentialRevision !== credentialRevision
    ) {
      return undefined
    }
    return current.refresh
  }

  getCurrentRefresh(
    accountKey: string,
    currentTime: number,
  ):
    | {
        credentialRevision: number
        refresh: CodexCatalogRefresh
        refreshKey: string
      }
    | undefined {
    const account = this.#accounts.get(accountKey)
    const { refresh, refreshKey, refreshRevision } = account ?? {}
    if (
      !account
      || !refresh
      || refreshKey === undefined
      || refreshRevision === undefined
    ) {
      return undefined
    }
    this.#touch(accountKey, account)
    if (refresh.expiresAt <= currentTime) {
      refresh.retired = true
      delete account.refresh
      delete account.refreshKey
      delete account.refreshRevision
      return undefined
    }
    return {
      credentialRevision: refreshRevision,
      refresh,
      refreshKey,
    }
  }

  setRefresh(
    accountKey: string,
    refreshKey: string,
    credentialRevision: number,
    refresh: CodexCatalogRefresh,
  ): boolean {
    const account = this.#getOrCreate(accountKey)
    if (
      account.latestCredentialRevision !== undefined
      && credentialRevision < account.latestCredentialRevision
    ) {
      refresh.retired = true
      return false
    }
    if (account.refresh && account.refresh !== refresh) {
      account.refresh.retired = true
    }
    account.latestCredentialRevision = credentialRevision
    account.refresh = refresh
    account.refreshKey = refreshKey
    account.refreshRevision = credentialRevision
    this.#touch(accountKey, account)
    return true
  }

  commitLastKnownGood(
    accountKey: string,
    refreshKey: string,
    credentialRevision: number,
    refresh: CodexCatalogRefresh,
    lastKnownGood: CodexCatalogLastKnownGood,
  ): void {
    const account = this.#accounts.get(accountKey)
    if (
      !account
      || refresh.retired
      || account.latestCredentialRevision !== credentialRevision
      || account.refresh !== refresh
      || account.refreshKey !== refreshKey
      || account.refreshRevision !== credentialRevision
      || (account.lastKnownGood
        && (account.lastKnownGood.credentialRevision > credentialRevision
          || (account.lastKnownGood.credentialRevision === credentialRevision
            && account.lastKnownGood.generation > lastKnownGood.generation)))
    ) {
      return
    }
    account.lastKnownGood = lastKnownGood
    this.#touch(accountKey, account)
  }

  getLastKnownGood(
    accountKey: string,
    currentTime: number,
  ): CodexCatalogLastKnownGood | undefined {
    const account = this.#accounts.get(accountKey)
    const lastKnownGood = account?.lastKnownGood
    if (!account || !lastKnownGood) {
      return undefined
    }
    this.#touch(accountKey, account)
    if (lastKnownGood.expiresAt <= currentTime) {
      delete account.lastKnownGood
      return undefined
    }
    return lastKnownGood
  }

  clear(): void {
    for (const account of this.#accounts.values()) {
      if (account.refresh) {
        account.refresh.retired = true
      }
    }
    this.#accounts.clear()
  }

  #getOrCreate(accountKey: string): CodexCatalogAccountEntry {
    const existing = this.#accounts.get(accountKey)
    if (existing) {
      return existing
    }

    const account: CodexCatalogAccountEntry = {}
    this.#accounts.set(accountKey, account)
    while (this.#accounts.size > this.#maxAccounts) {
      const oldestAccountKey = this.#accounts.keys().next().value
      if (typeof oldestAccountKey !== "string") {
        break
      }
      const evicted = this.#accounts.get(oldestAccountKey)
      if (evicted?.refresh) {
        evicted.refresh.retired = true
      }
      this.#accounts.delete(oldestAccountKey)
    }
    return account
  }

  #touch(accountKey: string, account: CodexCatalogAccountEntry): void {
    this.#accounts.delete(accountKey)
    this.#accounts.set(accountKey, account)
  }
}
