import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  clearCodexCatalogCache,
  codexCatalogLoaderDependencies,
  loadInstalledCodexCatalog,
  type CodexModelsResponse,
} from "../src/services/codex/installed-catalog"

const originalGetExecutableCandidates =
  codexCatalogLoaderDependencies.getExecutableCandidates
const originalRunCommand = codexCatalogLoaderDependencies.runCommand

const bundledCatalogObject: CodexModelsResponse = {
  models: [
    {
      slug: "gpt-5.6-sol",
      base_instructions: "bundled instructions",
      context_window: 372_000,
      supports_reasoning_summaries: true,
    },
  ],
}
const bundledCatalog = JSON.stringify(bundledCatalogObject)

function writeCodexCmdFixture(directory: string): string {
  const executable = path.join(directory, "codex.cmd")
  fs.writeFileSync(
    executable,
    [
      "@echo off",
      'if "%~1"=="--version" (',
      "  echo codex-cli 0.144.1",
      "  exit /b 0",
      ")",
      'if "%~1"=="debug" if "%~2"=="models" if "%~3"=="--bundled" (',
      `  echo ${bundledCatalog}`,
      "  exit /b 0",
      ")",
      "exit /b 1",
      "",
    ].join("\r\n"),
    "utf8",
  )
  return executable
}

beforeEach(() => {
  clearCodexCatalogCache()
  codexCatalogLoaderDependencies.getExecutableCandidates = () => ["/mock/codex"]
})

afterEach(() => {
  codexCatalogLoaderDependencies.getExecutableCandidates =
    originalGetExecutableCandidates
  codexCatalogLoaderDependencies.runCommand = originalRunCommand
  clearCodexCatalogCache()
})

