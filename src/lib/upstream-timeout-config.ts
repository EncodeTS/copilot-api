import {
  DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS,
  type UpstreamLifecycleTimeouts,
} from "./upstream-lifecycle"

export interface UpstreamTimeoutConfig {
  upstreamTimeouts?: UpstreamLifecycleTimeouts
  // Preserve unrelated legacy transport fields when migrating timeouts.
  upstreamTransport?: Record<string, unknown>
  responsesTransport?: Record<string, unknown>
}

const legacyFields = {
  httpHeadersMs: ["headersTimeoutMsV2", "headersTimeoutMs"],
  httpFirstByteMs: ["streamInactivityTimeoutMs"],
  httpInactivityMs: ["streamInactivityTimeoutMs"],
  websocketConnectMs: ["websocketOpenTimeoutMs"],
  websocketFirstFrameMs: ["streamInactivityTimeoutMs"],
  websocketInactivityMs: ["streamInactivityTimeoutMs"],
} satisfies Partial<Record<keyof UpstreamLifecycleTimeouts, string[]>>

const isTimeout = (value: unknown): value is number =>
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value > 0
  && value <= 2_147_483_647

const read = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ?
    (value as Record<string, unknown>)[key]
  : undefined

export function migrateUpstreamTimeouts(
  config: UpstreamTimeoutConfig,
): UpstreamLifecycleTimeouts | undefined {
  const migrated: UpstreamLifecycleTimeouts = {}
  for (const key of Object.keys(DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS) as Array<
    keyof UpstreamLifecycleTimeouts
  >) {
    const names =
      Object.hasOwn(legacyFields, key) ?
        legacyFields[key as keyof typeof legacyFields]
      : []
    const value = [
      read(config.upstreamTimeouts, key),
      ...names.map((name) => read(config.upstreamTransport, name)),
      ...names.map((name) => read(config.responsesTransport, name)),
    ].find(isTimeout)
    if (value !== undefined) migrated[key] = value
  }
  return Object.keys(migrated).length > 0 ? migrated : undefined
}

export function resolveConfiguredUpstreamTimeouts(
  config: UpstreamTimeoutConfig,
  overrides?: UpstreamLifecycleTimeouts,
): Required<UpstreamLifecycleTimeouts> {
  const result = {
    ...DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS,
    // Match upstream's long-thinking allowance without removing phase limits.
    httpHeadersMs: 300_000,
    httpFirstByteMs: 300_000,
    websocketFirstFrameMs: 300_000,
    ...migrateUpstreamTimeouts(config),
  }
  for (const key of Object.keys(result) as Array<
    keyof UpstreamLifecycleTimeouts
  >) {
    const value = overrides?.[key]
    if (isTimeout(value)) result[key] = value
  }
  return result
}
