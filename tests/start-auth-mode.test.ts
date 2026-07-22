import { describe, expect, test } from "bun:test"

import {
  assertProviderSetupAllowed,
  launchStartupAuthentication,
  parseDesktopStartupAuthMode,
  resolveStartupAuthentication,
  selectStartupAuthentication,
} from "../src/lib/start-auth-mode"

describe("server startup authentication mode", () => {
  test("Copilot Desktop startup reads the current protected credential", () => {
    expect(
      selectStartupAuthentication({
        desktopAuthMode: "copilot",
        enabledProviderCount: 2,
        explicitGitHubToken: undefined,
        storedGitHubToken: "current-file-token",
      }),
    ).toEqual({ githubToken: "current-file-token", kind: "copilot" })
  })

  test("provider-only Desktop startup ignores GitHub credentials", () => {
    expect(
      selectStartupAuthentication({
        desktopAuthMode: "provider",
        enabledProviderCount: 1,
        explicitGitHubToken: undefined,
        storedGitHubToken: "must-not-be-used",
      }),
    ).toEqual({ allowInteractiveSetup: false, kind: "provider" })
  })

  test("Desktop modes fail closed when their selected credential is missing", () => {
    expect(() =>
      selectStartupAuthentication({
        desktopAuthMode: "copilot",
        enabledProviderCount: 1,
        explicitGitHubToken: undefined,
        storedGitHubToken: null,
      }),
    ).toThrow("GitHub credential is unavailable")
    expect(() =>
      selectStartupAuthentication({
        desktopAuthMode: "provider",
        enabledProviderCount: 0,
        explicitGitHubToken: undefined,
        storedGitHubToken: "ignored-token",
      }),
    ).toThrow("No enabled provider is available")
  })

  test("ordinary CLI startup keeps its interactive provider fallback", () => {
    expect(
      selectStartupAuthentication({
        desktopAuthMode: undefined,
        enabledProviderCount: 0,
        explicitGitHubToken: undefined,
        storedGitHubToken: null,
      }),
    ).toEqual({ allowInteractiveSetup: true, kind: "provider" })
  })

  test("parses the private Desktop mode and rejects any other value", () => {
    expect(parseDesktopStartupAuthMode(undefined)).toBeUndefined()
    expect(parseDesktopStartupAuthMode("copilot")).toBe("copilot")
    expect(parseDesktopStartupAuthMode("provider")).toBe("provider")
    expect(() => parseDesktopStartupAuthMode("auto")).toThrow(
      "--desktop-auth-mode must be copilot or provider",
    )
  })

  test("resolves stored credentials only when the selected mode can use them", async () => {
    let reads = 0
    const readStoredGitHubToken = () => {
      reads += 1
      return Promise.resolve("stored-token")
    }
    expect(
      await resolveStartupAuthentication({
        desktopAuthMode: "copilot",
        enabledProviderCount: 0,
        explicitGitHubToken: undefined,
        readStoredGitHubToken,
      }),
    ).toEqual({ githubToken: "stored-token", kind: "copilot" })
    expect(
      await resolveStartupAuthentication({
        desktopAuthMode: "provider",
        enabledProviderCount: 1,
        explicitGitHubToken: undefined,
        readStoredGitHubToken,
      }),
    ).toEqual({ allowInteractiveSetup: false, kind: "provider" })
    expect(reads).toBe(1)
  })

  test("an explicit CLI credential bypasses protected-store reads", async () => {
    let reads = 0
    const authentication = await resolveStartupAuthentication({
      desktopAuthMode: undefined,
      enabledProviderCount: 0,
      explicitGitHubToken: " explicit-token ",
      readStoredGitHubToken: () => {
        reads += 1
        return Promise.reject(new Error("stored read must not run"))
      },
    })
    expect(authentication).toEqual({
      githubToken: "explicit-token",
      kind: "copilot",
    })
    expect(reads).toBe(0)
  })

  test("launches exactly the selected startup adapter", async () => {
    const calls: string[] = []
    const handlers = {
      startCopilot: (token: string) => {
        calls.push(`copilot:${token}`)
        return Promise.resolve()
      },
      startProvider: (allowInteractiveSetup: boolean) => {
        calls.push(`provider:${allowInteractiveSetup}`)
        return Promise.resolve()
      },
    }
    await launchStartupAuthentication(
      { githubToken: "current-token", kind: "copilot" },
      handlers,
    )
    await launchStartupAuthentication(
      { allowInteractiveSetup: false, kind: "provider" },
      handlers,
    )
    expect(calls).toEqual(["copilot:current-token", "provider:false"])
  })

  test("provider-only mode is the only non-interactive missing-provider error", () => {
    expect(() => assertProviderSetupAllowed(false, 0)).toThrow(
      "No enabled provider is available",
    )
    expect(() => assertProviderSetupAllowed(false, 1)).not.toThrow()
    expect(() => assertProviderSetupAllowed(true, 0)).not.toThrow()
  })
})
