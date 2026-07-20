import { createRequestGeneration } from './request-generation'

export interface DashboardRefreshRun<T> {
  apply: (value: T) => void
  load: () => Promise<T>
  onError?: (error: unknown) => void
  setLoading: (loading: boolean) => void
}

export interface DashboardRefreshController {
  invalidate: () => void
  run: <T>(refresh: DashboardRefreshRun<T>) => Promise<void>
}

export const DASHBOARD_REFRESH_LANES = [
  'dashboard',
  'token_usage_summary',
  'token_usage_events',
] as const

export type DashboardRefreshLane = (typeof DASHBOARD_REFRESH_LANES)[number]

export interface DashboardRefreshOrchestrator {
  invalidateAll: () => void
  run: <T>(
    lane: DashboardRefreshLane,
    refresh: DashboardRefreshRun<T>,
  ) => Promise<void>
}

export function createDashboardRefreshController(): DashboardRefreshController {
  const generation = createRequestGeneration()
  let activeLoadingSetter: ((loading: boolean) => void) | null = null

  return {
    invalidate: () => {
      generation.invalidate()
      activeLoadingSetter?.(false)
      activeLoadingSetter = null
    },
    run: async <T>(refresh: DashboardRefreshRun<T>) => {
      const requestGeneration = generation.begin()
      activeLoadingSetter = refresh.setLoading
      refresh.setLoading(true)
      try {
        const value = await refresh.load()
        if (generation.isCurrent(requestGeneration)) {
          refresh.apply(value)
        }
      } catch (error) {
        if (generation.isCurrent(requestGeneration)) {
          refresh.onError?.(error)
        }
      } finally {
        if (generation.isCurrent(requestGeneration)) {
          activeLoadingSetter = null
          refresh.setLoading(false)
        }
      }
    },
  }
}

export function createDashboardRefreshOrchestrator(): DashboardRefreshOrchestrator {
  const controllers = new Map<DashboardRefreshLane, DashboardRefreshController>(
    DASHBOARD_REFRESH_LANES.map((lane) => [
      lane,
      createDashboardRefreshController(),
    ]),
  )

  return {
    invalidateAll: () => {
      for (const controller of controllers.values()) {
        controller.invalidate()
      }
    },
    run: (lane, refresh) => controllers.get(lane)!.run(refresh),
  }
}
