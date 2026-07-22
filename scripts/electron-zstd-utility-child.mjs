import path from "node:path"
import { pathToFileURL } from "node:url"

import { runZstdWorkerContract } from "./lib/zstd-worker-harness.mjs"

const serverDir = path.resolve(process.argv[2])
const workerUrl = pathToFileURL(path.join(serverDir, "zstd-worker.js"))
const send = (message) => {
  if (process.parentPort) {
    process.parentPort.postMessage(message)
  } else {
    console.log(JSON.stringify(message))
  }
}

try {
  const result = await runZstdWorkerContract({ workerUrl })
  send({
    ...result,
    failClosed: result.capPlusOneFailedClosed && result.capZeroRejectedNonEmpty,
    happy: result.decodedBytes > 0 && result.emptyDecodedBytes === 0,
    isolatedEnvironment:
      process.env.COPILOT_ZSTD_OUTER_ISOLATED === "1" &&
      Boolean(process.env.COPILOT_API_HOME) &&
      Boolean(process.env.XDG_CONFIG_HOME) &&
      result.workerIsolatedEnvironment,
    type: "zstd-smoke-result",
  })
} catch (error) {
  send({
    message: error instanceof Error ? error.message : String(error),
    type: "zstd-smoke-error",
  })
}
