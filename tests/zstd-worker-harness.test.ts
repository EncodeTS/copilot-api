import { expect, test } from "bun:test"

import {
  createIsolatedRuntimeEnvironment,
  runZstdWorkerContract,
} from "../scripts/lib/zstd-worker-harness.mjs"

const workerUrl = new URL("../src/zstd-worker.ts", import.meta.url)
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
