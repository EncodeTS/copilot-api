import { expect, test } from "bun:test"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")

interface PackageManifest {
  files?: Array<string>
  name?: string
  private?: boolean
  publishConfig?: { access?: string }
  scripts?: Record<string, string>
}

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface ReleaseWorkflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>
}

test("publishes the EncodeTS CLI under the owned npm scope", async () => {
  const packageJson = (await Bun.file(
    path.join(repositoryRoot, "package.json"),
  ).json()) as PackageManifest

  expect(packageJson.name).toBe("@encodets/copilot-api")
  expect(packageJson.private).not.toBe(true)
  expect(packageJson.publishConfig).toEqual({ access: "public" })
  expect(packageJson.files).toContain("NOTICE.md")
  expect(packageJson.scripts?.release).toBeUndefined()
})

test("documents only the EncodeTS npm package", async () => {
  for (const fileName of [
    "README.md",
    "README.zh-CN.md",
    path.join("src", "lib", "sqlite.ts"),
    path.join("plugin", "claude", "tool-search", ".mcp.json"),
  ]) {
    const content = await Bun.file(path.join(repositoryRoot, fileName)).text()
    expect(content).toContain("@encodets/copilot-api@rc")
    expect(content).not.toContain("@jeffreycao/copilot-api")
  }
})

test("keeps npm publishing OIDC-only and explicitly gated", async () => {
  const workflow = await Bun.file(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
  ).text()

  expect(workflow).toContain("id-token: write")
  expect(workflow).toContain("if: ${{ vars.ENABLE_NPM_PUBLISH == 'true' }}")
  expect(workflow).not.toContain("contains(github.ref_name, '-r')")
  expect(workflow).toContain("npm@11.17.0")
  expect(workflow).toContain("npm publish --access public")
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toContain("NODE_AUTH_TOKEN")
})

test("publishes exactly one downloaded quality-built local tarball", async () => {
  const workflowPath = path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "release.yml",
  )
  const workflowSource = await Bun.file(workflowPath).text()
  const workflow = Bun.YAML.parse(workflowSource) as ReleaseWorkflow
  const qualitySteps = workflow.jobs.quality?.steps ?? []
  const publishSteps = workflow.jobs["publish-npm"]?.steps ?? []
  const build = qualitySteps.find(
    (step) => step.name === "Build npm publication artifact",
  )
  const upload = qualitySteps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  )
  const download = publishSteps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  )
  const publish = publishSteps.find(
    (step) => step.name === "Publish the quality-built tarball with OIDC",
  )

  expect(build?.run).toContain(
    "test \"$(find release-artifacts/npm -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')\" = \"1\"",
  )
  expect(upload?.with).toEqual({
    "if-no-files-found": "error",
    name: "npm-package-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "release-artifacts/npm/*.tgz",
    "retention-days": 7,
  })
  expect(download?.with).toEqual({
    name: "npm-package-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "npm-package",
  })
  expect(publish?.run).toContain("tarballs=(./npm-package/*.tgz)")
  expect(publish?.run).toContain('test "${#tarballs[@]}" -eq 1')
  expect(publish?.run).toContain('"${tarballs[0]}"')
  expect(publish?.run).not.toContain(" npm-package/*.tgz")
})
