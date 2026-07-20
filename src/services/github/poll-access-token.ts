import { setTimeout as delay } from "node:timers/promises"

import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import {
  AuthProtocolError,
  AuthRequestError,
  AuthTransportError,
  DEFAULT_AUTH_REQUEST_TIMEOUT_MS,
  createAuthRequestError,
  fetchAuthJson,
  isRetryableAuthError,
  readOAuthErrorCode,
  requireAuthObject,
  type AuthRequestOptions,
} from "~/lib/auth-request"

import type { DeviceCodeResponse } from "./get-device-code"

interface PollAccessTokenOptions extends AuthRequestOptions {
  now?: () => number
  random?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

const MAX_TRANSIENT_BACKOFF_MS = 30_000
const TRANSIENT_JITTER_RATIO = 0.2

interface AccessTokenResponse {
  access_token?: unknown
  error?: unknown
}

function createDeviceFlowError(code: string): AuthRequestError {
  return createAuthRequestError({
    action: "GitHub device authorization",
    oauthCode: code,
    status: 400,
  })
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await delay(milliseconds, undefined, { signal })
}

async function waitForNextPoll(options: {
  deadlineMs: number
  intervalMs: number
  now: () => number
  signal?: AbortSignal
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}): Promise<void> {
  if (options.signal?.aborted) {
    throw new AuthTransportError("GitHub device flow was aborted", "aborted")
  }
  const remainingMs = options.deadlineMs - options.now()
  if (remainingMs <= 0) {
    throw createDeviceFlowError("expired_token")
  }

  try {
    await options.sleep(
      Math.min(options.intervalMs, remainingMs),
      options.signal,
    )
  } catch (error) {
    if (options.signal?.aborted) {
      throw new AuthTransportError("GitHub device flow was aborted", "aborted")
    }
    throw error
  }
  if (options.signal?.aborted) {
    throw new AuthTransportError("GitHub device flow was aborted", "aborted")
  }
}

function getTransientRetryDelay(
  intervalMs: number,
  failureCount: number,
  random: () => number,
): number {
  const capMs = Math.max(intervalMs, MAX_TRANSIENT_BACKOFF_MS)
  const exponentialMs = Math.min(
    capMs,
    intervalMs * 2 ** Math.min(failureCount, 30),
  )
  const randomValue = Math.min(1, Math.max(0, random()))
  const jitterMs = Math.floor(
    exponentialMs * TRANSIENT_JITTER_RATIO * randomValue,
  )
  return Math.min(capMs, exponentialMs + jitterMs)
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  options: PollAccessTokenOptions = {},
): Promise<string> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  const deadlineMs = now() + Math.max(0, deviceCode.expires_in) * 1000
  let intervalMs = Math.max(1, deviceCode.interval) * 1000
  let transientFailureCount = 0

  const waitForTransientFailure = async (): Promise<void> => {
    const retryDelayMs = getTransientRetryDelay(
      intervalMs,
      transientFailureCount,
      random,
    )
    transientFailureCount += 1
    await waitForNextPoll({
      deadlineMs,
      intervalMs: retryDelayMs,
      now,
      signal: options.signal,
      sleep,
    })
  }

  while (now() < deadlineMs) {
    let response: Awaited<ReturnType<typeof fetchAuthJson>>
    try {
      response = await fetchAuthJson(
        accessTokenUrl,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
        {
          ...options,
          action: "GitHub device-token request",
          timeoutMs: Math.min(
            options.timeoutMs ?? DEFAULT_AUTH_REQUEST_TIMEOUT_MS,
            Math.max(1, deadlineMs - now()),
          ),
        },
      )
    } catch (error) {
      if (!isRetryableAuthError(error)) {
        throw error
      }
      await waitForTransientFailure()
      continue
    }

    const oauthCode = readOAuthErrorCode(response.payload)
    if (!response.ok) {
      const error = createAuthRequestError({
        action: "GitHub device-token request",
        headers: response.headers,
        oauthCode,
        status: response.status,
      })
      if (!isRetryableAuthError(error)) {
        throw error
      }
      if (oauthCode === "slow_down") {
        intervalMs += 5_000
        transientFailureCount = 0
      } else if (oauthCode === "authorization_pending") {
        transientFailureCount = 0
      } else {
        await waitForTransientFailure()
        continue
      }
      await waitForNextPoll({
        deadlineMs,
        intervalMs,
        now,
        signal: options.signal,
        sleep,
      })
      continue
    }

    const payload = requireAuthObject(
      response,
      "GitHub device-token request",
    ) as AccessTokenResponse

    if (typeof payload.access_token === "string" && payload.access_token) {
      return payload.access_token
    }

    if (oauthCode === "access_denied" || oauthCode === "expired_token") {
      throw createDeviceFlowError(oauthCode)
    }
    if (oauthCode === "slow_down") {
      intervalMs += 5_000
      transientFailureCount = 0
    } else if (
      oauthCode === "server_error"
      || oauthCode === "temporarily_unavailable"
    ) {
      const error = createAuthRequestError({
        action: "GitHub device-token request",
        headers: response.headers,
        oauthCode,
        status: response.status,
      })
      if (!isRetryableAuthError(error)) throw error
      await waitForTransientFailure()
      continue
    } else if (oauthCode !== "authorization_pending") {
      throw new AuthProtocolError(
        "GitHub device-token response is missing required fields",
      )
    } else {
      transientFailureCount = 0
    }

    await waitForNextPoll({
      deadlineMs,
      intervalMs,
      now,
      signal: options.signal,
      sleep,
    })
  }

  throw createDeviceFlowError("expired_token")
}
