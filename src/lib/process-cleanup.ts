type CleanupHandler = () => void | Promise<void>

const cleanupHandlers = new Set<CleanupHandler>()

let cleanupPromise: Promise<void> | null = null
let cleanupState: "idle" | "running" | "done" = "idle"
let runtimeInitialized = false

/**
 * Cleanup failures are reported through `console.warn` rather than the shared
 * logger: `logger.ts` registers its own flush handler here, so importing it
 * would be circular, and the logger may already be torn down by the time a
 * later handler fails. `logger.ts` reports its own failures the same way.
 */
function reportCleanupFailure(error: unknown): void {
  try {
    console.warn("Process cleanup handler failed:", error)
  } catch {
    // Reporting is best-effort; stdio can already be closed during exit.
  }
}

function initializeProcessCleanupRuntime(): void {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  process.once("beforeExit", () => {
    void runProcessCleanups().catch(reportCleanupFailure)
  })
  process.once("exit", runProcessCleanupsSync)
  process.once("SIGINT", () => {
    void shutdownProcess(0)
  })
  process.once("SIGTERM", () => {
    void shutdownProcess(0)
  })
}

export function runProcessCleanupsSync(): void {
  if (cleanupState !== "idle") {
    return
  }

  cleanupState = "done"
  for (const handler of Array.from(cleanupHandlers)) {
    try {
      // A handler may return a promise that settles after `exit` unwinds; a
      // rejection must not surface as an unhandled rejection.
      void Promise.resolve(handler()).catch(reportCleanupFailure)
    } catch (error) {
      reportCleanupFailure(error)
    }
  }
}

export async function runProcessCleanups(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise
  }

  if (cleanupState === "done") {
    return
  }

  cleanupState = "running"
  cleanupPromise = (async () => {
    for (const handler of Array.from(cleanupHandlers)) {
      try {
        await handler()
      } catch (error) {
        // One failing handler must not skip the handlers registered after it,
        // such as the logger flush.
        reportCleanupFailure(error)
      }
    }
    cleanupState = "done"
  })()

  return cleanupPromise
}

async function shutdownProcess(exitCode: number): Promise<void> {
  try {
    await runProcessCleanups()
  } finally {
    process.exit(exitCode)
  }
}

export function registerProcessCleanup(handler: CleanupHandler): () => void {
  initializeProcessCleanupRuntime()
  cleanupHandlers.add(handler)

  return () => {
    cleanupHandlers.delete(handler)
  }
}

/**
 * Clears registered handlers and run state so each test starts from `idle`.
 * `runtimeInitialized` is deliberately left set: resetting it would re-register
 * the process listeners on every subsequent `registerProcessCleanup` call.
 */
export function resetProcessCleanupStateForTests(): void {
  cleanupHandlers.clear()
  cleanupPromise = null
  cleanupState = "idle"
}
