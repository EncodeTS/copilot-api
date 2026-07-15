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
  expect(workflow).toContain("vars.ENABLE_NPM_PUBLISH == 'true'")
  expect(workflow).toContain("npm@11.17.0")
  expect(workflow).toContain("npm publish --access public")
  expect(workflow).not.toContain("NPM_TOKEN")
  expect(workflow).not.toContain("NODE_AUTH_TOKEN")
})
