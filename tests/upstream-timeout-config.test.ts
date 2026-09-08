import { expect, test } from "bun:test"

import {
  migrateUpstreamTimeouts,
  resolveConfiguredUpstreamTimeouts,
} from "../src/lib/upstream-timeout-config"

test("migrates both generations of upstream transport timeouts by precedence", () => {
  const config = {
    responsesTransport: {
      headersTimeoutMs: 30_000,
      headersTimeoutMsV2: 300_000,
      streamInactivityTimeoutMs: 240_000,
      websocketOpenTimeoutMs: 20_000,
      websocketMaxBufferedBytes: 1234,
    },
    upstreamTransport: {
      headersTimeoutMs: 310_000,
      streamInactivityTimeoutMs: 250_000,
    },
    upstreamTimeouts: {
      httpHeadersMs: 320_000,
      websocketInactivityMs: 270_000,
    },
  }
  expect(migrateUpstreamTimeouts(config)).toEqual({
    httpHeadersMs: 320_000,
    httpFirstByteMs: 250_000,
    httpInactivityMs: 250_000,
    websocketConnectMs: 20_000,
    websocketFirstFrameMs: 250_000,
    websocketInactivityMs: 270_000,
  })
  expect(
    migrateUpstreamTimeouts({ responsesTransport: config.responsesTransport })
      ?.httpHeadersMs,
  ).toBe(300_000)
  expect(
    migrateUpstreamTimeouts({
      responsesTransport: { headersTimeoutMs: 30_000 },
    })?.httpHeadersMs,
  ).toBe(30_000)
  expect(config.responsesTransport.websocketMaxBufferedBytes).toBe(1234)
})

test("uses finite long-thinking defaults and valid per-request overrides", () => {
  expect(
    resolveConfiguredUpstreamTimeouts({}, { httpFirstByteMs: 50 }),
  ).toEqual({
    httpHeadersMs: 300_000,
    httpFirstByteMs: 50,
    httpInactivityMs: 300_000,
    httpTotalMs: 3_600_000,
    websocketConnectMs: 30_000,
    websocketFirstFrameMs: 300_000,
    websocketInactivityMs: 300_000,
    websocketTotalMs: 3_600_000,
  })
  for (const invalid of [0, -1, 1.5, Infinity, NaN, 2_147_483_648]) {
    expect(
      migrateUpstreamTimeouts({ upstreamTimeouts: { httpHeadersMs: invalid } }),
    ).toBeUndefined()
    expect(
      resolveConfiguredUpstreamTimeouts(
        { upstreamTimeouts: { httpHeadersMs: 150 } },
        { httpHeadersMs: invalid },
      ).httpHeadersMs,
    ).toBe(150)
  }
  expect(
    migrateUpstreamTimeouts({
      responsesTransport: { headersTimeoutMs: "300000" },
    }),
  ).toBeUndefined()
})
