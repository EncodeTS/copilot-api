import { state } from "~/lib/state"

export interface CodexCredentialSnapshot {
  accessToken: string
  accountId: string
  credentialRevision: number
}

const getCredentialRevision = (): number => {
  const revision = state.codexCredentialRevision
  return (
      typeof revision === "number"
        && Number.isSafeInteger(revision)
        && revision >= 0
    ) ?
      revision
    : 0
}

export const captureCodexCredentialSnapshot = (): CodexCredentialSnapshot => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revisionBefore = getCredentialRevision()
    const accessToken = state.codexAccessToken
    const accountId = state.codexAccountId?.trim()
    const revisionAfter = getCredentialRevision()
    if (revisionBefore !== revisionAfter) {
      continue
    }
    if (!accessToken) {
      throw new Error("Codex access token is not loaded")
    }
    if (!accountId) {
      throw new Error("Codex account id is not loaded")
    }
    return Object.freeze({
      accessToken,
      accountId,
      credentialRevision: revisionAfter,
    })
  }
  throw new Error("Codex credentials changed while creating a snapshot")
}

const getStableAccountId = (credentials: CodexCredentialSnapshot): string => {
  const accountId = credentials.accountId.trim()
  if (!accountId) {
    throw new Error("Codex account id is not loaded")
  }
  return accountId
}

const getStableCredentialRevision = (
  credentials: CodexCredentialSnapshot,
): number => {
  const revision = credentials.credentialRevision
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Codex credential revision is invalid")
  }
  return revision
}

export const getCodexCredentialScopeKey = (
  credentials: CodexCredentialSnapshot,
): string =>
  JSON.stringify([
    getStableAccountId(credentials),
    getStableCredentialRevision(credentials),
  ])

export const getCodexCredentialAccountKey = (
  credentials: CodexCredentialSnapshot,
): string => JSON.stringify([getStableAccountId(credentials)])
