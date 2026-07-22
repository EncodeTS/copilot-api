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
  test("binds the running image config digest and cleans the container", async () => {
    const commands: string[][] = []
    let runtimeConfig = ""
    let runtimeHomeRemoved = false
    const dockerRunner = {
      run(arguments_: string[]): DockerRunResult {
        commands.push(arguments_)
        if (arguments_[0] === "image") return dockerResult("sha256:config\n")
        if (arguments_[0] === "run") return dockerResult("container-id\n")
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
        fileSystem: {
          mkdtempSync(): string {
            return "/tmp/copilot-api-docker-smoke-fixture"
          },
          rmSync(): void {
            runtimeHomeRemoved = true
          },
          writeFileSync(
            _path: fs.PathOrFileDescriptor,
            data: string | NodeJS.ArrayBufferView,
          ): void {
            if (typeof data !== "string") {
              throw new TypeError("expected string Docker smoke config")
            }
            runtimeConfig = data
          },
        },
        processId: 42,
      },
    )

    expect(result).toEqual({
      configDigest: "sha256:config",
      health: "healthy",
      version: "2.0.0-rc.14",
    })
    const runCommand = commands.find(([command]) => command === "run")
    expect(runCommand).toContain("--mount")
    expect(runCommand).toContain(
      "type=bind,source=/tmp/copilot-api-docker-smoke-fixture,target=/tmp/copilot-api-smoke",
    )
    expect(runCommand?.at(-1)).toBe("--desktop-auth-mode=provider")
    expect(runCommand?.join(" ")).not.toContain("GH_TOKEN")
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
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"])
    expect(runtimeHomeRemoved).toBe(true)
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
        if (arguments_[0] === "run") return dockerResult("container-id")
        if (arguments_[0] === "logs") return dockerResult("startup pending")
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
    expect(removed).toBe(true)
  })

  test("cleans the synthetic home when provider config setup fails", async () => {
    let runtimeHomeRemoved = false
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
              return dockerResult()
            },
          },
          fileSystem: {
            mkdtempSync(): string {
              return "/tmp/copilot-api-docker-smoke-fixture"
            },
            rmSync(): void {
              runtimeHomeRemoved = true
            },
            writeFileSync(): never {
              throw new Error("config write refused")
            },
          },
        },
      ),
    )

    expect(error.message).toContain("config write refused")
    expect(runtimeHomeRemoved).toBe(true)
  })

  test("rejects malformed runtime output and surfaces cleanup failure", async () => {
    const responses = (cleanupFails: boolean) => ({
      run(arguments_: string[]): DockerRunResult {
        if (arguments_[0] === "image") return dockerResult("sha256:config")
        if (arguments_[0] === "run") return dockerResult("container-id")
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
        if (arguments_[0] === "run") return dockerResult("container-id")
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
        if (arguments_[0] === "run") return dockerResult("container-id")
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
