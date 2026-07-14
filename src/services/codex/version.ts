const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const CODEX_VERSION_OUTPUT_PATTERN =
  /\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/iu
const CODEX_VERSION_MAX_LENGTH = 64

export function normalizeCodexVersion(
  value: string | null | undefined,
): string | null {
  const version = value?.trim() ?? ""
  return (
      version.length <= CODEX_VERSION_MAX_LENGTH
        && CODEX_VERSION_PATTERN.test(version)
    ) ?
      version
    : null
}

export function parseInstalledCodexVersion(output: string): string | null {
  return normalizeCodexVersion(output.match(CODEX_VERSION_OUTPUT_PATTERN)?.[1])
}
