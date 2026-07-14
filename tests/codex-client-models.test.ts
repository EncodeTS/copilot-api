import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import {
  clearCodexCatalogCache,
  codexCatalogLoaderDependencies,
  codexClientModelsDependencies,
  createCodexModelsResponse,
  getCodexClientVersion,
  isCodexClientUserAgent,
  loadInstalledCodexCatalog,
  type CodexModelsResponse,
} from "../src/services/codex/client-models"
import type { Model } from "../src/services/copilot/get-models"

const originalGetExecutableCandidates =
  codexCatalogLoaderDependencies.getExecutableCandidates
const originalRunCommand = codexCatalogLoaderDependencies.runCommand
const originalLoadBundledCatalog =
  codexClientModelsDependencies.loadBundledCatalog

const bundledCatalogObject: CodexModelsResponse = {
  models: [
    {
      slug: "gpt-5.6-sol",
      base_instructions: "bundled instructions",
      context_window: 372_000,
    },
  ],
}
const bundledCatalog = JSON.stringify(bundledCatalogObject)

const createCopilotModel = (
  limits: Model["capabilities"]["limits"],
): Model => ({
  capabilities: {
    family: "gpt-5.6-sol",
    limits,
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-5.6-sol",
  model_picker_enabled: true,
  name: "GPT-5.6 Sol",
  object: "model",
  preview: false,
  supported_endpoints: ["/responses"],
  vendor: "openai",
  version: "test",
})

beforeEach(() => {
  clearCodexCatalogCache()
  codexCatalogLoaderDependencies.getExecutableCandidates = () => ["/mock/codex"]
})

afterEach(() => {
  codexCatalogLoaderDependencies.getExecutableCandidates =
    originalGetExecutableCandidates
  codexCatalogLoaderDependencies.runCommand = originalRunCommand
  codexClientModelsDependencies.loadBundledCatalog = originalLoadBundledCatalog
  clearCodexCatalogCache()
})

describe("Codex bundled model catalog", () => {
  test("loads and caches the catalog from an exact client version", async () => {
    const runCommand = mock((_executable: string, args: Array<string>) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : bundledCatalog,
      ),
    )
    codexCatalogLoaderDependencies.runCommand = runCommand

    const first = await loadInstalledCodexCatalog("0.144.1")
    const second = await loadInstalledCodexCatalog("0.144.1")

    expect(first).toEqual({
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "bundled instructions",
          context_window: 372_000,
        },
      ],
    })
    expect(second).toEqual(first)
    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[0]).toEqual(["/mock/codex", ["--version"]])
    expect(runCommand.mock.calls[1]).toEqual([
      "/mock/codex",
      ["debug", "models", "--bundled"],
    ])
  })

  test("skips installed executables whose version does not match", async () => {
    codexCatalogLoaderDependencies.getExecutableCandidates = () => [
      "/mock/old-codex",
      "/mock/current-codex",
    ]
    const runCommand = mock((executable: string, args: Array<string>) => {
      if (args[0] === "--version") {
        return Promise.resolve(
          executable.includes("old") ?
            "codex-cli 0.143.0\n"
          : "codex-cli 0.144.1\n",
        )
      }
      return Promise.resolve(bundledCatalog)
    })
    codexCatalogLoaderDependencies.runCommand = runCommand

    const catalog = await loadInstalledCodexCatalog("0.144.1")

    expect(catalog?.models[0]?.slug).toBe("gpt-5.6-sol")
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(runCommand.mock.calls[2]?.[0]).toBe("/mock/current-codex")
  })

  test("returns no override when the matching CLI catalog is invalid", async () => {
    codexCatalogLoaderDependencies.runCommand = (_executable, args) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : "not-json",
      )

    expect(await loadInstalledCodexCatalog("0.144.1")).toBeNull()
  })

  test("continues to another executable after a command failure", async () => {
    codexCatalogLoaderDependencies.getExecutableCandidates = () => [
      "/mock/broken-codex",
      "/mock/current-codex",
    ]
    codexCatalogLoaderDependencies.runCommand = (executable, args) => {
      if (executable.includes("broken")) {
        return Promise.reject(new Error("spawn failed"))
      }
      return Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : bundledCatalog,
      )
    }

    expect((await loadInstalledCodexCatalog("0.144.1"))?.models[0]?.slug).toBe(
      "gpt-5.6-sol",
    )
  })

  test("rejects a JSON response that is not a Codex model catalog", async () => {
    codexCatalogLoaderDependencies.runCommand = (_executable, args) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : '{"data":[]}',
      )

    expect(await loadInstalledCodexCatalog("0.144.1")).toBeNull()
  })

  test("returns no catalog when every installed version differs", async () => {
    codexCatalogLoaderDependencies.runCommand = () =>
      Promise.resolve("codex-cli 0.143.0\n")

    expect(await loadInstalledCodexCatalog("0.144.1")).toBeNull()
  })

  test("parses the client version without trusting malformed query values", () => {
    expect(
      getCodexClientVersion(
        "http://localhost/v1/models?client_version=invalid",
        "Codex Desktop/0.145.0",
      ),
    ).toBe("0.145.0")
    expect(
      getCodexClientVersion("http://localhost/v1/models", undefined),
    ).toBeNull()
    expect(isCodexClientUserAgent(" Codex Desktop/0.145.0")).toBeTrue()
    expect(isCodexClientUserAgent("curl/8.0")).toBeFalse()
  })

  test("preserves the bundled descriptor when Copilot omits context limits", async () => {
    codexClientModelsDependencies.loadBundledCatalog = () =>
      Promise.resolve(bundledCatalogObject)

    expect(await createCodexModelsResponse(null, [])).toEqual({ models: [] })
    expect(
      await createCodexModelsResponse("0.144.1", [createCopilotModel({})]),
    ).toEqual(bundledCatalogObject)
  })
})
