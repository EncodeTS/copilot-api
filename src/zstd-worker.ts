import { parentPort, workerData } from "node:worker_threads"

import { admitSingleZstdFrame } from "~/lib/zstd-frame"
import {
  decodeZstdInRuntime,
  ZstdRuntimeUnavailableError,
} from "~/lib/zstd-runtime"
import type {
  ZstdWorkerInput,
  ZstdWorkerOutput,
} from "~/lib/zstd-worker-protocol"

const post = (message: ZstdWorkerOutput, transfer?: ArrayBuffer): void => {
  parentPort?.postMessage(message, transfer === undefined ? [] : [transfer])
}

const run = async (): Promise<void> => {
  if (parentPort === null) {
    return
  }

  const input = workerData as ZstdWorkerInput
  const compressed = new Uint8Array(input.compressed)
  const admission = admitSingleZstdFrame(compressed, input.expectedDecodedBytes)
  if (admission.decodedBytes !== input.expectedDecodedBytes) {
    throw new Error("Zstandard decoded size does not match worker admission.")
  }

  const output = await decodeZstdInRuntime(compressed, {
    decodedBytes: admission.decodedBytes,
    decoderPreference: input.decoderPreference ?? "auto",
    onActive: (decoder) =>
      post({
        decoder,
        isolatedEnvironment: hasIsolatedRuntimeEnvironment(),
        type: "active",
      }),
  })
  const transferable =
    (
      output.buffer instanceof ArrayBuffer
      && output.byteOffset === 0
      && output.byteLength === output.buffer.byteLength
    ) ?
      output.buffer
    : Uint8Array.from(output).buffer
  post({ output: transferable, type: "result" }, transferable)
}

const hasIsolatedRuntimeEnvironment = (): boolean =>
  [
    "COPILOT_API_HOME",
    "COPILOT_ZSTD_OUTER_ISOLATED",
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ].every((name) => Boolean(process.env[name]))

void run()
  .catch((error: unknown) => {
    const code =
      error instanceof ZstdRuntimeUnavailableError ?
        "decoder_unavailable"
      : "invalid_zstd"
    post({
      code,
      message:
        code === "decoder_unavailable" ?
          "Bounded zstd decoder is unavailable."
        : "Failed to decompress zstd request body.",
      type: "error",
    })
  })
  .finally(() => parentPort?.close())
