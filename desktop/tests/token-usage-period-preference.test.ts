import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_TOKEN_USAGE_PERIOD,
  readTokenUsagePeriodPreference,
  TOKEN_USAGE_PERIOD_STORAGE_KEY,
  writeTokenUsagePeriodPreference,
} from '../src/lib/token-usage-period-preference'

function createStorage(initial?: string) {
  let value = initial ?? null
  return {
    get value() {
      return value
    },
    getItem: (key: string) =>
      key === TOKEN_USAGE_PERIOD_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === TOKEN_USAGE_PERIOD_STORAGE_KEY) value = next
    },
  }
}

describe('token usage period preference', () => {
  test('defaults to all history and restores every supported period', () => {
    expect(readTokenUsagePeriodPreference(undefined)).toBe(
      DEFAULT_TOKEN_USAGE_PERIOD,
    )

    for (const period of ['all', 'day', 'week', 'month'] as const) {
      expect(readTokenUsagePeriodPreference(createStorage(period))).toBe(period)
    }
  })

  test('falls back safely for invalid and unavailable renderer storage', () => {
    expect(readTokenUsagePeriodPreference(createStorage('legacy-value'))).toBe(
      DEFAULT_TOKEN_USAGE_PERIOD,
    )
    expect(
      readTokenUsagePeriodPreference({
        getItem: () => {
          throw new Error('storage unavailable')
        },
        setItem: () => undefined,
      }),
    ).toBe(DEFAULT_TOKEN_USAGE_PERIOD)
  })

  test('persists a period without making storage availability fatal', () => {
    const storage = createStorage()
    writeTokenUsagePeriodPreference('month', storage)
    expect(storage.value).toBe('month')

    expect(() =>
      writeTokenUsagePeriodPreference('week', {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage unavailable')
        },
      }),
    ).not.toThrow()
  })
})
