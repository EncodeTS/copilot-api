import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitCommandError, resolveGitCommit, runGit } from "../scripts/lib/git"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "git-harness-"))
  temporaryDirectories.push(repository)
  runGit(repository, ["init", "--quiet"])
  runGit(repository, ["config", "user.email", "git@example.invalid"])
  runGit(repository, ["config", "user.name", "Git Harness Test"])
  writeFileSync(join(repository, "fixture.txt"), "fixture\n")
  runGit(repository, ["add", "fixture.txt"])
  runGit(repository, ["commit", "--quiet", "-m", "fixture"])
  return repository
}

describe("shared Git command seam", () => {
  test("resolves the exact benchmark commit", () => {
    const repository = createRepository()

    expect(resolveGitCommit(repository)).toMatch(/^[0-9a-f]{40}$/)
  })

  test("uses one typed and control-safe error surface", () => {
    const repository = createRepository()
    const invalidRevision = "missing\nrevision"

    try {
      runGit(repository, ["rev-parse", invalidRevision])
      throw new Error("expected Git command to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).arguments).toEqual([
        "rev-parse",
        invalidRevision,
      ])
      expect((error as Error).message).toContain('"missing\\nrevision"')
      expect((error as Error).message).not.toContain("missing\nrevision")
    }
  })
})
