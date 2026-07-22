import { describe, expect, test } from "bun:test"

import { AuthProtocolError, AuthRequestError } from "../src/lib/auth-request"
import { getCopilotToken } from "../src/services/github/get-copilot-token"
import {
  getCopilotAccountType,
  getCopilotUsage,
} from "../src/services/github/get-copilot-usage"
import { getDeviceCode } from "../src/services/github/get-device-code"
import { getGitHubUser } from "../src/services/github/get-user"

describe("GitHub auth services", () => {
  test("all auth service requests receive a finite abort signal", async () => {
    const signals: Array<AbortSignal | null | undefined> = []

    const copilotToken = await getCopilotToken({
      fetch: (_input, init) => {
        signals.push(init?.signal)
        return Promise.resolve(
          Response.json({
            expires_at: 10_000,
            refresh_in: 1_800,
            token: "copilot-token",
          }),
        )
      },
    })
    const deviceCode = await getDeviceCode({
      fetch: (_input, init) => {
        signals.push(init?.signal)
        return Promise.resolve(
          Response.json({
            device_code: "device-code",
            expires_in: 900,
            interval: 5,
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
          }),
        )
      },
    })
    const user = await getGitHubUser("github-token", {
      fetch: (_input, init) => {
        signals.push(init?.signal)
        return Promise.resolve(Response.json({ login: "octocat" }))
      },
    })
    const usage = await getCopilotUsage("github-token", {
      fetch: (_input, init) => {
        signals.push(init?.signal)
        return Promise.resolve(
          Response.json({
            copilot_plan: "enterprise",
            endpoints: {
              api: "https://api.example",
              telemetry: "https://telemetry.example",
            },
            login: "octocat",
            quota_snapshots: {},
          }),
        )
      },
    })

    expect(copilotToken.token).toBe("copilot-token")
    expect(deviceCode.device_code).toBe("device-code")
    expect(user.login).toBe("octocat")
    expect(usage?.endpoints.api).toBe("https://api.example")
    expect(signals).toHaveLength(4)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })

  test("derives account type through the same bounded request seam", async () => {
    const accountType = await getCopilotAccountType("github-token", {
      fetch: () =>
        Promise.resolve(
          Response.json({
            copilot_plan: "Copilot Business",
            endpoints: {
              api: "https://api.example",
              telemetry: "https://telemetry.example",
            },
            login: "octocat",
            quota_snapshots: {},
          }),
        ),
    })

    expect(accountType).toBe("business")
  })

  test("does not stringify a malformed device response containing secrets", async () => {
    const secret = "device-secret-value"
    const error: unknown = await getDeviceCode({
      fetch: () => Promise.resolve(Response.json({ device_code: secret })),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthProtocolError)
    expect(String(error)).not.toContain(secret)
  })

  test("defaults an omitted device polling interval to five seconds", async () => {
    const deviceCode = await getDeviceCode({
      fetch: () =>
        Promise.resolve(
          Response.json({
            device_code: "device-code",
            expires_in: 900,
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
          }),
        ),
    })

    expect(deviceCode.interval).toBe(5)
  })

  test("keeps GitHub user and usage auth failures structured and redacted", async () => {
    const missingUserError: unknown = await getGitHubUser("").catch(
      (caught: unknown) => caught,
    )
    expect(missingUserError).toMatchObject({
      message: "GitHub token not found",
    })
    expect(await getCopilotUsage("")).toBeNull()

    const secret = "response-secret"
    const userError: unknown = await getGitHubUser("github-token", {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: secret }), {
            status: 401,
          }),
        ),
    }).catch((caught: unknown) => caught)
    const usageError: unknown = await getCopilotUsage("github-token-error", {
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    }).catch((caught: unknown) => caught)

    expect(userError).toBeInstanceOf(AuthRequestError)
    expect(String(userError)).not.toContain(secret)
    expect(usageError).toMatchObject({ kind: "retryable" })
  })

  test("rejects malformed successful Copilot token payloads safely", async () => {
    const secret = "partial-copilot-secret"
    const error: unknown = await getCopilotToken({
      fetch: () => Promise.resolve(Response.json({ token: secret })),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthProtocolError)
    expect(String(error)).not.toContain(secret)
  })

  test("classifies HTTP 200 OAuth error payloads before field validation", async () => {
    const copilotError: unknown = await getCopilotToken({
      fetch: () =>
        Promise.resolve(Response.json({ error: "temporarily_unavailable" })),
    }).catch((caught: unknown) => caught)
    const deviceError: unknown = await getDeviceCode({
      fetch: () => Promise.resolve(Response.json({ error: "server_error" })),
    }).catch((caught: unknown) => caught)

    expect(copilotError).toMatchObject({
      kind: "retryable",
      oauthCode: "temporarily_unavailable",
    })
    expect(deviceError).toMatchObject({
      kind: "retryable",
      oauthCode: "server_error",
    })
  })
})
