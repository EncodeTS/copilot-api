import type { ZstdWorkerDecoder } from "~/lib/zstd-worker-protocol"
import { admitSingleZstdFrame } from "~/lib/zstd-frame"

export type ZstdDecoderPreference = "auto" | "wasm"

type NativeZstdModule = {
  zstdDecompressSync: (
    input: Uint8Array,
    options: { maxOutputLength: number },
  ) => Uint8Array
}

type WasmZstdDecoder = {
  decompress(input: Uint8Array): Uint8Array
}

type WasmZstdModule = {
  load(): Promise<WasmZstdDecoder>
}

export interface ZstdRuntimeDependencies {
  loadNative(): Promise<NativeZstdModule | null>
  loadWasm(): Promise<WasmZstdModule>
}

export interface ZstdRuntimeOptions {
  decodedBytes: number
  decoderPreference: ZstdDecoderPreference
  onActive?: (decoder: ZstdWorkerDecoder) => void
}

export class ZstdRuntimeUnavailableError extends Error {
  code = "decoder_unavailable"

  constructor() {
    super("Bounded zstd decoder is unavailable.")
    this.name = "ZstdRuntimeUnavailableError"
  }
}

export const decodeZstdInRuntime = async (
  compressed: Uint8Array,
  options: ZstdRuntimeOptions,
  dependencies: ZstdRuntimeDependencies = defaultDependencies,
): Promise<Uint8Array> => {
  const admission = admitSingleZstdFrame(compressed, options.decodedBytes)
  if (admission.decodedBytes !== options.decodedBytes) {
    throw new Error("Zstandard decoded size does not match runtime admission.")
  }
  if (admission.zeroOutputProven) {
    options.onActive?.("zero")
    return new Uint8Array()
  }

  if (options.decoderPreference === "auto") {
    const native = await dependencies.loadNative().catch(() => null)
    if (native !== null) {
      options.onActive?.("native")
      // Native one-shot requires a positive maxOutputLength even for a valid
      // FCS=0 frame. Admission still requires and validates actual output 0.
      const output = native.zstdDecompressSync(compressed, {
        maxOutputLength: Math.max(1, options.decodedBytes),
      })
      assertDecodedSize(output, options.decodedBytes)
      return output
    }
  }

  let wasmModule: WasmZstdModule
  let decoder: WasmZstdDecoder
  try {
    wasmModule = await dependencies.loadWasm()
    decoder = await wasmModule.load()
  } catch {
    throw new ZstdRuntimeUnavailableError()
  }

  options.onActive?.("wasm")
  // The admitted frame has an explicit FCS. The WASM implementation uses its
  // exact-size one-shot path, including FCS=0, and never guesses an output cap.
  const output = decoder.decompress(compressed)
  assertDecodedSize(output, options.decodedBytes)
  return output
}

const assertDecodedSize = (output: Uint8Array, expectedBytes: number): void => {
  if (output.byteLength !== expectedBytes) {
    throw new Error("Zstandard decoded size does not match frame content size.")
  }
}

const defaultDependencies: ZstdRuntimeDependencies = {
  async loadNative() {
    const nodeZlib = (await import("node:zlib")) as {
      zstdDecompressSync?: NativeZstdModule["zstdDecompressSync"]
    }
    return nodeZlib.zstdDecompressSync === undefined ?
        null
      : { zstdDecompressSync: nodeZlib.zstdDecompressSync }
  },
  async loadWasm() {
    const { Zstd } = await import("@hpcc-js/wasm-zstd")
    return { load: () => Zstd.load() }
  },
}
