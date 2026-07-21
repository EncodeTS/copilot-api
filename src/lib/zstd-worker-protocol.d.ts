export type ZstdWorkerDecoder = "native" | "wasm" | "zero"

export interface ZstdWorkerInput {
  compressed: ArrayBuffer
  decoderPreference?: "auto" | "wasm"
  expectedDecodedBytes: number
}

export type ZstdWorkerOutput =
  | {
      decoder: ZstdWorkerDecoder
      isolatedEnvironment?: boolean
      type: "active"
    }
  | {
      output: ArrayBuffer
      type: "result"
    }
  | {
      code: "decoder_unavailable" | "invalid_zstd"
      message: string
      type: "error"
    }
