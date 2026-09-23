import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  runPackagedDesktopSmokeCli,
  smokePackagedDesktop,
} from "../scripts/release/smoke-packaged-desktop.mjs"
import {
  runDockerImageSmokeCli,
  smokeDockerImage,
} from "../scripts/release/smoke-docker-image.mjs"

interface ProcessRunResult {
  error?: Error & { code?: string }
  status: number | null
  stderr: string
  stdout: string
}

type DockerRunResult = ProcessRunResult

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("expected promise to reject")
}

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function packagedDesktopFixture(version = "2.0.0-rc.14"): string {
  const releaseDirectory = temporaryDirectory("desktop-runtime-smoke-")
  const serverDirectory = path.join(
    releaseDirectory,
    "Copilot API.app",
    "Contents",
    "Resources",
    "server",
  )
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(serverDirectory, "package.json"),
    `${JSON.stringify({ version })}\n`,
  )
  fs.writeFileSync(path.join(serverDirectory, "main.js"), "// fixture\n")
  return releaseDirectory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("packaged Desktop runtime smoke", () => {
  test("uses injectable filesystem and process runners for the full success contract", () => {
    const releaseDirectory = packagedDesktopFixture()
    const calls: Array<{ arguments: string[]; command: string }> = []
    let cleanupCount = 0
    const fileSystem = {
      ...fs,
      rmSync(target: fs.PathLike, options?: fs.RmDirOptions): void {
        cleanupCount += 1
        fs.rmSync(target, options)
      },
    }
    const processRunner = {
      run(request: { arguments: string[]; command: string }): ProcessRunResult {
        calls.push(request)
        return {
          status: 0,
          stderr: "",
          stdout:
            calls.length === 1 ?
              `${JSON.stringify({ version: "2.0.0-rc.14" })}\n`
            : "ok\n",
        }
      },
    }

    expect(
      smokePackagedDesktop(
        { releaseDirectory, version: "2.0.0-rc.14" },
        { fileSystem, processRunner },
      ).version,
    ).toBe("2.0.0-rc.14")
    expect(calls).toHaveLength(3)
    expect(cleanupCount).toBe(1)
  })

  test("classifies process timeout and always cleans isolated state", () => {
    const releaseDirectory = packagedDesktopFixture()
    let cleaned = false
    const timeout = Object.assign(new Error("spawn timeout"), {
      code: "ETIMEDOUT",
    })
    const processRunner = {
      run(): ProcessRunResult {
        return { error: timeout, status: null, stderr: "", stdout: "" }
      },
    }
    const fileSystem = {
      ...fs,
      rmSync(target: fs.PathLike, options?: fs.RmDirOptions): void {
        cleaned = true
        fs.rmSync(target, options)
      },
    }

    expect(() =>
      smokePackagedDesktop(
        { releaseDirectory, version: "2.0.0-rc.14" },
        { fileSystem, processRunner },
      ),
    ).toThrow("timed out")
    expect(cleaned).toBe(true)
  })

  test("rejects malformed runtime output and reports cleanup failure", () => {
    const releaseDirectory = packagedDesktopFixture()
    const processRunner = {
      run(): ProcessRunResult {
        return { status: 0, stderr: "", stdout: "not-json" }
      },
    }

    expect(() =>
      smokePackagedDesktop(
        { releaseDirectory, version: "2.0.0-rc.14" },
        { processRunner },
      ),
    ).toThrow("did not return JSON")

    expect(() =>
      smokePackagedDesktop(
        { releaseDirectory, version: "2.0.0-rc.14" },
        {
          fileSystem: {
            ...fs,
            rmSync(): never {
              throw new Error("cleanup refused")
            },
          },
          processRunner: {
            run(): ProcessRunResult {
              return {
                status: 0,
                stderr: "",
                stdout: `${JSON.stringify({ version: "2.0.0-rc.14" })}\n`,
              }
            },
          },
        },
      ),
    ).toThrow("cleanup refused")
  })

  test("exposes the injected smoke through the public CLI contract", () => {
    const releaseDirectory = packagedDesktopFixture()
    let calls = 0
    const result = runPackagedDesktopSmokeCli(
      ["--release-directory", releaseDirectory, "--version", "2.0.0-rc.14"],
      {
        output: { log(): void {} },
        processRunner: {
          run(): ProcessRunResult {
            calls += 1
            return dockerResult(
              calls === 1 ? JSON.stringify({ version: "2.0.0-rc.14" }) : "",
            )
          },
        },
      },
    )
    expect(result.version).toBe("2.0.0-rc.14")
    expect(() => runPackagedDesktopSmokeCli([])).toThrow(
      "--release-directory and --version are required",
    )
  })

  test("rejects missing, manifest-mismatched, and runtime-mismatched packages", () => {
    expect(() =>
      smokePackagedDesktop({
        releaseDirectory: temporaryDirectory("desktop-empty-release-"),
        version: "2.0.0-rc.14",
      }),
    ).toThrow("expected exactly one packaged Desktop server")

    expect(() =>
      smokePackagedDesktop({
        releaseDirectory: packagedDesktopFixture("2.0.0-rc.13"),
        version: "2.0.0-rc.14",
      }),
    ).toThrow("packaged server version")

    expect(() =>
      smokePackagedDesktop(
        {
          releaseDirectory: packagedDesktopFixture(),
          version: "2.0.0-rc.14",
        },
        {
          processRunner: {
            run(): ProcessRunResult {
              return dockerResult(JSON.stringify({ version: "2.0.0-rc.13" }))
            },
          },
        },
      ),
    ).toThrow("runtime reported")
  })
})

