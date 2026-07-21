#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const defaultRepoRoot = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
)

export function createProcessRunner(spawn = spawnSync) {
  return {
    run(request) {
      const result = spawn(request.command, request.arguments, {
        cwd: request.cwd,
        encoding: "utf8",
        env: request.environment,
        timeout: request.timeoutMs,
      })
      return {
        error: result.error,
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      }
    },
  }
}

function visitDirectories(root, fileSystem) {
  const queue = [root]
  const matches = []
  let visited = 0

  while (queue.length > 0) {
    const directory = queue.shift()
    visited += 1
    if (visited > 10_000) {
      throw new Error("packaged Desktop traversal exceeded 10000 directories")
    }

    const packageJson = path.join(directory, "package.json")
    if (
      path.basename(directory) === "server" &&
      fileSystem.statSync(packageJson, { throwIfNoEntry: false })?.isFile() &&
      fileSystem
        .statSync(path.join(directory, "main.js"), { throwIfNoEntry: false })
        ?.isFile()
    ) {
      matches.push(directory)
      continue
    }

    for (const entry of fileSystem.readdirSync(directory, {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith(".")
      ) {
        queue.push(path.join(directory, entry.name))
      }
    }
  }
  return matches
}

export function findPackagedServerDirectory(releaseDirectory, fileSystem = fs) {
  const matches = visitDirectories(path.resolve(releaseDirectory), fileSystem)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one packaged Desktop server, found ${matches.length}`,
    )
  }
  return matches[0]
}

function runChecked(processRunner, request) {
  const result = processRunner.run(request)
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${path.basename(request.command)} timed out`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(request.command)} ${request.arguments.join(" ")} exited with ${result.status}`,
    )
  }
  return result.stdout
}

function parseDebugJson(output) {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end < start) {
    throw new Error("packaged server debug command did not return JSON")
  }
  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch {
    throw new Error("packaged server debug command did not return valid JSON")
  }
}

export function verifyPackagedServerManifest(
  serverDirectory,
  version,
  fileSystem = fs,
) {
  const manifest = JSON.parse(
    fileSystem.readFileSync(path.join(serverDirectory, "package.json"), "utf8"),
  )
  if (manifest.version !== version) {
    throw new Error(
      `packaged server version ${JSON.stringify(manifest.version)} does not match ${version}`,
    )
  }
}

function combineFailure(primaryError, cleanupError) {
  if (!primaryError) return cleanupError
  return new AggregateError(
    [primaryError, cleanupError],
    `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
  )
}

export function smokePackagedDesktop(
  { releaseDirectory, version },
  dependencies = {},
) {
  const fileSystem = dependencies.fileSystem ?? fs
  const processRunner = dependencies.processRunner ?? createProcessRunner()
  const executable = dependencies.executable ?? process.execPath
  const environmentSource = dependencies.environment ?? process.env
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot
  const temporaryRoot = dependencies.temporaryRoot ?? os.tmpdir()
  const output = dependencies.output ?? console
  const serverDirectory = findPackagedServerDirectory(
    releaseDirectory,
    fileSystem,
  )
  verifyPackagedServerManifest(serverDirectory, version, fileSystem)

  const isolatedRoot = fileSystem.mkdtempSync(
    path.join(temporaryRoot, "copilot-api-packaged-desktop-smoke-"),
  )
  const environment = {
    ...environmentSource,
    APPDATA: path.join(isolatedRoot, "appdata"),
    COPILOT_API_HOME: path.join(isolatedRoot, "api-home"),
    HOME: path.join(isolatedRoot, "home"),
    LOCALAPPDATA: path.join(isolatedRoot, "localappdata"),
    XDG_CACHE_HOME: path.join(isolatedRoot, "cache"),
    XDG_CONFIG_HOME: path.join(isolatedRoot, "config"),
    XDG_DATA_HOME: path.join(isolatedRoot, "data"),
  }
  for (const directory of Object.values(environment).filter(
    (value) => typeof value === "string" && value.startsWith(isolatedRoot),
  )) {
    fileSystem.mkdirSync(directory, { recursive: true })
  }

  let primaryError
  try {
    const debugOutput = runChecked(processRunner, {
      arguments: [
        path.join(serverDirectory, "main.js"),
        `--api-home=${environment.COPILOT_API_HOME}`,
        "debug",
        "--json",
      ],
      command: executable,
      cwd: serverDirectory,
      environment,
      timeoutMs: 120_000,
    })
    const debugInfo = parseDebugJson(debugOutput)
    if (debugInfo.version !== version) {
      throw new Error(
        `packaged server runtime reported ${JSON.stringify(debugInfo.version)} instead of ${version}`,
      )
    }

    for (const smokeScript of [
      "smoke-packaged-sharp.mjs",
      "smoke-zstd-runtime.mjs",
    ]) {
      runChecked(processRunner, {
        arguments: [
          path.join(repoRoot, "scripts", smokeScript),
          serverDirectory,
        ],
        command: executable,
        environment,
        timeoutMs: 120_000,
      })
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      fileSystem.rmSync(isolatedRoot, { force: true, recursive: true })
    } catch (cleanupError) {
      throw combineFailure(primaryError, cleanupError)
    }
  }

  output.log(`packagedServerVersion=${version}`)
  output.log("packagedDesktopRuntimeOk=true")
  return { serverDirectory, version }
}

export function runPackagedDesktopSmokeCli(arguments_, dependencies = {}) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "release-directory": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  })
  if (!values["release-directory"] || !values.version) {
    throw new Error("--release-directory and --version are required")
  }
  return smokePackagedDesktop(
    {
      releaseDirectory: values["release-directory"],
      version: values.version,
    },
    dependencies,
  )
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    runPackagedDesktopSmokeCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
