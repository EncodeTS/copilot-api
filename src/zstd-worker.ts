import { parentPort, workerData } from "node:worker_threads"

import { admitSingleZstdFrame } from "~/lib/zstd-frame"
import {
  decodeZstdInRuntime,
  ZstdRuntimeUnavailableError,
} from "~/lib/zstd-runtime"
import type { ZstdRuntimeOptions } from "~/lib/zstd-runtime"
import type {
  ZstdWorkerInput,
  ZstdWorkerOutput,
} from "~/lib/zstd-worker-protocol"

export type ZstdWorkerDecode = (
  compressed: Uint8Array,
  options: ZstdRuntimeOptions,
) => Promise<Uint8Array>

export interface ZstdWorkerPort {
  close(): void
  postMessage(
    message: ZstdWorkerOutput,
    transferList?: readonly ArrayBuffer[],
  ): void
}

export interface ZstdWorkerRunnerOptions {
  decode?: ZstdWorkerDecode
  environment?: Readonly<Record<string, string | undefined>>
  input?: ZstdWorkerInput
  port?: ZstdWorkerPort | null
}

export const runZstdWorker = async (
  options: ZstdWorkerRunnerOptions = {},
): Promise<void> => {
  const port = options.port === undefined ? parentPort : options.port
  if (port === null) {
    return
  }

  try {
    const input = options.input ?? (workerData as ZstdWorkerInput)
    const compressed = new Uint8Array(input.compressed)
    const admission = admitSingleZstdFrame(
      compressed,
      input.expectedDecodedBytes,
    )
    if (admission.decodedBytes !== input.expectedDecodedBytes) {
      throw new Error("Zstandard decoded size does not match worker admission.")
    }

    let activationCount = 0
    const output = await (options.decode ?? decodeZstdInRuntime)(compressed, {
      decodedBytes: admission.decodedBytes,
      decoderPreference: input.decoderPreference ?? "auto",
      onActive: (decoder) => {
        activationCount += 1
        if (activationCount !== 1) {
          throw new Error("Zstandard decoder activated more than once.")
        }
        port.postMessage({
          decoder,
          isolatedEnvironment: hasIsolatedRuntimeEnvironment(
            options.environment ?? process.env,
          ),
          type: "active",
        })
      },
    })
    if (activationCount !== 1) {
      throw new Error("Zstandard decoder did not report activation.")
    }
    if (output.byteLength !== admission.decodedBytes) {
      throw new Error("Zstandard decoded size does not match worker admission.")
    }
    const transferable =
      (
        output.buffer instanceof ArrayBuffer
        && output.byteOffset === 0
        && output.byteLength === output.buffer.byteLength
      ) ?
        output.buffer
      : Uint8Array.from(output).buffer
    port.postMessage({ output: transferable, type: "result" }, [transferable])
  } catch (error: unknown) {
    const code =
      error instanceof ZstdRuntimeUnavailableError ?
        "decoder_unavailable"
      : "invalid_zstd"
    try {
      port.postMessage({
        code,
        message:
          code === "decoder_unavailable" ?
            "Bounded zstd decoder is unavailable."
          : "Failed to decompress zstd request body.",
        type: "error",
      })
    } catch {
      // A failed parent channel cannot carry a second diagnostic. Closing the
      // port is the only remaining fail-closed action.
    }
  } finally {
    try {
      port.close()
    } catch {
      // A close failure has no remaining recovery channel. One cleanup
      // attempt still avoids an unhandled worker rejection.
    }
  }
}

const hasIsolatedRuntimeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean =>
  [
    "COPILOT_API_HOME",
    "COPILOT_ZSTD_OUTER_ISOLATED",
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ].every((name) => Boolean(environment[name]))

void runZstdWorker()
