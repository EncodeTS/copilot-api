import { describe, expect, test } from 'bun:test'

import { createEffectLifecycleGuard } from '../src/lib/effect-lifecycle-guard'

describe('effect lifecycle guard', () => {
  test('rejects callbacks from the retired setup during StrictMode effect replay', () => {
    const guard = createEffectLifecycleGuard()
    const firstSetup = guard.begin()

    guard.end(firstSetup)
    const replayedSetup = guard.begin()

    expect(guard.isCurrent(firstSetup)).toBeFalse()
    expect(guard.isCurrent(replayedSetup)).toBeTrue()
    guard.end(firstSetup)
    expect(guard.current()).toBe(replayedSetup)
    guard.end(replayedSetup)
    expect(guard.current()).toBeNull()
  })
})
