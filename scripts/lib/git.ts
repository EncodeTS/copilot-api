import { spawnSync } from "node:child_process"

export class GitCommandError extends Error {
  readonly arguments: readonly string[]

  constructor(arguments_: readonly string[], detail: string) {
    const command = arguments_
      .map((argument) => JSON.stringify(argument))
      .join(" ")
    super(`git ${command} failed: ${JSON.stringify(detail)}`)
    this.name = "GitCommandError"
    this.arguments = [...arguments_]
  }
}

export function runGit(repository: string, arguments_: string[]): string {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) {
    throw new GitCommandError(arguments_, result.error.message)
  }
  if (result.status !== 0) {
    throw new GitCommandError(
      arguments_,
      (result.stderr || result.stdout).trim(),
    )
  }

  return result.stdout
}

export function resolveGitCommit(
  repository: string,
  revision = "HEAD",
): string {
  return runGit(repository, ["rev-parse", revision]).trim()
}
