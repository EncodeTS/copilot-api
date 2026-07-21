import { describe, expect, test } from 'bun:test'

import { createApplicationShutdownBarrier } from '../electron/application-shutdown'
import type { ServerStopOutcome } from '../../shared-types'

function stoppedOutcome(statusRevision: number): ServerStopOutcome {
  return {
    status: {
      owned: false,
      port: 4510,
      running: false,
      statusRevision,
    },
    stopped: true,
  }
}

describe('Desktop application shutdown barrier', () => {
  test('before-quit waits for one successful stop before clearing and quitting', async () => {
    let finishStop: ((outcome: ServerStopOutcome) => void) | undefined
    const stop = new Promise<ServerStopOutcome>((resolve) => {
      finishStop = resolve
    })
    let clearCalls = 0
    let preventCalls = 0
    let quitCalls = 0
    const barrier = createApplicationShutdownBarrier({
      clearCallbacks: () => {
        clearCalls += 1
      },
      quit: () => {
        quitCalls += 1
      },
      stopServer: () => stop,
    })

    barrier.handleBeforeQuit({
      preventDefault: () => {
        preventCalls += 1
      },
    })
    expect(preventCalls).toBe(1)
    expect(clearCalls).toBe(0)
    expect(quitCalls).toBe(0)

    const completion = barrier.requestQuit()
    finishStop?.(stoppedOutcome(1))
    await expect(completion).resolves.toBeTrue()

    expect(barrier.isComplete()).toBeTrue()
    expect(clearCalls).toBe(1)
    expect(quitCalls).toBe(1)
    await barrier.requestQuit()
    expect(clearCalls).toBe(1)
    expect(quitCalls).toBe(1)
  })

  test('a stop timeout keeps callbacks and the application alive for retry', async () => {
    let stopCalls = 0
    let clearCalls = 0
    let quitCalls = 0
    const barrier = createApplicationShutdownBarrier({
      clearCallbacks: () => {
        clearCalls += 1
      },
      quit: () => {
        quitCalls += 1
      },
      stopServer: () => {
        stopCalls += 1
        return Promise.resolve(
          stopCalls === 1 ?
            {
              error: 'localized stop timeout',
              reason: 'timeout' as const,
              status: {
                error: 'localized stop timeout',
                owned: true,
                port: 4510,
                running: true,
                statusRevision: 1,
              },
              stopped: false as const,
            }
          : stoppedOutcome(2),
        )
      },
    })

    await expect(barrier.requestQuit()).resolves.toBeFalse()
    expect(clearCalls).toBe(0)
    expect(quitCalls).toBe(0)
    expect(barrier.isComplete()).toBeFalse()

    await expect(barrier.requestQuit()).resolves.toBeTrue()
    expect(clearCalls).toBe(1)
    expect(quitCalls).toBe(1)
  })
})
