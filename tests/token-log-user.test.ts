import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { copilotBaseUrl } from "~/lib/api-config"
import { state } from "~/lib/state"
import { logUser, tokenUserDependencies } from "~/lib/token"
import { usageRoute } from "~/routes/usage/route"
import {
  copilotUsageFetchDependencies,
  resetCopilotUsageCacheForTests,
} from "~/services/github/get-copilot-usage"

const originalTokenUserDependencies = { ...tokenUserDependencies }
const originalUsageDependencies = { ...copilotUsageFetchDependencies }
const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotUsageScope: state.copilotUsageScope,
  githubToken: state.githubToken,
  tokenBasedBilling: state.tokenBasedBilling,
  userName: state.userName,
}

beforeEach(() => {
  Object.assign(tokenUserDependencies, originalTokenUserDependencies)
  Object.assign(copilotUsageFetchDependencies, originalUsageDependencies)
  resetCopilotUsageCacheForTests()
  state.githubToken = "credential-a"
  state.copilotApiUrl = undefined
  state.copilotUsageScope = undefined
  state.accountType = "individual"
  state.tokenBasedBilling = undefined
  state.userName = undefined
})

afterEach(() => {
  Object.assign(tokenUserDependencies, originalTokenUserDependencies)
  Object.assign(copilotUsageFetchDependencies, originalUsageDependencies)
  resetCopilotUsageCacheForTests()
  Object.assign(state, originalState)
})