describe("installed Codex catalog", () => {
  const realCodexVersion = process.env.COPILOT_API_REAL_CODEX_VERSION
  const realCodexIntegrationTest = realCodexVersion ? test : test.skip

  realCodexIntegrationTest(
    "loads the official Codex catalog through installed discovery",
    async () => {
      codexCatalogLoaderDependencies.getExecutableCandidates =
        originalGetExecutableCandidates
      codexCatalogLoaderDependencies.runCommand = originalRunCommand
      clearCodexCatalogCache()

      const catalog = await loadInstalledCodexCatalog(realCodexVersion ?? "")

      expect(catalog).not.toBeNull()
      expect(catalog?.models.length).toBeGreaterThan(0)
      expect(
        catalog?.models.every(
          (model) =>
            typeof model.slug === "string"
            && typeof model.base_instructions === "string",
        ),
      ).toBeTrue()
    },
    30_000,
  )

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
          supports_reasoning_summaries: true,
        },
      ],
    })
    expect(second).toEqual(first)
    expect(runCommand).toHaveBeenCalledTimes(3)
    expect(runCommand.mock.calls[0]).toEqual(["/mock/codex", ["--version"]])
    expect(runCommand.mock.calls[1]).toEqual(["/mock/codex", ["--version"]])
    expect(runCommand.mock.calls[2]).toEqual([
      "/mock/codex",
      ["debug", "models", "--bundled"],
    ])
  })

  test("backfills reasoning summary support omitted by newer bundled catalogs", async () => {
    const catalogWithoutCompatibilityField = JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "bundled instructions",
          supported_reasoning_levels: [{ effort: "high" }],
        },
        {
          slug: "gpt-5.4-mini",
          base_instructions: "mini instructions",
          supports_reasoning_summaries: false,
        },
      ],
    })
    codexCatalogLoaderDependencies.runCommand = (_executable, args) =>
      Promise.resolve(
        args[0] === "--version" ?
          "codex-cli 0.145.0-alpha.18\n"
        : catalogWithoutCompatibilityField,
      )

    expect(await loadInstalledCodexCatalog("0.145.0-alpha.18")).toEqual({
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "bundled instructions",
          supported_reasoning_levels: [{ effort: "high" }],
          supports_reasoning_summaries: true,
        },
        {
          slug: "gpt-5.4-mini",
          base_instructions: "mini instructions",
          supports_reasoning_summaries: false,
        },
      ],
    })
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
    expect(runCommand).toHaveBeenCalledTimes(4)
    expect(runCommand.mock.calls[3]).toEqual([
      "/mock/current-codex",
      ["debug", "models", "--bundled"],
    ])
  })

  test("rechecks an executable version before reading its catalog", async () => {
    let versionChecks = 0
    const runCommand = mock((_executable: string, args: Array<string>) => {
      if (args[0] === "--version") {
        versionChecks += 1
        return Promise.resolve(
          versionChecks === 1 ? "codex-cli 0.144.1\n" : "codex-cli 0.144.2\n",
        )
      }
      return Promise.resolve(bundledCatalog)
    })
    codexCatalogLoaderDependencies.runCommand = runCommand

    expect(await loadInstalledCodexCatalog("0.144.1")).toBeNull()
    expect(versionChecks).toBe(2)
    expect(
      runCommand.mock.calls.filter(([, args]) => args[0] === "debug"),
    ).toHaveLength(0)
  })

  test("returns no override when the matching CLI catalog is invalid", async () => {
    codexCatalogLoaderDependencies.runCommand = (_executable, args) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : "not-json",
      )

    expect(await loadInstalledCodexCatalog("0.144.1")).toBeNull()
  })

  test("continues after an invalid catalog from a matching executable", async () => {
    codexCatalogLoaderDependencies.getExecutableCandidates = () => [
      "/mock/invalid-codex",
      "/mock/valid-codex",
    ]
    const runCommand = mock((executable: string, args: Array<string>) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\r\n"
        : executable.includes("invalid") ? "not-json"
        : bundledCatalog,
      ),
    )
    codexCatalogLoaderDependencies.runCommand = runCommand

    expect(await loadInstalledCodexCatalog("0.144.1")).toEqual(
      bundledCatalogObject,
    )
    expect(runCommand).toHaveBeenCalledTimes(6)
  })

  test("rejects a partially invalid catalog and tries the next executable", async () => {
    codexCatalogLoaderDependencies.getExecutableCandidates = () => [
      "/mock/partial-codex",
      "/mock/valid-codex",
    ]
    const partiallyInvalidCatalog = JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "partial candidate instructions",
        },
        {
          slug: "future-model-with-new-schema",
        },
      ],
    })
    const runCommand = mock((executable: string, args: Array<string>) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n"
        : executable.includes("partial") ? partiallyInvalidCatalog
        : bundledCatalog,
      ),
    )
    codexCatalogLoaderDependencies.runCommand = runCommand

    expect(await loadInstalledCodexCatalog("0.144.1")).toEqual(
      bundledCatalogObject,
    )
    expect(
      runCommand.mock.calls.filter(([, args]) => args[0] === "debug"),
    ).toHaveLength(2)
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

  test("runs a real Windows cmd shim from a Unicode path with spaces", async () => {
    if (process.platform !== "win32") {
      return
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot api codex \u6d4b\u8bd5 "),
    )
    const executable = writeCodexCmdFixture(tempDir)

    try {
      codexCatalogLoaderDependencies.getExecutableCandidates = () => [
        executable,
      ]
      codexCatalogLoaderDependencies.runCommand = originalRunCommand

      expect(await loadInstalledCodexCatalog("0.144.1")).toEqual(
        bundledCatalogObject,
      )
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test("rejects unsafe Windows cmd paths before spawning", async () => {
    if (process.platform !== "win32") {
      return
    }

    let thrown: unknown
    try {
      await originalRunCommand(String.raw`C:\Temp\codex&echo-injected.cmd`, [
        "--version",
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    if (!(thrown instanceof Error)) {
      throw new TypeError("Expected Windows command validation to throw")
    }
    expect(thrown.message).toBe("Unsafe Windows command path or argument")
  })

  test("loads a Windows cmd shim found on PATH", async () => {
    if (process.platform !== "win32") {
      return
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-path-"))
    const originalPath = process.env.PATH
    writeCodexCmdFixture(tempDir)

    try {
      process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`
      codexCatalogLoaderDependencies.getExecutableCandidates = () => ["codex"]
      codexCatalogLoaderDependencies.runCommand = originalRunCommand

      expect(await loadInstalledCodexCatalog("0.144.1")).toEqual(
        bundledCatalogObject,
      )
    } finally {
      process.env.PATH = originalPath
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test("includes stable Windows installation candidates", () => {
    if (process.platform !== "win32") {
      return
    }

    const originalAppData = process.env.APPDATA
    const originalLocalAppData = process.env.LOCALAPPDATA
    const originalPnpmHome = process.env.PNPM_HOME
    const originalOverride = process.env.COPILOT_API_CODEX_CLI_PATH
    const appData = String.raw`C:\Users\Test User\AppData\Roaming`
    const localAppData = String.raw`C:\Users\Test User\AppData\Local`
    const pnpmHome = String.raw`C:\Users\Test User\pnpm`
    const cmdOverride = String.raw`C:\Tools With Spaces\codex.cmd`
    const exeOverride = String.raw`C:\Tools With Spaces\codex.exe`

    try {
      process.env.APPDATA = appData
      process.env.LOCALAPPDATA = localAppData
      process.env.PNPM_HOME = pnpmHome
      process.env.COPILOT_API_CODEX_CLI_PATH = cmdOverride

      const candidates = originalGetExecutableCandidates()
      expect(candidates[0]).toBe(cmdOverride)

      process.env.COPILOT_API_CODEX_CLI_PATH = exeOverride
      expect(originalGetExecutableCandidates()[0]).toBe(exeOverride)

      expect(candidates).toContain(
        path.join(
          localAppData,
          "Programs",
          "OpenAI",
          "Codex",
          "bin",
          "codex.exe",
        ),
      )
      expect(candidates).toContain(path.join(appData, "npm", "codex.cmd"))
      expect(candidates).toContain(path.join(pnpmHome, "codex.cmd"))
      expect(candidates).toContain(
        path.join(os.homedir(), ".bun", "bin", "codex.exe"),
      )
      expect(candidates).toContain(
        path.join(
          appData,
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      )
      expect(candidates).toContain(
        path.join(
          appData,
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-arm64",
          "vendor",
          "aarch64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      )
    } finally {
      process.env.APPDATA = originalAppData
      process.env.LOCALAPPDATA = originalLocalAppData
      process.env.PNPM_HOME = originalPnpmHome
      process.env.COPILOT_API_CODEX_CLI_PATH = originalOverride
    }
  })

  test("prioritizes an override and Windows native executables before shims", () => {
    const appData = path.join(os.tmpdir(), "codex-app-data")
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-native-order-"),
    )
    const localAppData = path.join(tempDir, "local-app-data")
    const pnpmHome = path.join(os.tmpdir(), "codex-pnpm")
    const override = path.join(os.tmpdir(), "explicit", "codex.cmd")
    const standaloneExecutable = path.join(
      localAppData,
      "Programs",
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe",
    )
    const versionedExecutable = path.join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "0123456789abcdef",
      "codex.exe",
    )

    try {
      fs.mkdirSync(path.dirname(versionedExecutable), { recursive: true })
      fs.writeFileSync(versionedExecutable, "")

      const candidates = originalGetExecutableCandidates({
        environment: {
          APPDATA: appData,
          COPILOT_API_CODEX_CLI_PATH: override,
          LOCALAPPDATA: localAppData,
          PNPM_HOME: pnpmHome,
        },
        home: os.homedir(),
        platform: "win32",
      })
      const lastNativeIndex = candidates.reduce(
        (lastIndex, candidate, index) =>
          candidate.toLowerCase().endsWith(".exe") ? index : lastIndex,
        -1,
      )
      const firstShimIndex = candidates.findIndex(
        (candidate, index) =>
          index > 0 && !candidate.toLowerCase().endsWith(".exe"),
      )

      expect(candidates[0]).toBe(override)
      expect(candidates).toContain(standaloneExecutable)
      expect(candidates).toContain(versionedExecutable)
      expect(lastNativeIndex).toBeGreaterThan(0)
      expect(firstShimIndex).toBeGreaterThan(lastNativeIndex)
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
  })

  test("discovers bounded versioned Codex App executables", () => {
    if (process.platform !== "win32") {
      return
    }

    const originalLocalAppData = process.env.LOCALAPPDATA
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-api-codex-app-"),
    )
    const binDir = path.join(tempDir, "OpenAI", "Codex", "bin")
    const hashes = Array.from({ length: 10 }, (_, index) =>
      index.toString(16).padStart(16, "0"),
    )

    try {
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(path.join(binDir, "codex.exe"), "")
      for (const [index, hash] of hashes.entries()) {
        const directory = path.join(binDir, hash)
        const executable = path.join(directory, "codex.exe")
        fs.mkdirSync(directory)
        fs.writeFileSync(executable, "")
        const modified = new Date(Date.UTC(2026, 0, 1, 0, index))
        fs.utimesSync(executable, modified, modified)
      }
      const ignoredDirectory = path.join(binDir, "not-a-version")
      fs.mkdirSync(ignoredDirectory)
      fs.writeFileSync(path.join(ignoredDirectory, "codex.exe"), "")
      process.env.LOCALAPPDATA = tempDir

      const candidates = originalGetExecutableCandidates()
      const versionedCandidates = candidates.filter(
        (candidate) =>
          candidate.startsWith(`${binDir}${path.sep}`)
          && candidate !== path.join(binDir, "codex.exe"),
      )

      expect(versionedCandidates).toHaveLength(8)
      expect(versionedCandidates[0]).toBe(
        path.join(binDir, hashes.at(-1) ?? "", "codex.exe"),
      )
      expect(candidates).toContain(path.join(binDir, "codex.exe"))
      expect(candidates).not.toContain(path.join(ignoredDirectory, "codex.exe"))
    } finally {
      process.env.LOCALAPPDATA = originalLocalAppData
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
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

  test("shares executable discovery across many unknown versions", async () => {
    const runCommand = mock(() => Promise.resolve("codex-cli 0.144.1\r\n"))
    codexCatalogLoaderDependencies.runCommand = runCommand

    const catalogs = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        loadInstalledCodexCatalog(`9.0.${index}`),
      ),
    )

    expect(catalogs.every((catalog) => catalog === null)).toBeTrue()
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  test("shares one catalog load across concurrent requests for a version", async () => {
    const runCommand = mock((_executable: string, args: Array<string>) =>
      Promise.resolve(
        args[0] === "--version" ? "codex-cli 0.144.1\n" : bundledCatalog,
      ),
    )
    codexCatalogLoaderDependencies.runCommand = runCommand

    const catalogs = await Promise.all(
      Array.from({ length: 20 }, () => loadInstalledCodexCatalog("0.144.1")),
    )

    expect(catalogs.every((catalog) => catalog === catalogs[0])).toBeTrue()
    expect(runCommand).toHaveBeenCalledTimes(3)
  })

  test("evicts the oldest catalog after the cache reaches its limit", async () => {
    const versionCount = 65
    codexCatalogLoaderDependencies.getExecutableCandidates = () =>
      Array.from({ length: versionCount }, (_, index) => `/mock/codex-${index}`)
    const runCommand = mock((executable: string, args: Array<string>) => {
      const index = executable.match(/\d+$/u)?.[0]
      return Promise.resolve(
        args[0] === "--version" ? `codex-cli 1.0.${index}\n` : bundledCatalog,
      )
    })
    codexCatalogLoaderDependencies.runCommand = runCommand

    for (let index = 0; index < versionCount; index += 1) {
      await loadInstalledCodexCatalog(`1.0.${index}`)
    }
    await loadInstalledCodexCatalog("1.0.0")

    expect(
      runCommand.mock.calls.filter(([, args]) => args[0] === "debug"),
    ).toHaveLength(versionCount + 1)
  })
})
