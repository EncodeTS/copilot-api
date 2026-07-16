import { parentPort } from "node:worker_threads"

const ENCODING_MAP = {
  o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
  cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
  p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
  p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
  r50k_base: () => import("gpt-tokenizer/encoding/r50k_base"),
} as const

type SupportedEncoding = keyof typeof ENCODING_MAP

interface TokenizerWorkerRequest {
  encoding: SupportedEncoding
  id: number
  texts: Array<string>
}

if (!parentPort) {
  throw new Error("Tokenizer worker requires a parent port")
}
const port = parentPort

port.on("message", async (request: TokenizerWorkerRequest) => {
  try {
    const encoder = await ENCODING_MAP[request.encoding]()
    port.postMessage({
      counts: request.texts.map((text) => encoder.encode(text).length),
      id: request.id,
    })
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id: request.id,
    })
  }
})
