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
        readStoredGitHubToken: () => Promise.resolve("stored-token"),
        startCopilot,
        startProvider,
      },
    )

    expect(startCopilot).toHaveBeenCalledWith(
      "stored-token",
      false,
      "http://localhost:4510",
      false,
    )
    expect(startProvider).not.toHaveBeenCalled()
  })

  test("dispatches provider-only without reading a GitHub credential", async () => {
    const readStoredGitHubToken = mock(() => Promise.resolve("must-not-read"))
    const startCopilot = mock(() => Promise.resolve())
    const startProvider = mock(() => Promise.resolve())

    await startSelectedAuthentication(
      { claudeCode: true, desktopAuthMode: "provider" },
      "http://localhost:4511",
      1,
      { readStoredGitHubToken, startCopilot, startProvider },
    )

    expect(readStoredGitHubToken).not.toHaveBeenCalled()
    expect(startCopilot).not.toHaveBeenCalled()
    expect(startProvider).toHaveBeenCalledWith(
      "http://localhost:4511",
      true,
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
