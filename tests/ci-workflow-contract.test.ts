import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import path from "node:path"

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  "working-directory"?: string
}

type WorkflowJob = {
  if?: string
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}

type Workflow = {
  jobs: Record<string, WorkflowJob>
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const repository = path.join(import.meta.dir, "..")

async function readWorkflow(name: string): Promise<Workflow> {
  const source = await Bun.file(
    path.join(repository, ".github", "workflows", name),
  ).text()
  return Bun.YAML.parse(source) as Workflow
}

describe("CI workflow environment contract", () => {
  test("installs both frozen dependency trees before the Linux full suite", async () => {
    const workflow = await readWorkflow("ci.yml")
    const steps = workflow.jobs["linux-quality"].steps ?? []
    const commands = steps.map((step) => ({
      command: step.run,
      directory: step["working-directory"],
      name: step.name,
    }))
    const rootInstall = commands.findIndex(
      (step) =>
        step.name === "Install root dependencies"
        && step.command === "bun install --frozen-lockfile"
        && step.directory === undefined,
    )
    const desktopInstall = commands.findIndex(
      (step) =>
        step.name === "Install Desktop dependencies"
        && step.command === "bun install --frozen-lockfile"
        && step.directory === "desktop",
    )
    const fullSuite = commands.findIndex(
      (step) =>
        step.name === "Run hermetic full suite" && step.command === "bun test",
    )

    expect(rootInstall).toBeGreaterThan(-1)
    expect(desktopInstall).toBeGreaterThan(rootInstall)
    expect(fullSuite).toBeGreaterThan(desktopInstall)
  })

  test("disables Chromium sandbox only for the synthetic Electron smoke", async () => {
    const {
      buildElectronZstdSmokeArguments,
      parseElectronZstdSmokeSourceDist,
    } = await import("../scripts/release/electron-zstd-smoke-command.mjs")
    const probe = path.join(
      import.meta.dir,
      "fixtures",
      "electron-zstd-smoke-argv-probe.mjs",
    )
    const sourceDistCases = [
      "/repo/dist with spaces/$dollar;[brackets]&pipe|glob*?",
      String.raw`C:\Program Files\Copilot API\dist & cache\[x]`,
    ]

    for (const sourceDist of sourceDistCases) {
      const launchArguments = buildElectronZstdSmokeArguments(
        "/repo/scripts/smoke.mjs",
        sourceDist,
      )
      const realisticChildArgv = [
        "/repo/desktop/node_modules/electron/dist/electron",
        "--enable-logging",
        ...launchArguments,
      ]

      expect(launchArguments).toEqual([
        "--no-sandbox",
        "/repo/scripts/smoke.mjs",
        `--copilot-api-zstd-source-dist=${sourceDist}`,
      ])
      expect(parseElectronZstdSmokeSourceDist(realisticChildArgv)).toBe(
        sourceDist,
      )
      expect(
        execFileSync(
          process.execPath,
          [probe, "--enable-logging", ...launchArguments],
          { encoding: "utf8" },
        ),
      ).toBe(sourceDist)
    }

    expect(() =>
      buildElectronZstdSmokeArguments("/repo/scripts/smoke.mjs", ""),
    ).toThrow("source dist must not be empty")
    expect(() =>
      execFileSync(
        process.execPath,
        [probe, "--enable-logging", "--no-sandbox", "/repo/scripts/smoke.mjs"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow()

    const workflow = await readWorkflow("ci.yml")
    const smoke = workflow.jobs["desktop-package-closure"].steps?.find(
      (step) => step.name === "Verify Electron zstd utility-process runtime",
    )
    expect(smoke?.run).toBe(
      "xvfb-run --auto-servernum bun run --cwd desktop smoke:server-zstd",
    )
  })

  test("rejects ambiguous named Electron smoke dist arguments", async () => {
    const { parseElectronZstdSmokeSourceDist } = await import(
      "../scripts/release/electron-zstd-smoke-command.mjs"
    )
    const probe = path.join(
      import.meta.dir,
      "fixtures",
      "electron-zstd-smoke-argv-probe.mjs",
    )
    expect(() =>
      parseElectronZstdSmokeSourceDist([
        "electron",
        "--no-sandbox",
        "/repo/scripts/smoke.mjs",
      ]),
    ).toThrow("exactly one named source dist")
    expect(() =>
      parseElectronZstdSmokeSourceDist([
        "electron",
        "--copilot-api-zstd-source-dist=",
      ]),
    ).toThrow("source dist must not be empty")
    expect(() =>
      parseElectronZstdSmokeSourceDist([
        "electron",
        "--copilot-api-zstd-source-dist=/repo/first",
        "--copilot-api-zstd-source-dist=/repo/second",
      ]),
    ).toThrow("exactly one named source dist")
    expect(() =>
      execFileSync(
        process.execPath,
        [
          probe,
          "--copilot-api-zstd-source-dist=/repo/first",
          "--copilot-api-zstd-source-dist=/repo/second",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow()
  })

  test("skips Pages deployment until the repository explicitly opts in", async () => {
    const workflow = await readWorkflow("deploy-pages.yml")
    const deploy = workflow.jobs.deploy

    expect(workflow.on).toEqual({
      push: { branches: ["master"] },
      workflow_dispatch: null,
    })
    expect(workflow.permissions).toEqual({ contents: "read" })
    expect(deploy.if).toBe(
      "${{ github.ref == 'refs/heads/master' && vars.ENABLE_PAGES_DEPLOY == 'true' }}",
    )
    expect(deploy.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      pages: "write",
    })
  })

  test("pins every CI, audit, and Pages action with a weekly renovation path", async () => {
    const approvedPins = new Map([
      [
        "actions/checkout",
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
      ],
      [
        "actions/configure-pages",
        "actions/configure-pages@1f0c5cde4bc74cd7e1254d0cb4de8d49e9068c7d",
      ],
      [
        "actions/deploy-pages",
        "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
      ],
      [
        "actions/setup-node",
        "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
      ],
      [
        "actions/upload-artifact",
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      ],
      [
        "actions/upload-pages-artifact",
        "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa",
      ],
      [
        "oven-sh/setup-bun",
        "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      ],
    ])

    for (const workflowName of [
      "ci.yml",
      "dependency-audit.yml",
      "deploy-pages.yml",
    ]) {
      const workflow = await readWorkflow(workflowName)
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.uses) continue
          const action = step.uses.split("@")[0]
          const approvedPin = approvedPins.get(action)
          if (!approvedPin) {
            throw new Error(`${workflowName}: unreviewed action ${action}`)
          }
          expect(step.uses, `${workflowName}: ${action}`).toBe(approvedPin)
        }
      }
    }

    const dependabotSource = await Bun.file(
      path.join(repository, ".github", "dependabot.yml"),
    ).text()
    const dependabot = Bun.YAML.parse(dependabotSource) as {
      updates: Array<{
        directory?: string
        "package-ecosystem"?: string
        schedule?: { interval?: string }
      }>
    }
    const githubActionsUpdates = dependabot.updates.filter(
      (update) => update["package-ecosystem"] === "github-actions",
    )
    expect(githubActionsUpdates).toHaveLength(1)
    expect(githubActionsUpdates[0]?.directory).toBe("/")
    expect(githubActionsUpdates[0]?.schedule?.interval).toBe("weekly")
  })
})
