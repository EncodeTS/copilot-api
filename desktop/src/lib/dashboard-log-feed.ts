import { useCallback, useEffect, useState } from 'react'

import type { DesktopApi, LogFeedSnapshot } from '../types/ipc'
import {
  applyLogFeedUpdate,
  createLogFeedState,
  type LogFeedState,
} from './log-feed-state'

export const DASHBOARD_LOG_CAPACITY = 2000

type DashboardLogApi = Pick<
  DesktopApi,
  'clearServerLogs' | 'getServerLogSnapshot' | 'subscribeServerLogs'
>

export interface DashboardLogFeed {
  clear: () => Promise<void>
  entries: LogFeedState['entries']
  refresh: () => Promise<void>
}

export function useDashboardLogFeed(
  api: DashboardLogApi,
  capacity = DASHBOARD_LOG_CAPACITY,
): DashboardLogFeed {
  const [state, setState] = useState(createLogFeedState)
  const applySnapshot = useCallback(
    (snapshot: LogFeedSnapshot) => {
      setState((current) =>
        applyLogFeedUpdate(current, { kind: 'snapshot', snapshot }, capacity),
      )
    },
    [capacity],
  )

  useEffect(
    () =>
      api.subscribeServerLogs((update) => {
        setState((current) => applyLogFeedUpdate(current, update, capacity))
      }),
    [api, capacity],
  )

  const refresh = useCallback(async () => {
    try {
      applySnapshot(await api.getServerLogSnapshot())
    } catch {
      // The next live batch or refresh will reconcile renderer state.
    }
  }, [api, applySnapshot])

  const clear = useCallback(async () => {
    try {
      applySnapshot(await api.clearServerLogs())
    } catch {
      // Keep the last bounded view when the main process is unavailable.
    }
  }, [api, applySnapshot])

  return { clear, entries: state.entries, refresh }
}
