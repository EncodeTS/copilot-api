import { describe, expect, test } from "bun:test"

import { AuthProtocolError, AuthRequestError } from "../src/lib/auth-request"
import type { DeviceCodeResponse } from "../src/services/github/get-device-code"
import { pollAccessToken } from "../src/services/github/poll-access-token"

const deviceCode: DeviceCodeResponse = {
  device_code: "device-secret",
  expires_in: 30,
  interval: 1,
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
}

describe("GitHub device flow", () => {
  test("handles pending and slow_down states before returning the token", async () => {
    let now = 1_000
    const sleeps: Array<number> = []
    const responses = [
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "github-access-token" },
    ]

    const token = await pollAccessToken(deviceCode, {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(responses.shift()), { status: 200 }),
        ),
      now: () => now,
      random: () => 0.5,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        return Promise.resolve()
      },
    })

    expect(token).toBe("github-access-token")
    expect(sleeps).toEqual([1_000, 6_000])
  })

  test("retries transient network and HTTP failures within the device lifetime", async () => {
    let now = 1_000
    let attempt = 0
    const sleeps: Array<number> = []

    const token = await pollAccessToken(deviceCode, {
      fetch: () => {
        attempt += 1
        if (attempt === 1) {
          return Promise.reject(new Error("network unavailable"))
        }
        if (attempt === 2) {
          return Promise.resolve(new Response(null, { status: 503 }))
        }
        return Promise.resolve(
          Response.json({ access_token: "github-access-token" }),
        )
      },
      now: () => now,
      random: () => 0.5,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        return Promise.resolve()
      },
    })

    expect(token).toBe("github-access-token")
    expect(sleeps).toEqual([1_100, 2_200])
  })

  test("bounds exponential transient backoff including injected jitter", async () => {
    let now = 1_000
    let attempt = 0
    const sleeps: Array<number> = []

    const token = await pollAccessToken(
      { ...deviceCode, expires_in: 1_000 },
      {
        fetch: () => {
          attempt += 1
          return Promise.resolve(
            attempt <= 7 ?
              new Response(null, { status: 503 })
            : Response.json({ access_token: "github-access-token" }),
          )
        },
        now: () => now,
        random: () => 1,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds)
          now += milliseconds
          return Promise.resolve()
        },
      },
    )

    expect(token).toBe("github-access-token")
    expect(sleeps).toEqual([1_200, 2_400, 4_800, 9_600, 19_200, 30_000, 30_000])
    expect(Math.max(...sleeps)).toBe(30_000)
  })

  test("retries an HTTP 200 temporarily_unavailable OAuth payload", async () => {
    let now = 1_000
    let attempt = 0
    const sleeps: Array<number> = []

    const token = await pollAccessToken(deviceCode, {
      fetch: () => {
        attempt += 1
        return Promise.resolve(
          attempt === 1 ?
            Response.json({ error: "temporarily_unavailable" })
          : Response.json({ access_token: "github-access-token" }),
        )
      },
      now: () => now,
      random: () => 0,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
        return Promise.resolve()
      },
    })

    expect(token).toBe("github-access-token")
    expect(sleeps).toEqual([1_000])
  })

  test("rejects a malformed successful device response without echoing it", async () => {
    const secret = "unexpected-secret"
    const error: unknown = await pollAccessToken(deviceCode, {
      fetch: () => Promise.resolve(Response.json({ unexpected: secret })),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthProtocolError)
    expect(String(error)).not.toContain(secret)
  })

  test("stops permanently when the user denies authorization", async () => {
    const error = await pollAccessToken(deviceCode, {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "access_denied" }), {
            status: 200,
          }),
        ),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(error).toMatchObject({
      kind: "permanent",
      oauthCode: "access_denied",
    })
  })

  test("expires after the server-provided device-code lifetime", async () => {
    let now = 5_000
    const error = await pollAccessToken(
      { ...deviceCode, expires_in: 1 },
      {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "authorization_pending" }), {
              status: 200,
            }),
          ),
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds
          return Promise.resolve()
        },
      },
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthRequestError)
    expect(error).toMatchObject({
      kind: "permanent",
      oauthCode: "expired_token",
    })
  })

  test("caller abort cancels an in-flight device poll", async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const request = pollAccessToken(deviceCode, {
      fetch: (_input, init) => {
        requestSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          )
        })
      },
      signal: controller.signal,
    })

    controller.abort()

    const error: unknown = await request.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: "aborted" })
    expect(requestSignal?.aborted).toBe(true)
  })

  test("caller abort cancels the wait between device polls", async () => {
    const controller = new AbortController()
    let sleepSignal: AbortSignal | undefined
    const request = pollAccessToken(deviceCode, {
      fetch: () =>
        Promise.resolve(Response.json({ error: "authorization_pending" })),
      signal: controller.signal,
      sleep: (_milliseconds, signal) => {
        sleepSignal = signal
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("sleep aborted")),
            { once: true },
          )
        })
      },
    })
    for (let attempt = 0; attempt < 100 && !sleepSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(sleepSignal).toBeDefined()
    controller.abort()

    const error: unknown = await request.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ kind: "aborted" })
    expect(sleepSignal?.aborted).toBe(true)
  })
})
