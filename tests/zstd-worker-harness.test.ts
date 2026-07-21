import { expect, test } from "bun:test"

import {
  createIsolatedRuntimeEnvironment,
  runZstdWorkerContract,
} from "../scripts/lib/zstd-worker-harness.mjs"

const workerUrl = new URL("../src/zstd-worker.ts", import.meta.url)
const invalidSequenceWorkerUrl = new URL(
  "./fixtures/zstd-worker-invalid-sequence.ts",
  import.meta.url,
)
const { environment } = createIsolatedRuntimeEnvironment("zstd-worker-test")

test("shared worker harness covers native empty/cap-zero contracts", async () => {
  const result = await runZstdWorkerContract({ environment, workerUrl })

  expect(result.decoder === "native" || result.decoder === "wasm").toBeTrue()
  expect(result.emptyDecodedBytes).toBe(0)
  expect(result.capPlusOneFailedClosed).toBeTrue()
  expect(result.capZeroRejectedNonEmpty).toBeTrue()
  expect(result.workerIsolatedEnvironment).toBeTrue()
})

test("shared worker harness covers forced WASM empty/cap-zero contracts", async () => {
  const result = await runZstdWorkerContract({
    decoderPreference: "wasm",
    environment,
    workerUrl,
  })

  expect(result.decoder).toBe("wasm")
  expect(result.emptyDecodedBytes).toBe(0)
  expect(result.capPlusOneFailedClosed).toBeTrue()
  expect(result.capZeroRejectedNonEmpty).toBeTrue()
  expect(result.workerIsolatedEnvironment).toBeTrue()
})

test("shared worker harness rejects out-of-order, duplicate, and extra messages", async () => {
  for (const mode of ["out-of-order", "duplicate", "extra-error"]) {
    let contractError: unknown
    try {
      await runZstdWorkerContract({
        environment: { ...environment, COPILOT_ZSTD_INVALID_SEQUENCE: mode },
        workerUrl: invalidSequenceWorkerUrl,
      })
    } catch (error) {
      contractError = error
    }

    expect(contractError).toBeInstanceOf(Error)
    expect((contractError as Error).message).toContain(
      "exactly one active message followed by exactly one result message",
    )
  }
})
