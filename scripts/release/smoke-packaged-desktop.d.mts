export interface PackagedDesktopSmokeOptions {
  releaseDirectory: string
  version: string
}

export interface PackagedDesktopSmokeResult {
  serverDirectory: string
  version: string
}

export function smokePackagedDesktop(
  options: PackagedDesktopSmokeOptions,
  dependencies?: Record<string, unknown>,
): PackagedDesktopSmokeResult

export function runPackagedDesktopSmokeCli(
  arguments_: string[],
  dependencies?: Record<string, unknown>,
): PackagedDesktopSmokeResult