describe("logUser usage enrichment", () => {
  test("successful enrichment sets the critical Copilot API endpoint before returning", async () => {
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        Response.json({
          copilot_plan: "enterprise",
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            telemetry: "https://telemetry.example.invalid",
          },
          login: "account-a",
          quota_snapshots: {},
          token_based_billing: true,
        }),
      )

    await logUser()

    expect(state.copilotApiUrl).toBe("https://api.enterprise.githubcopilot.com")
    expect(state.accountType).toBe("enterprise")
    expect(state.copilotUsageScope).toBeString()
    expect(state.tokenBasedBilling).toBe(true)
  })

  test("a permanently pending usage endpoint times out without failing startup identity", async () => {
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.requestTimeoutMs = 10
    tokenUserDependencies.criticalUsageTimeoutMs = 10
    copilotUsageFetchDependencies.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("usage fetch aborted"),
            ),
          { once: true },
        )
      })

    await logUser()

    expect(state.userName).toBe("account-a")
    expect(state.copilotApiUrl).toBeUndefined()
    expect(state.tokenBasedBilling).toBeUndefined()
  })

  test("credential change clears the prior account endpoint before a failed refresh", async () => {
    state.accountType = "enterprise"
    state.copilotApiUrl = "https://api.enterprise.githubcopilot.com"
    state.copilotUsageScope = "old-credential-scope"
    state.tokenBasedBilling = true
    tokenUserDependencies.criticalUsageTimeoutMs = 10
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    let stateObservedAtFetch: {
      accountType: string
      copilotApiUrl: string | undefined
      tokenBasedBilling: boolean | undefined
    } = {
      accountType: "not-called",
      copilotApiUrl: undefined,
      tokenBasedBilling: undefined,
    }
    copilotUsageFetchDependencies.fetch = (_input, init) => {
      stateObservedAtFetch = {
        accountType: state.accountType,
        copilotApiUrl: state.copilotApiUrl,
        tokenBasedBilling: state.tokenBasedBilling,
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("usage fetch aborted")),
          { once: true },
        )
      })
    }

    await logUser()

    expect(stateObservedAtFetch).toEqual({
      accountType: "individual",
      copilotApiUrl: undefined,
      tokenBasedBilling: undefined,
    })
    expect(state.copilotApiUrl).toBeUndefined()
    expect(state.tokenBasedBilling).toBeUndefined()
    expect(copilotBaseUrl(state)).toBe("https://api.githubcopilot.com")
  })

  test("authorization failure invalidates the current credential endpoint", async () => {
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        Response.json({
          copilot_plan: "enterprise",
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            telemetry: "https://telemetry.example.invalid",
          },
          login: "account-a",
        }),
      )
    await logUser()
    expect(state.copilotApiUrl).toBe("https://api.enterprise.githubcopilot.com")

    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(new Response(null, { status: 401 }))
    await logUser()

    expect(state.accountType).toBe("individual")
    expect(state.copilotApiUrl).toBeUndefined()
    expect(state.tokenBasedBilling).toBeUndefined()
  })

  test("account identity change invalidates same-token LKG before enrichment", async () => {
    let login = "old-account"
    let validUsage = true
    tokenUserDependencies.getGitHubUser = () => Promise.resolve({ login })
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        validUsage ?
          Response.json({
            copilot_plan: "enterprise",
            endpoints: {
              api: "https://api.enterprise.githubcopilot.com",
              telemetry: "https://telemetry.example.invalid",
            },
            login,
          })
        : Response.json({ error: { message: "wrong account cache" } }),
      )
    await logUser()
    expect(state.copilotApiUrl).toBe("https://api.enterprise.githubcopilot.com")

    login = "new-account"
    validUsage = false
    await logUser()

    expect(state.accountType).toBe("individual")
    expect(state.copilotApiUrl).toBeUndefined()
  })

  test("usage login mismatch cannot install another account endpoint", async () => {
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    copilotUsageFetchDependencies.fetch = () =>
      Promise.resolve(
        Response.json({
          copilot_plan: "enterprise",
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            telemetry: "https://telemetry.example.invalid",
          },
          login: "account-b",
        }),
      )

    await logUser()

    expect(state.accountType).toBe("individual")
    expect(state.copilotApiUrl).toBeUndefined()
    expect(copilotBaseUrl(state)).toBe("https://api.githubcopilot.com")
  })

  test("startup and normal usage refresh preserve their own contracts in either order", async () => {
    const app = new Hono().route("/usage", usageRoute)
    tokenUserDependencies.criticalUsageTimeoutMs = 10
    tokenUserDependencies.getGitHubUser = () =>
      Promise.resolve({ login: "account-a" })
    copilotUsageFetchDependencies.maxAttempts = 1
    copilotUsageFetchDependencies.requestTimeoutMs = 100

    for (const startupFirst of [true, false]) {
      resetCopilotUsageCacheForTests()
      state.accountType = "individual"
      state.copilotApiUrl = undefined
      state.copilotUsageScope = undefined
      state.tokenBasedBilling = undefined
      state.userName = "account-a"
      let requestCount = 0
      let normalRefreshResolved = false
      const startupCallIndex = startupFirst ? 1 : 2
      copilotUsageFetchDependencies.fetch = (_input, init) => {
        requestCount += 1
        const callIndex = requestCount
        if (callIndex === startupCallIndex) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("startup usage timeout")),
              { once: true },
            )
          })
        }
        return new Promise<Response>((resolve, reject) => {
          const timeout = setTimeout(() => {
            normalRefreshResolved = true
            resolve(
              Response.json({
                endpoints: {
                  api: "https://api.githubcopilot.com",
                  telemetry: "https://telemetry.example.invalid",
                },
                login: "account-a",
              }),
            )
          }, 50)
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout)
              reject(new Error("normal usage timeout"))
            },
            { once: true },
          )
        })
      }

      let startupPromise: Promise<void>
      let routePromise: Promise<Response>
      if (startupFirst) {
        startupPromise = logUser()
        await Promise.resolve()
        routePromise = Promise.resolve(app.request("/usage"))
      } else {
        routePromise = Promise.resolve(app.request("/usage"))
        await Promise.resolve()
        startupPromise = logUser()
      }

      await startupPromise
      expect(normalRefreshResolved).toBe(false)
      const routeResponse = await routePromise
      expect(routeResponse.status).toBe(200)
      const routeBody = (await routeResponse.json()) as { login?: string }
      expect(routeBody.login).toBe("account-a")
      expect(requestCount).toBe(2)
    }
  })
})
