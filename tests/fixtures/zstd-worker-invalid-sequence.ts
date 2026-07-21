import { parentPort, workerData } from "node:worker_threads"

import type { ZstdWorkerInput } from "../../src/lib/zstd-worker-protocol"

type InvalidSequenceMode = "duplicate" | "extra-error" | "out-of-order"

const input = workerData as ZstdWorkerInput
const mode = process.env.COPILOT_ZSTD_INVALID_SEQUENCE as
  | InvalidSequenceMode
  | undefined
const compressed = new Uint8Array(input.compressed)

if (compressed.byteLength === 9 || input.expectedDecodedBytes === 11) {
  const bytes =
    compressed.byteLength === 9 ?
      new Uint8Array()
    : new TextEncoder().encode('{"ok":true}')
  const postActive = (): void =>
    parentPort?.postMessage({
      decoder: "wasm",
      isolatedEnvironment: true,
      type: "active",
    })
  const postResult = (): void => {
    const output = Uint8Array.from(bytes).buffer
    parentPort?.postMessage({ output, type: "result" }, [output])
  }
  const postError = (): void =>
    parentPort?.postMessage({
      code: "invalid_zstd",
      message: "unexpected extra terminal",
      type: "error",
    })

  if (mode === "duplicate") {
    postActive()
    postResult()
    postActive()
    postResult()
  } else if (mode === "extra-error") {
    postActive()
    postResult()
    postError()
  } else {
    postResult()
    postActive()
  }
} else {
  parentPort?.postMessage({
    code: "invalid_zstd",
    message: "rejected before active",
    type: "error",
  })
}

parentPort?.close()
