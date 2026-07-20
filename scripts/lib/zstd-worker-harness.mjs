import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Worker } from "node:worker_threads"

const payloadFixture = Buffer.from("KLUv/SALWQAAeyJvayI6dHJ1ZX0=", "base64")
const payloadExpected = Buffer.from('{"ok":true}')
const emptyFixture = Buffer.from("KLUv/SAAAQAA", "base64")

export function createIsolatedRuntimeEnvironment(label = "zstd-runtime") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `copilot-api-${label}-`))
  const environment = {
    ...process.env,
    COPILOT_API_HOME: path.join(root, "copilot-api"),
    COPILOT_ZSTD_OUTER_ISOLATED: "1",
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  }
  for (const directory of [
    environment.COPILOT_API_HOME,
    environment.HOME,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
  ]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  return { environment, root }
}

export async function runZstdWorkerContract({
  decoderPreference = "auto",
  environment = process.env,
  workerUrl,
}) {
  const successMessages = await runWorker({
    decoderPreference,
    environment,
    expectedDecodedBytes: payloadExpected.byteLength,
    fixture: payloadFixture,
    workerUrl,
  })
  const active = successMessages.find((message) => message.type === "active")
  const result = successMessages.find((message) => message.type === "result")
  if (!active || !result) {
    throw new Error("zstd worker did not emit active and result messages")
  }
  const output = Buffer.from(result.output)
  if (!output.equals(payloadExpected)) {
    throw new Error("zstd worker output mismatch")
  }

  const emptyMessages = await runWorker({
    decoderPreference,
    environment,
    expectedDecodedBytes: 0,
    fixture: emptyFixture,
    workerUrl,
  })
  const emptyActive = emptyMessages.find((message) => message.type === "active")
  const emptyResult = emptyMessages.find((message) => message.type === "result")
  if (!emptyActive || !emptyResult || emptyResult.output.byteLength !== 0) {
    throw new Error("zstd worker did not preserve a valid FCS=0 frame")
  }

  const capPlusOneMessages = await runWorker({
    decoderPreference,
    environment,
    expectedDecodedBytes: payloadExpected.byteLength - 1,
    fixture: payloadFixture,
    workerUrl,
  })
  const capZeroMessages = await runWorker({
    decoderPreference,
    environment,
    expectedDecodedBytes: 0,
    fixture: payloadFixture,
    workerUrl,
  })

  return {
    capPlusOneFailedClosed: failedBeforeActive(capPlusOneMessages),
    capZeroRejectedNonEmpty: failedBeforeActive(capZeroMessages),
    decodedBytes: output.byteLength,
    decoder: active.decoder,
    emptyDecodedBytes: emptyResult.output.byteLength,
    maxEmittedChunkBytes: output.byteLength,
    workerIsolatedEnvironment:
      active.isolatedEnvironment === true &&
      emptyActive.isolatedEnvironment === true,
  }
}

async function runWorker({
  decoderPreference,
  environment,
  expectedDecodedBytes,
  fixture,
  workerUrl,
}) {
  const transferable = fixture.buffer.slice(
    fixture.byteOffset,
    fixture.byteOffset + fixture.byteLength,
  )
  const worker = new Worker(workerUrl, {
    env: environment,
    execArgv: [],
    transferList: [transferable],
    workerData: {
      compressed: transferable,
      decoderPreference,
      expectedDecodedBytes,
    },
  })
  const messages = []
  worker.on("message", (message) => messages.push(message))
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      void worker.terminate()
      reject(new Error("zstd worker contract timed out"))
    }, 30_000)
    worker.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    worker.once("exit", (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
  if (exitCode !== 0) {
    throw new Error(`zstd worker exited with ${exitCode}`)
  }
  return messages
}

function failedBeforeActive(messages) {
  return (
    !messages.some((message) => message.type === "active") &&
    messages.some((message) => message.type === "error")
  )
}
