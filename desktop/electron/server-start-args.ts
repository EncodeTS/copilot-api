export function buildServerStartArgs(
  port: number,
  githubToken?: string | null
): string[] {
  const args = ['start', '--port', String(port)]
  const normalizedToken = githubToken?.trim()

  if (normalizedToken) {
    args.push('--github-token', normalizedToken)
  }

  return args
}
