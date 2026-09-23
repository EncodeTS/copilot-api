import { describe, expect, mock, test } from "bun:test"

import {
  createRunServerOptions,
  setupProviderMode,
  startSelectedAuthentication,
} from "../src/start"

describe("start runtime Desktop authentication seam", () => {
  test("dispatches protected-file Copilot startup with explicit runtime context", async () => {
    const startCopilot = mock(() => Promise.resolve())
    const startProvider = mock(() => Promise.resolve())

    await startSelectedAuthentication(
      { claudeCode: false, desktopAuthMode: "copilot" },
      "http://localhost:4510",
      0,
      {
        readEnvironmentGitHubToken: () => undefined,
        readStoredGitHubToken: () => Promise.resolve("stored-token"),
        startCopilot,
        startProvider,
      },
    )

    expect(startCopilot).toHaveBeenCalledWith(
      "stored-token",
      "file",
      "http://localhost:4510",
      false,
    )
    expect(startProvider).not.toHaveBeenCalled()
  })

  test("dispatches provider-only without reading a GitHub credential", async () => {
    const readStoredGitHubToken = mock(() => Promise.resolve("must-not-read"))
    const readEnvironmentGitHubToken = mock(() => "inherited-token")
    const startCopilot = mock(() => Promise.resolve())
    const startProvider = mock(() => Promise.resolve())

    await startSelectedAuthentication(
      { claudeCode: true, desktopAuthMode: "provider" },
      "http://localhost:4511",
      1,
      {
        readEnvironmentGitHubToken,
        readStoredGitHubToken,
        startCopilot,
        startProvider,
      },
    )

    expect(readEnvironmentGitHubToken).not.toHaveBeenCalled()
    expect(readStoredGitHubToken).not.toHaveBeenCalled()
    expect(startCopilot).not.toHaveBeenCalled()
    expect(startProvider).toHaveBeenCalledWith(
      "http://localhost:4511",
      true,
      false,
    )
  })

  test("uses the environment source without reading a protected file", async () => {
    const startCopilot = mock(() => Promise.resolve())
    const readStoredGitHubToken = mock(() =>
      Promise.reject(new Error("should not read protected file")),
    )
    await startSelectedAuthentication(
      { claudeCode: false },
      "http://localhost:4512",
      0,
      {
        readEnvironmentGitHubToken: () => "from-env",
        readStoredGitHubToken,
        startCopilot,
        startProvider: mock(() => Promise.resolve()),
      },
    )
    expect(readStoredGitHubToken).not.toHaveBeenCalled()
    expect(startCopilot).toHaveBeenCalledWith(
      "from-env",
      "environment",
      "http://localhost:4512",
      false,
    )
  })

  test("explicit CLI token wins over inherited environment", async () => {
    const startCopilot = mock(() => Promise.resolve())
    await startSelectedAuthentication(
      { claudeCode: false, githubToken: "from-cli" },
      "http://localhost:4513",
      0,
      {
        readEnvironmentGitHubToken: () => "from-env",
        readStoredGitHubToken: () =>
          Promise.reject(new Error("should not read protected file")),
        startCopilot,
        startProvider: mock(() => Promise.resolve()),
      },
    )
    expect(startCopilot).toHaveBeenCalledWith(
      "from-cli",
      "cli",
      "http://localhost:4513",
      false,
    )
  })

  test("rechecks provider-only availability before interactive setup", async () => {
    const error = await setupProviderMode(
      "http://localhost:4511",
      false,
      false,
      () => [],
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      message: "No enabled provider is available for provider-only startup",
    })
  })

  test("maps private CLI auth mode into complete run options", () => {
    expect(
      createRunServerOptions({
        "claude-code": false,
        "desktop-auth-mode": "provider",
        "github-token": undefined,
        "proxy-env": true,
        "show-token": false,
        port: "4512",
        verbose: true,
      }),
    ).toEqual({
      claudeCode: false,
      desktopAuthMode: "provider",
      githubToken: undefined,
      port: 4512,
      proxyEnv: true,
      showToken: false,
      verbose: true,
    })
  })
})
