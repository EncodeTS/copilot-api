import { describe, expect, test } from 'bun:test'

import { getCopilotUsageLastSuccessAt } from '../src/lib/copilot-usage-display'
import {
  createDashboardRefreshController,
  createDashboardRefreshOrchestrator,
  type DashboardRefreshLane,
} from '../src/lib/dashboard-refresh-controller'
import { createRequestGeneration } from '../src/lib/request-generation'

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve: (value: T) => resolve?.(value) }
}

describe('request generation', () => {
  test('only the newest dashboard refresh can apply its result', () => {
    const generation = createRequestGeneration()
    const olderRequest = generation.begin()
    const newerRequest = generation.begin()

    expect(generation.isCurrent(olderRequest)).toBe(false)
    expect(generation.isCurrent(newerRequest)).toBe(true)

    generation.invalidate()
    expect(generation.isCurrent(newerRequest)).toBe(false)
  })
})

describe('Copilot usage refresh timestamp', () => {
  test('stale data keeps the earlier successful refresh timestamp', () => {
    expect(
      getCopilotUsageLastSuccessAt({
        _copilot_api: {
          error_code: 'upstream_error',
          freshness: 'stale',
          last_attempt_at_ms: 1_500,
          last_success_at_ms: 1_000,
          stale_since_at_ms: 1_500,
        },
      }),
    ).toBe(1_000)
    expect(getCopilotUsageLastSuccessAt({})).toBeNull()
  })
})

describe('Dashboard refresh controller', () => {
  test('overlapping refreshes apply only the newest result and keep loading until it settles', async () => {
    const controller = createDashboardRefreshController()
    const older = deferred<string>()
    const newer = deferred<string>()
    const applied: string[] = []
    const loading: boolean[] = []
    const run = (load: () => Promise<string>) =>
      controller.run({
        apply: (value) => applied.push(value),
        load,
        setLoading: (value) => loading.push(value),
      })

    const olderRun = run(() => older.promise)
    const newerRun = run(() => newer.promise)
    older.resolve('older')
    await olderRun

    expect(applied).toEqual([])
    expect(loading.at(-1)).toBe(true)

    newer.resolve('newer')
    await newerRun
    expect(applied).toEqual(['newer'])
    expect(loading.at(-1)).toBe(false)
  })

  test('stop invalidation clears loading and suppresses the pending result', async () => {
    const controller = createDashboardRefreshController()
    const pending = deferred<string>()
    const applied: string[] = []
    let loading = false
    const run = controller.run({
      apply: (value) => applied.push(value),
      load: () => pending.promise,
      setLoading: (value) => {
        loading = value
      },
    })

    controller.invalidate()
    expect(loading).toBe(false)
    pending.resolve('stopped-result')
    await run
    expect(applied).toEqual([])
  })

  test('restart invalidation allows a replacement fetch even while the old run remains pending', async () => {
    const controller = createDashboardRefreshController()
    const oldServer = deferred<string>()
    const restartedServer = deferred<string>()
    const applied: string[] = []
    const setLoading = () => {}

    const oldRun = controller.run({
      apply: (value) => applied.push(value),
      load: () => oldServer.promise,
      setLoading,
    })
    controller.invalidate()
    const replacementRun = controller.run({
      apply: (value) => applied.push(value),
      load: () => restartedServer.promise,
      setLoading,
    })

    oldServer.resolve('old-server')
    restartedServer.resolve('restarted-server')
    await Promise.all([oldRun, replacementRun])
    expect(applied).toEqual(['restarted-server'])
  })

  test('stop clears and restart replaces dashboard, token summary, and token events lanes', async () => {
    const orchestrator = createDashboardRefreshOrchestrator()
    const lanes: DashboardRefreshLane[] = [
      'dashboard',
      'token_usage_summary',
      'token_usage_events',
    ]
    const oldLoads = new Map(
      lanes.map((lane) => [lane, deferred<string>()] as const),
    )
    const replacementLoads = new Map(
      lanes.map((lane) => [lane, deferred<string>()] as const),
    )
    const applied = new Map<DashboardRefreshLane, string[]>()
    const loading = new Map<DashboardRefreshLane, boolean>()
    const run = (lane: DashboardRefreshLane, load: () => Promise<string>) =>
      orchestrator.run(lane, {
        apply: (value) =>
          applied.set(lane, [...(applied.get(lane) ?? []), value]),
        load,
        setLoading: (value) => loading.set(lane, value),
      })

    const oldRuns = lanes.map((lane) =>
      run(lane, () => oldLoads.get(lane)!.promise),
    )
    orchestrator.invalidateAll()
    expect(lanes.map((lane) => loading.get(lane))).toEqual([
      false,
      false,
      false,
    ])

    const replacementRuns = lanes.map((lane) =>
      run(lane, () => replacementLoads.get(lane)!.promise),
    )
    for (const lane of lanes) {
      oldLoads.get(lane)!.resolve(`old-${lane}`)
      replacementLoads.get(lane)!.resolve(`new-${lane}`)
    }
    await Promise.all([...oldRuns, ...replacementRuns])

    for (const lane of lanes) {
      expect(applied.get(lane)).toEqual([`new-${lane}`])
      expect(loading.get(lane)).toBe(false)
    }
  })
})
