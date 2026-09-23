import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const repository = path.resolve(import.meta.dir, "..")
const dataPath = "/home/bun/.local/share/copilot-api"
const fixtures: string[] = []
const decoder = new TextDecoder()

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

function runEntrypoint(
  args: string[],
  options: {
    environment?: NodeJS.ProcessEnv
    prepare?: (fixture: string, home: string) => void
  } = {},
): { exitCode: number; stderr: string; stdout: string } {
  const fixture = fs.mkdtempSync(
    path.join(repository, "tests", ".docker-entrypoint-fixture-"),
  )
  fixtures.push(fixture)
  const home = path.join(fixture, "data")
  fs.mkdirSync(home, { mode: 0o700 })
  options.prepare?.(fixture, home)
  const fakeBun = path.join(fixture, "bun")
  fs.writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
    mode: 0o755,
  })
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      "./entrypoint.sh",
      ...args.map((arg) =>
        arg
          .replaceAll("<HOME>", home)
          .replaceAll("<ALTERNATE>", path.join(fixture, "alternate")),
      ),
    ],
    cwd: repository,
    env: {
      ...process.env,
      COPILOT_API_HOME: home,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      COPILOT_API_CODEX_MODEL_CATALOG_PATH: "",
      COPILOT_API_DESKTOP_SETTINGS_PATH: path.join(home, "desktop-config.json"),
      COPILOT_API_SQLITE_DB_PATH: "",
      COPILOT_API_GITHUB_TOKEN: "test-only-environment-sentinel",
      GH_TOKEN: "legacy-test-sentinel",
      PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ""}`,
      ...options.environment,
    },
  })
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  }
}

describe("Docker runtime contract", () => {
  test("keeps the image non-root, private, persistent, and health-checked", () => {
    const dockerfile = fs.readFileSync(
      path.join(repository, "Dockerfile"),
      "utf8",
    )
    expect(dockerfile).toContain(`COPILOT_API_HOME=${dataPath}`)
    expect(dockerfile).toContain(`VOLUME ["${dataPath}"]`)
    expect(dockerfile).toMatch(/chown -R bun:bun \/home\/bun/u)
    expect(dockerfile).toContain("chmod 0700 /home/bun/.local")
    expect(dockerfile).toMatch(/USER bun\s+ENTRYPOINT/u)
    expect(dockerfile).toContain("CMD wget --spider -q http://127.0.0.1:4141/")
    const entrypoint = fs.readFileSync(
      path.join(repository, "entrypoint.sh"),
      "utf8",
    )
    expect(entrypoint).not.toMatch(/-g "\$GH_TOKEN"|--github-token.*GH_TOKEN/u)
    expect(entrypoint).toContain(
      'check_existing_directory "$data_dir" || data_error',
    )
    expect(entrypoint).toContain("--api-home=*)")
    expect(entrypoint).toContain('data_dir="${arg#*=}"')
    expect(entrypoint).toContain(
      'check_managed_backups "$auth_dir/${token_prefix}github_token"',
    )
    expect(entrypoint).toContain('for file in "$1" "$1.bak" "$1.backup"')
    expect(entrypoint).toContain('"$db_path" "$db_path-wal" "$db_path-shm"')
    expect(entrypoint).not.toContain('for item in "$1"/*')
    expect(entrypoint).toContain("stat -c %u")
    expect(entrypoint).toContain("stat -c %a")
    expect(entrypoint).toContain('has_private_mode "$1" 700')
    expect(entrypoint).toContain('has_private_mode "$1" 600')
    expect(entrypoint).toContain("Fix bind-mount ownership/permissions")
    expect(entrypoint).toContain(
      'exec bun --use-system-ca run dist/main.js auth "$@"',
    )
    expect(entrypoint).toContain(
      'exec bun --use-system-ca run dist/main.js start "$@"',
    )
    expect(entrypoint).toContain(
      'exec bun --use-system-ca run dist/main.js "$@"',
    )
  })

  test("documents how to remount existing data under the new UID and path", () => {
    for (const readme of ["README.md", "README.zh-CN.md"]) {
      const text = fs.readFileSync(path.join(repository, readme), "utf8")
      expect(text).toContain("chown -R 1000:1000 ./copilot-data")
      expect(text).toContain(`copilot-data:${dataPath}`)
      expect(text).toContain("COPILOT_API_GITHUB_TOKEN")
      expect(text).toContain("/root/.local/share/copilot-api")
      expect(text).toContain("copilot-api start --lan")
      expect(text).toContain("copilot-api auth login --provider copilot")
      expect(text).toContain("--api-home=/data")
      expect(text).toContain(
        "sudo find ./copilot-data -type d -exec chmod 700 {} +",
      )
      expect(text).toContain(
        "sudo find ./copilot-data -type f -exec chmod 600 {} +",
      )
    }
  })

  test.skipIf(process.platform === "win32")(
    "forwards start and auth arguments without inserting the inherited credential",
    () => {
      const start = runEntrypoint([
        "--desktop-auth-mode=provider",
        "--port",
        "5151",
      ])
      expect(start.exitCode).toBe(0)
      expect(start.stdout.trim().split("\n")).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
        "start",
        "--desktop-auth-mode=provider",
        "--port",
        "5151",
      ])
      expect(start.stdout).not.toContain("test-only-environment-sentinel")
      expect(start.stdout).not.toContain("legacy-test-sentinel")

      const auth = runEntrypoint(["--auth", "login", "--provider", "copilot"])
      expect(auth.exitCode).toBe(0)
      expect(auth.stdout.trim().split("\n")).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
        "auth",
        "login",
        "--provider",
        "copilot",
      ])

      expect(
        runEntrypoint(["start", "--port", "5151"]).stdout.trim().split("\n"),
      ).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
        "start",
        "--port",
        "5151",
      ])
      expect(
        runEntrypoint(["auth", "login", "--provider", "codex"])
          .stdout.trim()
          .split("\n"),
      ).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
        "auth",
        "login",
        "--provider",
        "codex",
      ])
      const prefixed = runEntrypoint([
        "--api-home=<ALTERNATE>",
        "start",
        "--port",
        "5152",
      ])
      expect(prefixed.exitCode).toBe(0)
      const prefixedArgs = prefixed.stdout.trim().split("\n")
      expect(prefixedArgs.slice(0, 3)).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
      ])
      expect(prefixedArgs[3]).toMatch(/^--api-home=.*alternate$/u)
      expect(prefixedArgs.slice(4)).toEqual(["start", "--port", "5152"])
      const explicitAuth = runEntrypoint([
        "--api-home=<ALTERNATE>",
        "auth",
        "login",
      ])
      expect(explicitAuth.exitCode).toBe(0)
      expect(explicitAuth.stdout.trim().split("\n").slice(-2)).toEqual([
        "auth",
        "login",
      ])
      const splitHome = runEntrypoint(["start", "--api-home", "<ALTERNATE>"])
      expect(splitHome.exitCode).toBe(0)
      expect(splitHome.stdout.trim().split("\n")[3]).toBe("start")
      const duplicate = runEntrypoint([
        "--api-home=<ALTERNATE>",
        "--api-home=<HOME>",
        "start",
      ])
      expect(duplicate.exitCode).toBe(2)
      expect(duplicate.stderr).not.toContain("alternate")
    },
  )

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails safely for inaccessible managed state under the effective CLI home",
    () => {
      const result = runEntrypoint(["start", "--api-home=<ALTERNATE>"], {
        prepare(fixture) {
          const alternate = path.join(fixture, "alternate")
          fs.mkdirSync(alternate, { mode: 0o700 })
          const file = path.join(alternate, "config.json")
          fs.writeFileSync(file, "fixture", { mode: 0o400 })
          fs.chmodSync(file, 0o400)
        },
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("Fix bind-mount ownership/permissions")
      expect(result.stderr).not.toContain("github_token")
      expect(result.stderr).not.toContain("fixture")
      expect(result.stderr).not.toContain("test-only-environment-sentinel")
    },
  )

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "checks active OAuth and enterprise GitHub credential paths",
    () => {
      const result = runEntrypoint(
        ["start", "--oauth-app=other-app", "--enterprise-url=example.test"],
        {
          prepare(_fixture, home) {
            const authDir = path.join(home, "other-app")
            fs.mkdirSync(authDir, { mode: 0o700 })
            const file = path.join(authDir, "ent_github_token")
            fs.writeFileSync(file, "fixture", { mode: 0o400 })
            fs.chmodSync(file, 0o400)
          },
        },
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).not.toContain("ent_github_token")
    },
  )

  test.skipIf(process.platform === "win32")(
    "rejects a bun-owned 0755 mounted home and 0644 GitHub token without leaking either",
    () => {
      const publicDirectory = runEntrypoint(["start"], {
        prepare(_fixture, home) {
          fs.chmodSync(home, 0o755)
        },
      })
      expect(publicDirectory.exitCode).not.toBe(0)
      expect(publicDirectory.stdout).toBe("")
      expect(publicDirectory.stderr).toContain("directories 0700, files 0600")
      expect(publicDirectory.stderr).not.toContain(
        "test-only-environment-sentinel",
      )
      expect(publicDirectory.stderr).not.toContain(
        ".docker-entrypoint-fixture-",
      )

      const publicToken = runEntrypoint(["auth", "login"], {
        prepare(_fixture, home) {
          const token = path.join(home, "github_token")
          fs.writeFileSync(token, "fixture", { mode: 0o644 })
          fs.chmodSync(token, 0o644)
        },
      })
      expect(publicToken.exitCode).not.toBe(0)
      expect(publicToken.stdout).toBe("")
      expect(publicToken.stderr).not.toContain("github_token")
      expect(publicToken.stderr).not.toContain("fixture")
    },
  )

  test.skipIf(process.platform === "win32")(
    "accepts private 0700 home and 0600 managed state",
    () => {
      const result = runEntrypoint(["start"], {
        prepare(_fixture, home) {
          const token = path.join(home, "github_token")
          fs.writeFileSync(token, "fixture", { mode: 0o600 })
          fs.chmodSync(token, 0o600)
          fs.chmodSync(home, 0o700)
        },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("\nstart\n")
    },
  )

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "does not traverse unrelated large-volume content",
    () => {
      const result = runEntrypoint(["start"], {
        prepare(_fixture, home) {
          const unrelated = path.join(home, "unmanaged-data")
          fs.mkdirSync(unrelated, { mode: 0o700 })
          fs.writeFileSync(path.join(unrelated, "archive"), "fixture", {
            mode: 0o400,
          })
        },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("\nstart\n")
    },
  )
})