function dockerResult(
  stdout = "",
  overrides: Partial<DockerRunResult> = {},
): DockerRunResult {
  return { status: 0, stderr: "", stdout, ...overrides }
}

describe("Docker artifact runtime smoke", () => {
  test("seeds a private volume as the image user and cleans it with the container", async () => {
    const commands: string[][] = []
    let runtimeConfig = ""
    const dockerRunner = {
      run(arguments_: string[], options?: { input?: string }): DockerRunResult {
        commands.push(arguments_)
        if (arguments_[0] === "run") runtimeConfig = options?.input ?? ""
        if (arguments_[0] === "image") return dockerResult("sha256:config\n")
        if (arguments_[0] === "create") return dockerResult("container-id\n")
        if (arguments_[0] === "inspect") return dockerResult("healthy\n")
        if (arguments_[0] === "exec") {
          return dockerResult(`${JSON.stringify({ version: "2.0.0-rc.14" })}\n`)
        }
        return dockerResult()
      },
    }

    const result = await smokeDockerImage(
      {
        configDigest: "sha256:config",
        image: "candidate:amd64",
        version: "2.0.0-rc.14",
      },
      {
        dockerRunner,
        processId: 42,
      },
    )

    expect(result).toEqual({
      configDigest: "sha256:config",
      health: "healthy",
      version: "2.0.0-rc.14",
    })
    const createCommand = commands.find(([command]) => command === "create")
    const seedCommand = commands.find(([command]) => command === "run")
    const volumeName =
      commands.find(
        ([command, action]) => command === "volume" && action === "create",
      )?.[2] ?? ""
    expect(volumeName).toMatch(
      /^copilot-api-release-smoke-42-data-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    const volumeMount = `type=volume,source=${volumeName},target=/home/bun/.local/share/copilot-api`
    expect(seedCommand).toContain("--entrypoint")
    expect(seedCommand).toContain("sh")
    expect(seedCommand).toContain("-i")
    expect(seedCommand).not.toContain("--user")
    expect(seedCommand).toContain(volumeMount)
    expect(seedCommand?.join(" ")).not.toContain("docker-smoke-only")
    expect(createCommand).toContain("--mount")
    expect(createCommand).toContain(volumeMount)
    expect(createCommand?.at(-1)).toBe("--desktop-auth-mode=provider")
    expect(createCommand).not.toContain("--user")
    expect(commands.flat().join(" ")).not.toContain("GH_TOKEN")
    expect(JSON.parse(runtimeConfig)).toMatchObject({
      providers: {
        smoke: {
          apiKey: "docker-smoke-only",
          baseUrl: "http://127.0.0.1:9",
          enabled: true,
          type: "openai-compatible",
        },
      },
    })
    expect(commands.at(-2)?.slice(0, 2)).toEqual(["rm", "--force"])
    expect(commands.at(-1)).toEqual(["volume", "rm", volumeName])
  })

  test("uses a fresh volume for separate runs with the same process ID", async () => {
    const volumes: string[] = []
    const dockerRunner = {
      run(arguments_: string[]): DockerRunResult {
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_.slice(0, 2).join(" ") === "volume create") {
          volumes.push(arguments_[2])
        }
        if (arguments_[0] === "inspect") return dockerResult("healthy")
        if (arguments_[0] === "exec") {
          return dockerResult(JSON.stringify({ version: "2.0.0-rc.14" }))
        }
        return dockerResult()
      },
    }
    const options = {
      configDigest: "sha256:config",
      image: "candidate:amd64",
      version: "2.0.0-rc.14",
    }
    const dependencies = {
      dockerRunner,
      output: { log(): void {} },
      processId: 42,
    }
    await smokeDockerImage(options, dependencies)
    await smokeDockerImage(options, dependencies)
    expect(volumes).toHaveLength(2)
    expect(volumes[0]).not.toBe(volumes[1])
  })

  test("never removes a pre-existing volume when creation fails", async () => {
    const commands: string[][] = []
    const error = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        {
          dockerRunner: {
            run(arguments_: string[]): DockerRunResult {
              commands.push(arguments_)
              if (arguments_[0] === "image") {
                return dockerResult("sha256:config")
              }
              if (arguments_.slice(0, 2).join(" ") === "volume create") {
                return dockerResult("", {
                  status: 1,
                  stderr: "volume already exists",
                })
              }
              return dockerResult()
            },
          },
        },
      ),
    )
    expect(error.message).toContain("volume already exists")
    expect(commands.map(([command, action]) => `${command} ${action}`)).toEqual(
      ["image inspect", "volume create"],
    )
  })

  test("times out deterministically and still removes the container", async () => {
    let now = 0
    let removed = false
    const commands: string[][] = []
    const diagnostics: string[] = []
    const dockerRunner = {
      run(arguments_: string[]): DockerRunResult {
        commands.push(arguments_)
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_[0] === "create") return dockerResult("container-id")
        if (arguments_[0] === "logs") {
          return dockerResult("startup pending", {
            stderr: "fatal\u0001startup error",
          })
        }
        if (
          arguments_[0] === "inspect"
          && arguments_[2] === "{{json .State.Health}}"
        ) {
          return dockerResult('{"Status":"starting"}')
        }
        if (arguments_[0] === "inspect") return dockerResult("starting")
        if (arguments_[0] === "rm") removed = true
        return dockerResult()
      },
    }

    const timeoutError = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:arm64",
          timeoutMs: 2,
          version: "2.0.0-rc.14",
        },
        {
          clock: { now: () => now },
          dockerRunner,
          output: {
            error(message: string): void {
              diagnostics.push(message)
            },
          },
          sleep: () => {
            now += 2
            return Promise.resolve()
          },
        },
      ),
    )
    expect(timeoutError.message).toContain("within 2ms")
    expect(commands.some(([command]) => command === "logs")).toBe(true)
    expect(
      commands.some(
        (arguments_) =>
          arguments_[0] === "inspect"
          && arguments_[2] === "{{json .State.Health}}",
      ),
    ).toBe(true)
    expect(diagnostics.join("\n")).toContain("dockerSmokeHealth=")
    expect(diagnostics.join("\n")).toContain("dockerSmokeLogs=")
    expect(diagnostics.join("\n")).toContain("stdout=startup pending")
    expect(diagnostics.join("\n")).toContain("stderr=fatalstartup error")
    expect(diagnostics.join("\n")).not.toContain("\u0001")
    expect(
      diagnostics.find((message) => message.startsWith("dockerSmokeLogs="))
        ?.length,
    ).toBeLessThanOrEqual(4_100)
    expect(removed).toBe(true)
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["volume", "rm"])
  })

  test("cleans the named volume when provider config setup fails", async () => {
    let volumeRemoved = false
    const error = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        {
          dockerRunner: {
            run(arguments_: string[]): DockerRunResult {
              if (arguments_[0] === "image") {
                return dockerResult("sha256:config")
              }
              if (arguments_[0] === "run") {
                return dockerResult("", {
                  status: 1,
                  stderr: "config write refused",
                })
              }
              if (arguments_.slice(0, 2).join(" ") === "volume rm") {
                volumeRemoved = true
              }
              return dockerResult()
            },
          },
        },
      ),
    )

    expect(error.message).toContain("config write refused")
    expect(volumeRemoved).toBe(true)
  })

  test("removes a named container when docker create times out", async () => {
    let containerRemoved = false
    let volumeRemoved = false
    const timeout = Object.assign(new Error("create timeout"), {
      code: "ETIMEDOUT",
    })
    const error = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        {
          dockerRunner: {
            run(arguments_: string[]): DockerRunResult {
              if (arguments_[0] === "image") {
                return dockerResult("sha256:config")
              }
              if (arguments_[0] === "create") {
                return dockerResult("", { error: timeout, status: null })
              }
              if (arguments_[0] === "rm") containerRemoved = true
              if (arguments_.slice(0, 2).join(" ") === "volume rm") {
                volumeRemoved = true
              }
              return dockerResult()
            },
          },
        },
      ),
    )

    expect(error.message).toContain("docker create timed out")
    expect(containerRemoved).toBe(true)
    expect(volumeRemoved).toBe(true)
  })

  test("rejects malformed runtime output and surfaces cleanup failure", async () => {
    const responses = (cleanupFails: boolean) => ({
      run(arguments_: string[]): DockerRunResult {
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_[0] === "create") return dockerResult("container-id")
        if (arguments_[0] === "inspect") return dockerResult("healthy")
        if (arguments_[0] === "exec") return dockerResult("not-json")
        if (arguments_[0] === "rm" && cleanupFails) {
          return dockerResult("", { status: 1, stderr: "cleanup refused" })
        }
        return dockerResult()
      },
    })

    const malformedError = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        { dockerRunner: responses(false) },
      ),
    )
    expect(malformedError.message).toContain("valid JSON")

    const cleanupError = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:config",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        { dockerRunner: responses(true) },
      ),
    )
    expect(cleanupError.message).toContain("cleanup refused")
  })

  test("exposes digest-bound smoke through the async public CLI", async () => {
    const dockerRunner = {
      run(arguments_: string[]): DockerRunResult {
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_[0] === "create") return dockerResult("container-id")
        if (arguments_[0] === "inspect") return dockerResult("healthy")
        if (arguments_[0] === "exec") {
          return dockerResult(JSON.stringify({ version: "2.0.0-rc.14" }))
        }
        return dockerResult()
      },
    }
    const result = await runDockerImageSmokeCli(
      [
        "--config-digest",
        "sha256:config",
        "--image",
        "candidate:amd64",
        "--timeout-ms",
        "10",
        "--version",
        "2.0.0-rc.14",
      ],
      { dockerRunner, output: { log(): void {} } },
    )
    expect(result.configDigest).toBe("sha256:config")
    expect((await rejectionOf(runDockerImageSmokeCli([]))).message).toContain(
      "--config-digest, --image, and --version are required",
    )
  })

  test("fails before or during runtime when digest, health, or version differs", async () => {
    const configError = await rejectionOf(
      smokeDockerImage(
        {
          configDigest: "sha256:expected",
          image: "candidate:amd64",
          version: "2.0.0-rc.14",
        },
        {
          dockerRunner: {
            run(): DockerRunResult {
              return dockerResult("sha256:other")
            },
          },
        },
      ),
    )
    expect(configError.message).toContain("does not match tested OCI config")

    const runnerFor = (health: string, version: string) => ({
      run(arguments_: string[]): DockerRunResult {
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_[0] === "create") return dockerResult("container-id")
        if (arguments_[0] === "inspect") return dockerResult(health)
        if (arguments_[0] === "exec") {
          return dockerResult(JSON.stringify({ version }))
        }
        return dockerResult()
      },
    })
    expect(
      (
        await rejectionOf(
          smokeDockerImage(
            {
              configDigest: "sha256:config",
              image: "candidate:amd64",
              version: "2.0.0-rc.14",
            },
            { dockerRunner: runnerFor("unhealthy", "2.0.0-rc.14") },
          ),
        )
      ).message,
    ).toContain("health status is unhealthy")
    expect(
      (
        await rejectionOf(
          smokeDockerImage(
            {
              configDigest: "sha256:config",
              image: "candidate:amd64",
              version: "2.0.0-rc.14",
            },
            { dockerRunner: runnerFor("healthy", "2.0.0-rc.13") },
          ),
        )
      ).message,
    ).toContain("runtime reported")
  })
})
