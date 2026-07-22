import { describe, expect, test } from 'bun:test'
import { createElement, StrictMode } from 'react'
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer'

import {
  useDashboardLogFeed,
  type DashboardLogFeed,
} from '../src/lib/dashboard-log-feed'
import type {
  DesktopApi,
  LogFeedUpdate,
  ServerStatus,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsageSummary,
  TokenUsageTotals,
} from '../../shared-types'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import DashboardPage from '../src/pages/DashboardPage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type DashboardLogApi = Pick<
  DesktopApi,
  'clearServerLogs' | 'getServerLogSnapshot' | 'subscribeServerLogs'
>

let observedFeed: DashboardLogFeed | undefined

function LogHarness({ api }: { api: DashboardLogApi }) {
  observedFeed = useDashboardLogFeed(api, 3)
  return createElement(
    'ol',
    null,
    observedFeed.entries.map((entry) =>
      createElement('li', { key: entry.cursor }, entry.message),
    ),
  )
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : renderedText(child)))
    .join('')
}

function createRunningDashboardApi(
  overrides: Partial<DesktopApi> = {},
): DesktopApi {
  let statusRevision = 0
  return {
    clearServerLogs: () => Promise.resolve({ cursor: 0, entries: [] }),
    fetchModels: () => Promise.resolve({ data: [] }),
    fetchTokenUsage: () => Promise.resolve(null),
    fetchTokenUsageDaily: () => Promise.resolve(null),
    fetchTokenUsageEvents: () => Promise.resolve(null),
    getServerAuthInfo: () => Promise.resolve({ enabled: false }),
    getServerLogSnapshot: () => Promise.resolve({ cursor: 0, entries: [] }),
    getServerStatus: () =>
      Promise.resolve(
        createServerStatus(statusRevision, { owned: true, running: true }),
      ),
    onServerStatus: () => () => undefined,
    onWindowMaximizeChange: () => () => undefined,
    platform: 'darwin',
    startServer: () =>
      Promise.resolve(
        createServerStatus(++statusRevision, { owned: true, running: true }),
      ),
    stopServer: () =>
      Promise.resolve({
        status: createServerStatus(++statusRevision),
        stopped: true,
      }),
    subscribeServerLogs: () => () => undefined,
    windowIsMaximized: () => Promise.resolve(false),
    ...overrides,
  } as unknown as DesktopApi
}

function createServerStatus(
  statusRevision: number,
  overrides: Partial<Omit<ServerStatus, 'statusRevision'>> = {},
): ServerStatus {
  return {
    owned: false,
    port: 4510,
    running: false,
    statusRevision,
    ...overrides,
  }
}

async function mountDashboard(
  api: DesktopApi,
  strictMode = false,
  authMode: 'copilot' | 'provider' = 'provider',
): Promise<{
  cleanup: () => void
  renderer: ReactTestRenderer
}> {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: api },
    writable: true,
  })
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    const dashboard = createElement(
      LanguageProvider,
      null,
      createElement(DashboardPage, {
        authMode,
        defaultPort: 4510,
        onChangeAuth: () => undefined,
      }),
    )
    renderer = create(
      strictMode ? createElement(StrictMode, null, dashboard) : dashboard,
    )
    await Promise.resolve()
  })
  if (!renderer) throw new Error('Dashboard did not mount')
  return {
    cleanup: () => {
      act(() => renderer?.unmount())
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    },
    renderer,
  }
}

