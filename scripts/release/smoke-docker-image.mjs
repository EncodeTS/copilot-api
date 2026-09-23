#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

export function createDockerRunner(spawn = spawnSync) {
  return {
    run(arguments_, options = {}) {
      const result = spawn("docker", arguments_, {
        encoding: "utf8",
        input: options.input,
        timeout: options.timeoutMs ?? 120_000,
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

function runChecked(dockerRunner, arguments_, options) {
  const result = dockerRunner.run(arguments_, options)
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`docker ${arguments_[0]} timed out`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `docker ${arguments_.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    )
  }
  return result.stdout.trim()
}

function parseRuntimeDebug(output) {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error("Docker runtime debug output was not valid JSON")
  }
}

function combineFailure(primaryError, cleanupError) {
  if (!primaryError) return cleanupError
  return new AggregateError(
    [primaryError, cleanupError],
    `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
  )
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const CONTAINER_SMOKE_HOME = "/home/bun/.local/share/copilot-api"
const DOCKER_SMOKE_CONFIG = {
  configSchemaVersion: 2,
  providers: {
    smoke: {
      apiKey: "docker-smoke-only",
      baseUrl: "http://127.0.0.1:9",
      enabled: true,
      type: "openai-compatible",
    },
  },
}
const MAX_DOCKER_DIAGNOSTIC_CHARACTERS = 4_000

function boundedDockerDiagnostic(
  value,
  maxCharacters = MAX_DOCKER_DIAGNOSTIC_CHARACTERS,
) {
  const normalized = value
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
  return normalized.slice(-maxCharacters)
}

function readDockerDiagnostic(dockerRunner, arguments_) {
  const result = dockerRunner.run(arguments_, { timeoutMs: 10_000 })
  if (result.error || result.status !== 0) return "unavailable"
  const streamLimit = Math.floor(
    (MAX_DOCKER_DIAGNOSTIC_CHARACTERS - 32) / 2,
  )
  const stdout = boundedDockerDiagnostic(result.stdout, streamLimit) || "empty"
  const stderr = boundedDockerDiagnostic(result.stderr, streamLimit) || "empty"
  return `stdout=${stdout}\nstderr=${stderr}`
}

function emitDockerFailureDiagnostics(dockerRunner, container, output) {
  if (typeof output.error !== "function") return
  const health = readDockerDiagnostic(dockerRunner, [
    "inspect",
    "--format",
    "{{json .State.Health}}",
    container,
  ])
  const logs = readDockerDiagnostic(dockerRunner, [
    "logs",
    "--tail",
    "100",
    container,
  ])
  output.error(`dockerSmokeHealth=${health}`)
  output.error(`dockerSmokeLogs=${logs}`)
}

function removeDockerContainerIfPresent(dockerRunner, container) {
  const arguments_ = ["rm", "--force", container]
  const result = dockerRunner.run(arguments_, { timeoutMs: 30_000 })
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("docker rm timed out")
  }
  if (result.error) throw result.error
  if (result.status === 0) return
  if (/No such container/iu.test(`${result.stdout}\n${result.stderr}`)) return
  throw new Error(
    `docker ${arguments_.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
  )
}

function removeDockerVolumeIfPresent(dockerRunner, volume) {
  const arguments_ = ["volume", "rm", volume]
  const result = dockerRunner.run(arguments_, { timeoutMs: 30_000 })
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("docker volume rm timed out")
  }
  if (result.error) throw result.error
  if (result.status === 0) return
  if (/No such volume/iu.test(`${result.stdout}\n${result.stderr}`)) return
  throw new Error(
    `docker ${arguments_.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
  )
}

export async function smokeDockerImage(
  { configDigest, image, timeoutMs = 60_000, version },
  dependencies = {},
) {
  const dockerRunner = dependencies.dockerRunner ?? createDockerRunner()
  const clock = dependencies.clock ?? Date
  const sleep = dependencies.sleep ?? defaultSleep
  const output = dependencies.output ?? console
  const processId = dependencies.processId ?? process.pid
  const container = `copilot-api-release-smoke-${processId}`
  const volume = `${container}-data-${randomUUID()}`

  const loadedConfigDigest = runChecked(
    dockerRunner,
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeoutMs: 30_000 },
  )
  if (loadedConfigDigest !== configDigest) {
    throw new Error(
      `loaded Docker image config ${loadedConfigDigest} does not match tested OCI config ${configDigest}`,
    )
  }

  let containerCleanupRequired = false
  let volumeCleanupRequired = false
  let containerCreated = false
  let primaryError
  let cleanupError
  let health = "starting"
  try {
    runChecked(
      dockerRunner,
      ["volume", "create", volume],
      { timeoutMs: 30_000 },
    )
    volumeCleanupRequired = true
    runChecked(
      dockerRunner,
      [
        "run",
        "--rm",
        "-i",
        "--mount",
        `type=volume,source=${volume},target=${CONTAINER_SMOKE_HOME}`,
        "--entrypoint",
        "sh",
        image,
        "-c",
        'umask 077; cat > "$COPILOT_API_HOME/config.json"',
      ],
      {
        input: `${JSON.stringify(DOCKER_SMOKE_CONFIG, null, 2)}\n`,
        timeoutMs: 30_000,
      },
    )
    containerCleanupRequired = true
    runChecked(
      dockerRunner,
      [
        "create",
        "--name",
        container,
        "--mount",
        `type=volume,source=${volume},target=${CONTAINER_SMOKE_HOME}`,
        image,
        "--desktop-auth-mode=provider",
      ],
      { timeoutMs: 30_000 },
    )
    containerCreated = true
    runChecked(dockerRunner, ["start", container], { timeoutMs: 30_000 })
    const deadline = clock.now() + timeoutMs
    while (true) {
      health = runChecked(
        dockerRunner,
        [
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
          container,
        ],
        { timeoutMs: 10_000 },
      )
      if (health === "healthy") break
      if (health === "unhealthy" || health === "missing") {
        throw new Error(`Docker image health status is ${health}`)
      }
      if (clock.now() >= deadline) break
      await sleep(Math.min(1_000, timeoutMs))
    }
    if (health !== "healthy") {
      throw new Error(
        `Docker image did not become healthy within ${timeoutMs}ms`,
      )
    }

    const debugInfo = parseRuntimeDebug(
      runChecked(
        dockerRunner,
        [
          "exec",
          container,
          "bun",
          "run",
          "/app/dist/main.js",
          "--api-home=/app/copilot-api-smoke-debug",
          "debug",
          "--json",
        ],
        { timeoutMs: 30_000 },
      ),
    )
    if (debugInfo.version !== version) {
      throw new Error(
        `Docker runtime reported ${JSON.stringify(debugInfo.version)} instead of ${version}`,
      )
    }
  } catch (error) {
    primaryError = error
    if (containerCreated) {
      emitDockerFailureDiagnostics(dockerRunner, container, output)
    }
  } finally {
    if (containerCleanupRequired) {
      try {
        removeDockerContainerIfPresent(dockerRunner, container)
      } catch (error) {
        cleanupError = error
      }
    }
    if (volumeCleanupRequired) {
      try {
        removeDockerVolumeIfPresent(dockerRunner, volume)
      } catch (error) {
        cleanupError = combineFailure(cleanupError, error)
      }
    }
  }

  if (primaryError) {
    throw cleanupError
      ? combineFailure(primaryError, cleanupError)
      : primaryError
  }
  if (cleanupError) throw cleanupError

  output.log("dockerHealth=healthy")
  output.log(`dockerRuntimeVersion=${version}`)
  output.log(`dockerConfigDigest=${configDigest}`)
  output.log("dockerRuntimeOk=true")
  return { configDigest, health, version }
}

export async function runDockerImageSmokeCli(arguments_, dependencies = {}) {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "config-digest": { type: "string" },
      image: { type: "string" },
      "timeout-ms": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  })
  if (!values["config-digest"] || !values.image || !values.version) {
    throw new Error("--config-digest, --image, and --version are required")
  }
  const timeoutMs = Number(values["timeout-ms"] ?? "60000")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer")
  }
  return smokeDockerImage(
    {
      configDigest: values["config-digest"],
      image: values.image,
      timeoutMs,
      version: values.version,
    },
    dependencies,
  )
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runDockerImageSmokeCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
