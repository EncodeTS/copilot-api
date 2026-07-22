import type { ServerStopOutcome } from '../../shared-types'

interface ApplicationShutdownDependencies {
  clearCallbacks: () => Promise<void> | void
  quit: () => void
  stopServer: () => Promise<ServerStopOutcome>
}

export interface ApplicationShutdownBarrier {
  handleBeforeQuit: (event: { preventDefault: () => void }) => void
  isComplete: () => boolean
  requestQuit: () => Promise<boolean>
}

export function createApplicationShutdownBarrier(
  dependencies: ApplicationShutdownDependencies,
): ApplicationShutdownBarrier {
  let complete = false
  let quitRequested = false
  let shutdown: Promise<boolean> | null = null

  const ensureStopped = (): Promise<boolean> => {
    if (complete) return Promise.resolve(true)
    shutdown ??= (async () => {
      try {
        const outcome = await dependencies.stopServer()
        if (!outcome.stopped) return false
        await dependencies.clearCallbacks()
        complete = true
        return true
      } catch {
        return false
      } finally {
        if (!complete) shutdown = null
      }
    })()
    return shutdown
  }

  const requestQuit = async (): Promise<boolean> => {
    if (!(await ensureStopped())) return false
    if (!quitRequested) {
      quitRequested = true
      dependencies.quit()
    }
    return true
  }

  return {
    handleBeforeQuit: (event) => {
      if (complete) return
      event.preventDefault()
      void requestQuit()
    },
    isComplete: () => complete,
    requestQuit,
  }
}