function findButton(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | undefined {
  return renderer.root
    .findAllByType('button')
    .find((button) => renderedText(button).trim() === label)
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  }
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

async function clickDashboardButton(
  renderer: ReactTestRenderer,
  label: string,
): Promise<void> {
  const button = findButton(renderer, label)
  expect(button).toBeDefined()
  await act(async () => {
    const click = button?.props.onClick as (() => Promise<void>) | undefined
    await click?.()
  })
}

async function beginDashboardButtonAction(
  renderer: ReactTestRenderer,
  label: string,
): Promise<{ action: Promise<void> }> {
  const button = findButton(renderer, label)
  expect(button).toBeDefined()
  let action: Promise<void> | undefined
  await act(async () => {
    const click = button?.props.onClick as (() => Promise<void>) | undefined
    action = click?.()
    await Promise.resolve()
  })
  if (!action) throw new Error(`${label} did not start an async action`)
  return { action }
}

async function settleDashboardAction(action: Promise<void>): Promise<void> {
  await act(async () => {
    await action
  })
}

async function resolveDashboardStatus(
  deferred: ReturnType<typeof createDeferred<ServerStatus>>,
  status: ServerStatus,
): Promise<void> {
  await act(async () => {
    deferred.resolve(status)
    await Promise.resolve()
  })
}

const tokenUsageTotals: TokenUsageTotals = {
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 100,
  costs: [{ amount: 0.001, currency: 'USD', total_cost_nanos: 1_000_000 }],
  input_tokens: 1_000,
  output_tokens: 250,
  request_count: 2,
  total_nano_aiu: null,
  total_tokens: 1_400,
}

const tokenUsageRange = {
  end_ms: 1_753_132_800_000,
  end_utc: '2025-07-22T00:00:00.000Z',
  start_ms: 1_753_046_400_000,
  start_utc: '2025-07-21T00:00:00.000Z',
}

function createTokenUsageSummary(
  period: TokenUsageSummary['period'],
): TokenUsageSummary {
  return {
    byModel: [{ ...tokenUsageTotals, model: `summary-${period}-model` }],
    period,
    range: tokenUsageRange,
    totals: tokenUsageTotals,
  }
}

function createTokenUsageDaily(
  period: TokenUsageDailySummary['period'],
): TokenUsageDailySummary {
  return {
    ...createTokenUsageSummary(period),
    byModel: [{ ...tokenUsageTotals, model: `daily-${period}-model` }],
    days: [
      {
        byModel: [{ ...tokenUsageTotals, model: `daily-${period}-model` }],
        date: '2025-07-21',
        end_ms: tokenUsageRange.end_ms,
        start_ms: tokenUsageRange.start_ms,
        totals: tokenUsageTotals,
      },
    ],
  }
}

function createTokenUsageEvents(
  period: TokenUsageEventsPage['period'],
  page: number,
): TokenUsageEventsPage {
  return {
    items: [
      {
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
        cost: {
          amount: 0.001,
          currency: 'USD',
          source: 'catalog',
          total_cost_nanos: 1_000_000,
        },
        created_at_ms: 1_753_089_661_000,
        created_at_utc: '2025-07-21T12:01:01.000Z',
        endpoint: 'responses',
        error_code: null,
        id: page,
        input_tokens: 1_000,
        model: `event-${period}-page-${page}-model`,
        outcome: 'completed',
        output_tokens: 250,
        provider_name: null,
        session_id: 'session-public',
        source: 'copilot',
        terminal: 'response.completed',
        total_nano_aiu: null,
        total_tokens: 1_400,
        trace_id: `trace-${period}-${page}`,
        user_id: 'user-public',
      },
    ],
    page,
    page_size: 10,
    period,
    range: tokenUsageRange,
    total: 2,
    total_pages: 2,
  }
}

describe('Dashboard log feed hook', () => {
  test('mounts, subscribes, bounds updates, refreshes, clears, and unsubscribes', async () => {
    let receive: ((update: LogFeedUpdate) => void) | undefined
    let unsubscribeCalls = 0
    let refreshCalls = 0
    let clearCalls = 0
    const api: DashboardLogApi = {
      clearServerLogs: () => {
        clearCalls += 1
        return Promise.resolve({ cursor: 5, entries: [] })
      },
      getServerLogSnapshot: () => {
        refreshCalls += 1
        return Promise.resolve({
          cursor: 4,
          entries: [{ cursor: 4, message: 'refreshed' }],
        })
      },
      subscribeServerLogs: (callback) => {
        receive = callback
        return () => {
          unsubscribeCalls += 1
        }
      },
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(LogHarness, { api }))
    })

    act(() => {
      receive?.({
        kind: 'snapshot',
        snapshot: {
          cursor: 4,
          entries: [1, 2, 3, 4].map((cursor) => ({
            cursor,
            message: `row-${cursor}`,
          })),
        },
      })
    })
    expect(
      renderer?.root.findAllByType('li').map((node) => node.children[0]),
    ).toEqual(['row-2', 'row-3', 'row-4'])

    await act(async () => observedFeed?.refresh())
    expect(refreshCalls).toBe(1)
    expect(renderer?.root.findAllByType('li')[0]?.children[0]).toBe('refreshed')

    await act(async () => observedFeed?.clear())
    expect(clearCalls).toBe(1)
    expect(renderer?.root.findAllByType('li')).toHaveLength(0)

    act(() => renderer?.unmount())
    expect(unsubscribeCalls).toBe(1)
  })

  test('keeps the last bounded view when refresh or clear IPC fails', async () => {
    const api: DashboardLogApi = {
      clearServerLogs: () => Promise.reject(new Error('main unavailable')),
      getServerLogSnapshot: () => Promise.reject(new Error('main unavailable')),
      subscribeServerLogs: (receive) => {
        receive({
          kind: 'snapshot',
          snapshot: {
            cursor: 1,
            entries: [{ cursor: 1, message: 'last-good' }],
          },
        })
        return () => undefined
      },
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(LogHarness, { api }))
    })

    await act(async () => observedFeed?.refresh())
    await act(async () => observedFeed?.clear())

    expect(renderer?.root.findByType('li').children[0]).toBe('last-good')
    act(() => renderer?.unmount())
  })

  test('does not resurrect a stale refresh after clear advances the feed revision', async () => {
    const staleRefresh = createDeferred<{
      cursor: number
      entries: Array<{ cursor: number; message: string }>
    }>()
    const api: DashboardLogApi = {
      clearServerLogs: () => Promise.resolve({ cursor: 2, entries: [] }),
      getServerLogSnapshot: () => staleRefresh.promise,
      subscribeServerLogs: (receive) => {
        receive({
          kind: 'snapshot',
          snapshot: {
            cursor: 1,
            entries: [{ cursor: 1, message: 'before-clear' }],
          },
        })
        return () => undefined
      },
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(LogHarness, { api }))
    })
    let refresh: Promise<void> | undefined
    await act(async () => {
      refresh = observedFeed?.refresh()
      await Promise.resolve()
    })
    await act(async () => observedFeed?.clear())
    expect(renderer?.root.findAllByType('li')).toHaveLength(0)

    await act(async () => {
      staleRefresh.resolve({
        cursor: 1,
        entries: [{ cursor: 1, message: 'before-clear' }],
      })
      await refresh
    })

    expect(renderer?.root.findAllByType('li')).toHaveLength(0)
    act(() => renderer?.unmount())
  })

  test('Dashboard renders live log rows, clears them, and unsubscribes', async () => {
    let receive: ((update: LogFeedUpdate) => void) | undefined
    let unsubscribeCalls = 0
    let clearCalls = 0
    const api = {
      clearServerLogs: () => {
        clearCalls += 1
        return Promise.resolve({ cursor: 1, entries: [] })
      },
      fetchModels: () => Promise.resolve({ data: [] }),
      fetchTokenUsage: () => Promise.resolve(null),
      fetchTokenUsageDaily: () => Promise.resolve(null),
      fetchTokenUsageEvents: () => Promise.resolve(null),
      getServerAuthInfo: () => Promise.resolve({ enabled: false }),
      getServerLogSnapshot: () => Promise.resolve({ cursor: 0, entries: [] }),
      getServerStatus: () =>
        Promise.resolve(createServerStatus(0, { owned: true, running: true })),
      onServerStatus: () => () => undefined,
      onWindowMaximizeChange: () => () => undefined,
      platform: 'darwin',
      subscribeServerLogs: (callback: (update: LogFeedUpdate) => void) => {
        receive = callback
        return () => {
          unsubscribeCalls += 1
        }
      },
      windowIsMaximized: () => Promise.resolve(false),
    } as unknown as DesktopApi
    const previousWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electronAPI: api },
      writable: true,
    })
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(
          createElement(
            LanguageProvider,
            null,
            createElement(DashboardPage, {
              authMode: 'provider',
              defaultPort: 4510,
              onChangeAuth: () => undefined,
            }),
          ),
        )
        await Promise.resolve()
      })
      const logsTab = renderer?.root
        .findAllByType('button')
        .find((button) => renderedText(button).trim() === 'Logs')
      const clickLogs = logsTab?.props.onClick as (() => void) | undefined
      act(() => clickLogs?.())
      act(() => {
        receive?.({
          batch: {
            cursor: 1,
            entries: [{ cursor: 1, message: 'component-log' }],
            reset: false,
          },
          kind: 'batch',
        })
      })
      expect(
        renderer?.root.findAll((node) =>
          renderedText(node).includes('component-log'),
        ).length,
      ).toBeGreaterThan(0)

      const clearButton = renderer?.root
        .findAllByType('button')
        .find((button) => renderedText(button).trim() === 'Clear')
      const clickClear = clearButton?.props.onClick as (() => void) | undefined
      await act(async () => {
        clickClear?.()
        await Promise.resolve()
      })
      expect(clearCalls).toBe(1)
      expect(
        renderer?.root.findAll((node) =>
          renderedText(node).includes('component-log'),
        ),
      ).toHaveLength(0)
    } finally {
      act(() => {
        renderer?.unmount()
      })
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    }
    expect(unsubscribeCalls).toBe(1)
  })

  test('Dashboard shows Copilot usage, models, and the last successful refresh', async () => {
    let usageCalls = 0
    let modelCalls = 0
    const lastSuccessAt = new Date(2025, 6, 21, 8, 9, 10).getTime()
    const api = createRunningDashboardApi({
      fetchModels: () => {
        modelCalls += 1
        return Promise.resolve({
          data: [{ id: 'gpt-5.6-sol' }, { id: 'claude-opus-4.1' }],
        })
      },
      fetchUsage: () => {
        usageCalls += 1
        return Promise.resolve({
          _copilot_api: {
            freshness: 'fresh',
            last_attempt_at_ms: lastSuccessAt,
            last_success_at_ms: lastSuccessAt,
            stale_since_at_ms: null,
          },
          copilot_plan: 'Business',
          quota_reset_date: '2025-08-01',
          quota_snapshots: {
            chat: {
              entitlement: 1_000,
              quota_remaining: 900,
              unlimited: false,
            },
            completions: {
              entitlement: 0,
              quota_remaining: 0,
              unlimited: true,
            },
            premium_interactions: {
              entitlement: 100,
              quota_remaining: 75,
              unlimited: false,
            },
          },
        })
      },
    })
    const { cleanup, renderer } = await mountDashboard(api, false, 'copilot')

    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      const text = renderedText(renderer.root)
      expect(usageCalls).toBe(1)
      expect(modelCalls).toBe(1)
      expect(text).toContain('Business')
      expect(text).toContain('25 / 100')
      expect(text).toContain('gpt-5.6-sol')
      expect(text).toContain('claude-opus-4.1')
      expect(text).toContain('08:09:10')
    } finally {
      cleanup()
    }
  })

  test('Dashboard renders token summary, daily trend, and event pagination', async () => {
    const summaryPeriods: TokenUsageSummary['period'][] = []
    const dailyPeriods: TokenUsageDailySummary['period'][] = []
    const eventRequests: Array<{
      page: number
      pageSize: number
      period: TokenUsageEventsPage['period']
    }> = []
    const api = createRunningDashboardApi({
      fetchTokenUsage: (period) => {
        summaryPeriods.push(period)
        return Promise.resolve(createTokenUsageSummary(period))
      },
      fetchTokenUsageDaily: (period) => {
        dailyPeriods.push(period)
        return Promise.resolve(createTokenUsageDaily(period))
      },
      fetchTokenUsageEvents: (period, page, pageSize) => {
        eventRequests.push({ page, pageSize, period })
        return Promise.resolve(createTokenUsageEvents(period, page))
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)

    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      await clickDashboardButton(renderer, 'Token usage')

      expect(
        renderer.root
          .findAllByType('table')
          .map(renderedText)
          .some((text) => text.includes('summary-all-model')),
      ).toBeTrue()
      expect(
        renderer.root
          .findAllByType('table')
          .map(renderedText)
          .some(
            (text) =>
              text.includes('event-all-page-1-model')
              && text.includes('trace-all-1'),
          ),
      ).toBeTrue()
      expect(summaryPeriods).toEqual(['all'])
      expect(dailyPeriods).toEqual([])
      expect(eventRequests).toEqual([{ page: 1, pageSize: 10, period: 'all' }])

      await clickDashboardButton(renderer, '7 days')
      expect(summaryPeriods).toEqual(['all', 'week'])
      expect(dailyPeriods).toEqual(['week'])
      expect(eventRequests.at(-1)).toEqual({
        page: 1,
        pageSize: 10,
        period: 'week',
      })
      expect(
        renderer.root
          .findAllByType('table')
          .map(renderedText)
          .some((text) => text.includes('summary-week-model')),
      ).toBeTrue()
      expect(renderer.root.findAllByType('option').map(renderedText)).toContain(
        'daily-week-model',
      )
      expect(renderedText(renderer.root)).not.toContain('summary-all-model')
      expect(renderedText(renderer.root)).toContain('07/21')

      await clickDashboardButton(renderer, 'Next')
      expect(eventRequests.at(-1)).toEqual({
        page: 2,
        pageSize: 10,
        period: 'week',
      })
      expect(
        renderer.root
          .findAllByType('table')
          .map(renderedText)
          .some(
            (text) =>
              text.includes('event-week-page-2-model')
              && text.includes('trace-week-2'),
          ),
      ).toBeTrue()
      expect(renderedText(renderer.root)).not.toContain('trace-week-1')
    } finally {
      cleanup()
    }
  })

  test('Dashboard preserves the token usage period across a desktop remount', async () => {
    const previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    )
    const storage = createMemoryStorage()
    const summaryPeriods: TokenUsageSummary['period'][] = []
    const api = createRunningDashboardApi({
      fetchTokenUsage: (period) => {
        summaryPeriods.push(period)
        return Promise.resolve(createTokenUsageSummary(period))
      },
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
      writable: true,
    })

    let firstMount: Awaited<ReturnType<typeof mountDashboard>> | undefined
    let secondMount: Awaited<ReturnType<typeof mountDashboard>> | undefined
    try {
      firstMount = await mountDashboard(api)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      await clickDashboardButton(firstMount.renderer, 'Token usage')
      await clickDashboardButton(firstMount.renderer, '7 days')
      firstMount.cleanup()
      firstMount = undefined

      summaryPeriods.length = 0
      secondMount = await mountDashboard(api)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(summaryPeriods[0]).toBe('week')
    } finally {
      firstMount?.cleanup()
      secondMount?.cleanup()
      if (previousStorage) {
        Object.defineProperty(globalThis, 'localStorage', previousStorage)
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage')
      }
    }
  })

  test('Dashboard clears stale token usage when a new period cannot load', async () => {
    const api = createRunningDashboardApi({
      fetchTokenUsage: (period) =>
        Promise.resolve(
          period === 'all' ? createTokenUsageSummary(period) : null,
        ),
      fetchTokenUsageDaily: () => Promise.resolve(null),
      fetchTokenUsageEvents: (period, page) =>
        Promise.resolve(
          period === 'all' ? createTokenUsageEvents(period, page) : null,
        ),
    })
    const { cleanup, renderer } = await mountDashboard(api)

    try {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      await clickDashboardButton(renderer, 'Token usage')
      expect(renderedText(renderer.root)).toContain('summary-all-model')

      await clickDashboardButton(renderer, '7 days')
      expect(renderedText(renderer.root)).not.toContain('summary-all-model')
      expect(renderedText(renderer.root)).not.toContain(
        'event-all-page-1-model',
      )
    } finally {
      cleanup()
    }
  })

  test('Dashboard keeps an owned child running and restores Stop after timeout', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      stopServer: () =>
        Promise.resolve({
          error: 'Server process did not exit after graceful termination',
          reason: 'timeout',
          status: createServerStatus(1, {
            error: 'Server process did not exit after graceful termination',
            owned: true,
            running: true,
          }),
          stopped: false,
        }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const stop = findButton(renderer, 'Stop')
      expect(stop).toBeDefined()
      await act(async () => {
        const click = stop?.props.onClick as (() => Promise<void>) | undefined
        await click?.()
      })

      expect(findButton(renderer, 'Stop')).toBeDefined()
      act(() => publishStatus?.(createServerStatus(2)))
      expect(findButton(renderer, 'Start server')).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard successful Stop clears running state and restores start controls', async () => {
    const api = createRunningDashboardApi({
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const stop = findButton(renderer, 'Stop')
      await act(async () => {
        const click = stop?.props.onClick as (() => Promise<void>) | undefined
        await click?.()
      })

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Stop')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard restart does not launch a replacement after stop timeout', async () => {
    let startCalls = 0
    const api = createRunningDashboardApi({
      startServer: () => {
        startCalls += 1
        return Promise.resolve(
          createServerStatus(2, { owned: true, running: true }),
        )
      },
      stopServer: () =>
        Promise.resolve({
          error: 'Server process did not exit after graceful termination',
          reason: 'timeout',
          status: createServerStatus(1, {
            error: 'Server process did not exit after graceful termination',
            owned: true,
            running: true,
          }),
          stopped: false,
        }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Restart')

      expect(startCalls).toBe(0)
      expect(findButton(renderer, 'Restart')).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard restores Stop when stop IPC rejects', async () => {
    const api = createRunningDashboardApi({
      stopServer: () => Promise.reject(new Error('IPC unavailable')),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const stop = findButton(renderer, 'Stop')
      await act(async () => {
        const click = stop?.props.onClick as (() => Promise<void>) | undefined
        await click?.()
      })
      expect(findButton(renderer, 'Stop')).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard recovers a successful Stop whose IPC response was lost', async () => {
    let statusCalls = 0
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return Promise.resolve(
          statusCalls === 1 ?
            createServerStatus(0, { owned: true, running: true })
          : createServerStatus(1),
        )
      },
      stopServer: () => Promise.reject(new Error('lost Stop response')),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Stop')

      expect(statusCalls).toBe(2)
      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Stop')).toBeUndefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('lost Stop response'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard shows owned-not-ready startup failure and recovers on late exit', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => Promise.resolve(createServerStatus(0)),
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () =>
        Promise.resolve(
          createServerStatus(1, {
            error: 'Server process did not exit after graceful termination',
            owned: true,
            running: false,
          }),
        ),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const start = findButton(renderer, 'Start server')
      await act(async () => {
        const click = start?.props.onClick as (() => Promise<void>) | undefined
        await click?.()
      })

      expect(findButton(renderer, 'Stop')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('did not exit'),
        ).length,
      ).toBeGreaterThan(0)

      act(() => publishStatus?.(createServerStatus(2)))
      expect(findButton(renderer, 'Stop')).toBeUndefined()
      expect(findButton(renderer, 'Start server')).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard bootstrap restores owned-not-ready error and clears it on late exit', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () =>
        Promise.resolve(
          createServerStatus(0, {
            error: 'Previous startup cleanup is still pending',
            owned: true,
            running: false,
          }),
        ),
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const start = findButton(renderer, 'Start server')
      expect(start?.props.disabled).toBe(true)
      expect(findButton(renderer, 'Stop')).toBeDefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('cleanup is still pending'),
        ).length,
      ).toBeGreaterThan(0)

      act(() => publishStatus?.(createServerStatus(1)))
      expect(findButton(renderer, 'Stop')).toBeUndefined()
      expect(findButton(renderer, 'Start server')?.props.disabled).toBe(false)
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('cleanup is still pending'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard stopped bootstrap keeps Start enabled without an error', async () => {
    const api = createRunningDashboardApi({
      getServerStatus: () => Promise.resolve(createServerStatus(0)),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      expect(findButton(renderer, 'Start server')?.props.disabled).toBe(false)
      expect(findButton(renderer, 'Stop')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard preserves the attempted port after an unowned Start failure', async () => {
    const api = createRunningDashboardApi({
      getServerStatus: () => Promise.resolve(createServerStatus(0)),
      startServer: () =>
        Promise.resolve(
          createServerStatus(1, {
            error: 'requested port is unavailable',
            port: 4141,
          }),
        ),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')
      const portInput = renderer.root.find(
        (node) => node.type === 'input' && node.props.type === 'number',
      )
      expect(portInput.props.value).toBe('4510')
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('requested port is unavailable'),
        ).length,
      ).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard recovers a successful Start whose IPC response was lost', async () => {
    let statusCalls = 0
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return Promise.resolve(
          statusCalls === 1 ?
            createServerStatus(0)
          : createServerStatus(2, { owned: true, running: true }),
        )
      },
      startServer: () => Promise.reject(new Error('lost Start response')),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')

      expect(statusCalls).toBe(2)
      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('lost Start response'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard subscribes before bootstrap and rejects stale bootstrap after live status', async () => {
    let subscribed = false
    let subscribedWhenSnapshotRequested = false
    let publishStatus: ((status: ServerStatus) => void) | undefined
    let resolveBootstrap: ((status: ServerStatus) => void) | undefined
    const bootstrap = new Promise<ServerStatus>((resolve) => {
      resolveBootstrap = resolve
    })
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        subscribedWhenSnapshotRequested = subscribed
        return bootstrap
      },
      onServerStatus: (callback) => {
        subscribed = true
        publishStatus = callback
        return () => {
          subscribed = false
        }
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      expect(subscribedWhenSnapshotRequested).toBe(true)
      act(() => publishStatus?.(createServerStatus(1)))
      await act(async () => {
        resolveBootstrap?.(
          createServerStatus(0, {
            error: 'stale owned startup error',
            owned: true,
            running: false,
          }),
        )
        await Promise.resolve()
      })

      expect(findButton(renderer, 'Stop')).toBeUndefined()
      expect(findButton(renderer, 'Start server')?.props.disabled).toBe(false)
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('stale owned startup error'),
        ),
      ).toHaveLength(0)
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('stopped unexpectedly'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard keeps a successful Start authoritative when an older bootstrap resolves later', async () => {
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')
      expect(findButton(renderer, 'Restart')).toBeDefined()

      await resolveDashboardStatus(bootstrap, {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 0,
      })

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard applies Start after an older bootstrap resolves first', async () => {
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await resolveDashboardStatus(bootstrap, {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 0,
      })
      expect(findButton(renderer, 'Start server')).toBeDefined()

      await clickDashboardButton(renderer, 'Start server')

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard keeps Stop authoritative when an older bootstrap resolves later', async () => {
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')
      await clickDashboardButton(renderer, 'Stop')
      expect(findButton(renderer, 'Start server')).toBeDefined()

      await resolveDashboardStatus(bootstrap, {
        owned: true,
        port: 4510,
        running: true,
        statusRevision: 0,
      })

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Stop')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard applies Stop after an older bootstrap resolves first', async () => {
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await resolveDashboardStatus(bootstrap, {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 0,
      })
      await clickDashboardButton(renderer, 'Start server')
      await clickDashboardButton(renderer, 'Stop')

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Stop')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard keeps Restart authoritative when an older bootstrap resolves later', async () => {
    let startCalls = 0
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
      startServer: () => {
        startCalls += 1
        return Promise.resolve(
          createServerStatus(startCalls, { owned: true, running: true }),
        )
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')
      await clickDashboardButton(renderer, 'Restart')
      expect(startCalls).toBe(2)

      await resolveDashboardStatus(bootstrap, {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 0,
      })

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard applies Restart after an older bootstrap resolves first', async () => {
    let startCalls = 0
    const bootstrap = createDeferred<ServerStatus>()
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
      startServer: () => {
        startCalls += 1
        return Promise.resolve(
          createServerStatus(startCalls, { owned: true, running: true }),
        )
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await resolveDashboardStatus(bootstrap, {
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 0,
      })
      await clickDashboardButton(renderer, 'Start server')
      await clickDashboardButton(renderer, 'Restart')

      expect(startCalls).toBe(2)
      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard applies the recovery status after Restart IPC failure', async () => {
    let statusCalls = 0
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return Promise.resolve(
          statusCalls === 1 ?
            createServerStatus(0, { owned: true, running: true })
          : createServerStatus(2),
        )
      },
      startServer: () => Promise.reject(new Error('restart IPC unavailable')),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Restart')

      expect(statusCalls).toBe(2)
      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Stop')).toBeUndefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('restart IPC unavailable'),
        ).length,
      ).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard clears a lost Restart response error after running recovery', async () => {
    let statusCalls = 0
    let stopCalls = 0
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return Promise.resolve(
          createServerStatus(statusCalls === 1 ? 0 : 3, {
            owned: true,
            running: true,
          }),
        )
      },
      startServer: () => Promise.reject(new Error('lost Restart response')),
      stopServer: () => {
        stopCalls += 1
        return Promise.resolve({
          status: createServerStatus(stopCalls === 1 ? 1 : 4),
          stopped: true,
        })
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Restart')
      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('lost Restart response'),
        ),
      ).toHaveLength(0)

      await clickDashboardButton(renderer, 'Stop')
      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('lost Restart response'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard applies a later live stopped status after ready bootstrap', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      expect(findButton(renderer, 'Restart')).toBeDefined()
      act(() => publishStatus?.(createServerStatus(1)))
      expect(findButton(renderer, 'Restart')).toBeUndefined()
      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('stopped unexpectedly'),
        ).length,
      ).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older Start response after a newer live transition', async () => {
    const start = createDeferred<ServerStatus>()
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => Promise.resolve(createServerStatus(0)),
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () => start.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action } = await beginDashboardButtonAction(
        renderer,
        'Start server',
      )
      act(() => publishStatus?.(createServerStatus(2)))
      start.resolve(createServerStatus(1, { owned: true, running: true }))
      await settleDashboardAction(action)

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older live transition after a newer Start response', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => Promise.resolve(createServerStatus(0)),
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () =>
        Promise.resolve(createServerStatus(2, { owned: true, running: true })),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Start server')
      act(() => publishStatus?.(createServerStatus(1)))

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older Stop response after a newer live transition', async () => {
    const stop = createDeferred<Awaited<ReturnType<DesktopApi['stopServer']>>>()
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () =>
        Promise.resolve(createServerStatus(0, { owned: true, running: true })),
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      stopServer: () => stop.promise,
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action } = await beginDashboardButtonAction(renderer, 'Stop')
      act(() =>
        publishStatus?.(createServerStatus(2, { owned: true, running: true })),
      )
      stop.resolve({ status: createServerStatus(1), stopped: true })
      await settleDashboardAction(action)

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older live transition after a newer Stop response', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(2), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Stop')
      act(() =>
        publishStatus?.(createServerStatus(1, { owned: true, running: true })),
      )

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older Restart response after a newer live transition', async () => {
    const restart = createDeferred<ServerStatus>()
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () => restart.promise,
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action } = await beginDashboardButtonAction(renderer, 'Restart')
      act(() => publishStatus?.(createServerStatus(3)))
      restart.resolve(createServerStatus(2, { owned: true, running: true }))
      await settleDashboardAction(action)

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older live transition after a newer Restart response', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () =>
        Promise.resolve(createServerStatus(3, { owned: true, running: true })),
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Restart')
      act(() => publishStatus?.(createServerStatus(2)))

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard reports a replacement crash before Restart response settles', async () => {
    const replacement = createDeferred<ServerStatus>()
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () => replacement.promise,
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action } = await beginDashboardButtonAction(renderer, 'Restart')
      act(() =>
        publishStatus?.(
          createServerStatus(3, { error: 'replacement crashed' }),
        ),
      )

      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('replacement crashed'),
        ).length,
      ).toBeGreaterThan(0)

      replacement.resolve(
        createServerStatus(3, { error: 'replacement crashed' }),
      )
      await settleDashboardAction(action)
    } finally {
      cleanup()
    }
  })

  test('Dashboard does not relaunch when Stop supersedes an in-flight Restart', async () => {
    const restartStop =
      createDeferred<Awaited<ReturnType<DesktopApi['stopServer']>>>()
    let startCalls = 0
    let stopCalls = 0
    const api = createRunningDashboardApi({
      startServer: () => {
        startCalls += 1
        return Promise.resolve(
          createServerStatus(3, { owned: true, running: true }),
        )
      },
      stopServer: () => {
        stopCalls += 1
        return stopCalls === 1 ?
            restartStop.promise
          : Promise.resolve({ status: createServerStatus(2), stopped: true })
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action: restart } = await beginDashboardButtonAction(
        renderer,
        'Restart',
      )
      const { action: stop } = await beginDashboardButtonAction(
        renderer,
        'Stop',
      )
      await settleDashboardAction(stop)
      restartStop.resolve({ status: createServerStatus(1), stopped: true })
      await settleDashboardAction(restart)

      expect(stopCalls).toBe(2)
      expect(startCalls).toBe(0)
      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older recovery snapshot after a newer live transition', async () => {
    const recovery = createDeferred<ServerStatus>()
    let statusCalls = 0
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return statusCalls === 1 ?
            Promise.resolve(
              createServerStatus(0, { owned: true, running: true }),
            )
          : recovery.promise
      },
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () => Promise.reject(new Error('stale restart failure')),
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      const { action } = await beginDashboardButtonAction(renderer, 'Restart')
      act(() =>
        publishStatus?.(createServerStatus(3, { owned: true, running: true })),
      )
      recovery.resolve(createServerStatus(2))
      await settleDashboardAction(action)

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('stale restart failure'),
        ),
      ).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard rejects an older live transition after a newer recovery snapshot', async () => {
    let statusCalls = 0
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => {
        statusCalls += 1
        return Promise.resolve(
          statusCalls === 1 ?
            createServerStatus(0, { owned: true, running: true })
          : createServerStatus(3),
        )
      },
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
      startServer: () => Promise.reject(new Error('restart failed')),
      stopServer: () =>
        Promise.resolve({ status: createServerStatus(1), stopped: true }),
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      await clickDashboardButton(renderer, 'Restart')
      act(() =>
        publishStatus?.(createServerStatus(2, { owned: true, running: true })),
      )

      expect(findButton(renderer, 'Start server')).toBeDefined()
      expect(findButton(renderer, 'Restart')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test('Dashboard treats a repeated status revision as idempotent', async () => {
    const bootstrap = createDeferred<ServerStatus>()
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap.promise,
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      act(() =>
        publishStatus?.(
          createServerStatus(1, {
            owned: true,
            port: 4511,
            running: true,
          }),
        ),
      )
      await resolveDashboardStatus(
        bootstrap,
        createServerStatus(1, {
          owned: true,
          port: 4511,
          running: true,
        }),
      )

      expect(findButton(renderer, 'Restart')).toBeDefined()
      expect(findButton(renderer, 'Start server')).toBeUndefined()
      expect(
        renderer.root.findAll((node) => renderedText(node).trim() === '4511')
          .length,
      ).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test('Dashboard unmount cancels subscription and ignores late bootstrap', async () => {
    let unsubscribeCalls = 0
    let resolveBootstrap: ((status: ServerStatus) => void) | undefined
    const bootstrap = new Promise<ServerStatus>((resolve) => {
      resolveBootstrap = resolve
    })
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap,
      onServerStatus: () => () => {
        unsubscribeCalls += 1
      },
    })
    const { cleanup } = await mountDashboard(api)

    cleanup()
    await act(async () => {
      resolveBootstrap?.(createServerStatus(0, { owned: true, running: false }))
      await Promise.resolve()
    })

    expect(unsubscribeCalls).toBe(1)
  })

  test('Dashboard isolates a late bootstrap from an earlier mount', async () => {
    const oldBootstrap = createDeferred<ServerStatus>()
    const oldMount = await mountDashboard(
      createRunningDashboardApi({
        getServerStatus: () => oldBootstrap.promise,
      }),
    )
    oldMount.cleanup()

    const newMount = await mountDashboard(createRunningDashboardApi())
    try {
      expect(findButton(newMount.renderer, 'Restart')).toBeDefined()
      await resolveDashboardStatus(oldBootstrap, {
        error: 'stale previous mount failure',
        owned: false,
        port: 4510,
        running: false,
        statusRevision: 100,
      })

      expect(findButton(newMount.renderer, 'Restart')).toBeDefined()
      expect(findButton(newMount.renderer, 'Start server')).toBeUndefined()
      expect(
        newMount.renderer.root.findAll((node) =>
          renderedText(node).includes('stale previous mount failure'),
        ),
      ).toHaveLength(0)
    } finally {
      newMount.cleanup()
    }
  })

  test('Dashboard keyed remount rejects a late snapshot from the retired component', async () => {
    const previousWindow = globalThis.window
    const retiredBootstrap = createDeferred<ServerStatus>()
    const retiredApi = createRunningDashboardApi({
      getServerStatus: () => retiredBootstrap.promise,
    })
    const currentApi = createRunningDashboardApi({
      getServerStatus: () =>
        Promise.resolve(createServerStatus(10, { owned: true, running: true })),
    })
    let renderer: ReactTestRenderer | undefined
    const renderDashboard = (key: string) =>
      createElement(
        LanguageProvider,
        null,
        createElement(DashboardPage, {
          authMode: 'provider',
          defaultPort: 4510,
          key,
          onChangeAuth: () => undefined,
        }),
      )

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { electronAPI: retiredApi },
        writable: true,
      })
      await act(async () => {
        renderer = create(renderDashboard('retired'))
        await Promise.resolve()
      })

      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { electronAPI: currentApi },
        writable: true,
      })
      await act(async () => {
        renderer?.update(renderDashboard('current'))
        await Promise.resolve()
      })
      expect(findButton(renderer!, 'Restart')).toBeDefined()

      retiredBootstrap.resolve(
        createServerStatus(100, {
          error: 'retired keyed snapshot',
        }),
      )
      await act(async () => {
        await Promise.resolve()
      })

      expect(findButton(renderer!, 'Restart')).toBeDefined()
      expect(
        renderer!.root.findAll((node) =>
          renderedText(node).includes('retired keyed snapshot'),
        ),
      ).toHaveLength(0)
    } finally {
      act(() => renderer?.unmount())
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      })
    }
  })

  test('Dashboard balances status and log subscriptions under StrictMode', async () => {
    let logSubscriptions = 0
    let logUnsubscriptions = 0
    let statusSubscriptions = 0
    let statusUnsubscriptions = 0
    const api = createRunningDashboardApi({
      onServerStatus: () => {
        statusSubscriptions += 1
        return () => {
          statusUnsubscriptions += 1
        }
      },
      subscribeServerLogs: () => {
        logSubscriptions += 1
        return () => {
          logUnsubscriptions += 1
        }
      },
    })
    const { cleanup, renderer } = await mountDashboard(api, true)

    expect(findButton(renderer, 'Restart')).toBeDefined()
    expect(statusSubscriptions).toBeGreaterThanOrEqual(1)
    expect(logSubscriptions).toBeGreaterThanOrEqual(1)
    cleanup()
    expect(statusUnsubscriptions).toBe(statusSubscriptions)
    expect(logUnsubscriptions).toBe(logSubscriptions)
  })

  test('Dashboard preserves an error carried by the first authoritative live status', async () => {
    let publishStatus: ((status: ServerStatus) => void) | undefined
    const bootstrap = new Promise<ServerStatus>(() => undefined)
    const api = createRunningDashboardApi({
      getServerStatus: () => bootstrap,
      onServerStatus: (callback) => {
        publishStatus = callback
        return () => undefined
      },
    })
    const { cleanup, renderer } = await mountDashboard(api)
    try {
      act(() =>
        publishStatus?.(
          createServerStatus(0, {
            error: 'authoritative live failure',
            owned: false,
          }),
        ),
      )
      expect(
        renderer.root.findAll((node) =>
          renderedText(node).includes('authoritative live failure'),
        ).length,
      ).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })
})
