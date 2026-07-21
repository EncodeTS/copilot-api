export interface TokenLogger {
  debug: (...values: Array<unknown>) => void
  error: (...values: Array<unknown>) => void
  info: (...values: Array<unknown>) => void
  warn: (...values: Array<unknown>) => void
}

export interface TokenSetupOptions {
  signal?: AbortSignal
}

export type TokenSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>
