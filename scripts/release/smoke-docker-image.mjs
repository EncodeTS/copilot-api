#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

export function createDockerRunner(spawn = spawnSync) {
  return {
    run(arguments_, options = {}) {
      const result = spawn("docker", arguments_, {
        encoding: "utf8",
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

  runChecked(
    dockerRunner,
    [
      "run",
      "--detach",
      "--name",
      container,
      "--env",
      "COPILOT_API_HOME=/tmp/copilot-api-smoke",
      image,
    ],
    { timeoutMs: 30_000 },
  )

  let primaryError
  let health = "starting"
  try {
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
          "--api-home=/tmp/copilot-api-debug",
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
    throw error
  } finally {
    try {
      runChecked(dockerRunner, ["rm", "--force", container], {
        timeoutMs: 30_000,
      })
    } catch (cleanupError) {
      throw combineFailure(primaryError, cleanupError)
    }
  }

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
