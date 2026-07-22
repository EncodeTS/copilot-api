import { setTimeout as delay } from "node:timers/promises"

import {
  AuthProtocolError,
  AuthRequestError,
  AuthTransportError,
} from "~/lib/auth-request"

const REFRESH_POLL_INTERVAL_MS = 15_000
export const EARLY_REFRESH_BUFFER_MS = 60_000
const RETRY_REFRESH_DELAY_MS = 15_000
const MAX_RETRY_REFRESH_DELAY_MS = 600_000
const RETRY_REFRESH_JITTER_MS = 15_000
const MIN_REFRESH_DELAY_MS = 1_000
const PERSIST_RETRY_BASE_MS = 250
const PERSIST_RETRY_MAX_MS = 2_000
const PERSIST_RETRY_JITTER_MS = 250
export const PERSIST_ATTEMPTS = 3

export async function defaultTokenSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(milliseconds, undefined, { signal })
}

function clampRandom(random: () => number): number {
  return Math.min(Math.max(random(), 0), 1)
}

export function getAuthRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(Math.floor(attempt), 0), 6)
  const base = Math.min(
    RETRY_REFRESH_DELAY_MS * 2 ** exponent,
    MAX_RETRY_REFRESH_DELAY_MS,
  )
  const jitter = Math.floor(clampRandom(random) * RETRY_REFRESH_JITTER_MS)
  return Math.min(base + jitter, MAX_RETRY_REFRESH_DELAY_MS)
}

export function getPersistenceRetryDelayMs(
  attempt: number,
  random: () => number,
): number {
  const base = Math.min(
    PERSIST_RETRY_BASE_MS * 2 ** Math.max(0, attempt),
    PERSIST_RETRY_MAX_MS,
  )
  const jitter = Math.floor(clampRandom(random) * PERSIST_RETRY_JITTER_MS)
  return Math.min(base + jitter, PERSIST_RETRY_MAX_MS)
}

export function isPermanentAuthError(error: unknown): boolean {
  return (
    (error instanceof AuthRequestError && error.kind === "permanent")
    || (error instanceof AuthProtocolError
      && error.retryDisposition === "permanent")
  )
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof AuthTransportError && error.kind === "aborted")
    || (error instanceof Error && error.name === "AbortError")
  )
}

export const getRefreshDeadlineMs = (
  refreshIn: number,
  nowMs: number = Date.now(),
) =>
  nowMs
  + Math.max(refreshIn * 1000 - EARLY_REFRESH_BUFFER_MS, MIN_REFRESH_DELAY_MS)

export const getRefreshPollDelayMs = (
  refreshAtMs: number,
  nowMs: number = Date.now(),
) => Math.min(Math.max(refreshAtMs - nowMs, 0), REFRESH_POLL_INTERVAL_MS)
