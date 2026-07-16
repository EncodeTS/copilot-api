import { parentPort } from "node:worker_threads"

import { ENCODING_MAP, type SupportedEncoding } from "~/lib/tokenizer-encodings"

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
