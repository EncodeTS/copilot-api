import { expect, test } from "bun:test"

import type {
  ZstdWorkerDecoder,
  ZstdWorkerInput,
  ZstdWorkerOutput,
} from "../src/lib/zstd-worker-protocol"
import { ZstdRuntimeUnavailableError } from "../src/lib/zstd-runtime"
import { runZstdWorker } from "../src/zstd-worker"

const payloadFixture = Uint8Array.from(
  Buffer.from("KLUv/SALWQAAeyJvayI6dHJ1ZX0=", "base64"),
)
const payloadOutput = Uint8Array.from(Buffer.from('{"ok":true}'))

interface PostedMessage {
  message: ZstdWorkerOutput
  transfer: readonly ArrayBuffer[]
}

const createPort = () => {
  const messages: PostedMessage[] = []
  let closeCount = 0
  return {
    close(): void {
      closeCount += 1
    },
    get closeCount(): number {
      return closeCount
    },
    messages,
    postMessage(
      message: ZstdWorkerOutput,
      transfer: readonly ArrayBuffer[] = [],
    ): void {
      messages.push({ message, transfer })
    },
  }
}

const createInput = (
  compressed: Uint8Array = payloadFixture,
  expectedDecodedBytes = payloadOutput.byteLength,
): ZstdWorkerInput => ({
  compressed: compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer,
  expectedDecodedBytes,
})

test("worker runner announces its active decoder before returning decoded bytes", async () => {
  const port = createPort()

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("wasm")
      return Promise.resolve(payloadOutput)
    },
    environment: isolatedEnvironment,
    input: createInput(),
    port,
  })

  expect(port.messages.map(({ message }) => message.type)).toEqual([
    "active",
    "result",
  ])
  expect(port.messages[0]?.message).toEqual({
    decoder: "wasm" satisfies ZstdWorkerDecoder,
    isolatedEnvironment: true,
    type: "active",
  })
  expect(
    Buffer.from(
      (
        port.messages[1]?.message as Extract<
          ZstdWorkerOutput,
          { type: "result" }
        >
      ).output,
    ).toString(),
  ).toBe('{"ok":true}')
  const result = port.messages[1]?.message as Extract<
    ZstdWorkerOutput,
    { type: "result" }
  >
  expect(result.output).toBe(payloadOutput.buffer)
  expect(port.messages[0]?.transfer).toHaveLength(0)
  expect(port.messages[1]?.transfer).toEqual([result.output])
  expect(port.closeCount).toBe(1)
})

test("worker runner copies a sliced decoder view into one exact transferable", async () => {
  const port = createPort()
  const backing = Uint8Array.from([0, ...payloadOutput, 0])
  const slicedOutput = backing.subarray(1, backing.byteLength - 1)

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("native")
      return Promise.resolve(slicedOutput)
    },
    environment: isolatedEnvironment,
    input: createInput(),
    port,
  })

  const result = port.messages[1]?.message as Extract<
    ZstdWorkerOutput,
    { type: "result" }
  >
  expect(result.output).not.toBe(backing.buffer)
  expect(Buffer.from(result.output).toString()).toBe('{"ok":true}')
  expect(port.messages[1]?.transfer).toEqual([result.output])
  expect(port.closeCount).toBe(1)
})

test("worker runner reports a missing isolation marker without reading global env", async () => {
  const port = createPort()

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("wasm")
      return Promise.resolve(payloadOutput)
    },
    environment: { ...isolatedEnvironment, XDG_STATE_HOME: undefined },
    input: createInput(),
    port,
  })

  expect(port.messages[0]?.message).toEqual({
    decoder: "wasm",
    isolatedEnvironment: false,
    type: "active",
  })
  expect(port.messages[1]?.message.type).toBe("result")
  expect(port.closeCount).toBe(1)
})

test("worker runner rejects malformed and cap-mismatched frames before decoding", async () => {
  const inputs = [
    createInput(payloadFixture, payloadOutput.byteLength + 1),
    createInput(payloadFixture, payloadOutput.byteLength - 1),
    createInput(Uint8Array.from([0, 1, 2, 3])),
  ]

  for (const input of inputs) {
    const port = createPort()
    let decodeCount = 0
    await runZstdWorker({
      decode: () => {
        decodeCount += 1
        return Promise.resolve(payloadOutput)
      },
      environment: isolatedEnvironment,
      input,
      port,
    })

    expect(decodeCount).toBe(0)
    expect(port.messages).toHaveLength(1)
    expect(port.messages[0]?.message).toMatchObject({
      code: "invalid_zstd",
      type: "error",
    })
    expect(port.messages[0]?.transfer).toHaveLength(0)
    expect(port.closeCount).toBe(1)
  }
})

test("worker runner fails closed when decoder output differs from frame admission", async () => {
  const port = createPort()

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("native")
      return Promise.resolve(
        payloadOutput.subarray(0, payloadOutput.byteLength - 1),
      )
    },
    environment: isolatedEnvironment,
    input: createInput(),
    port,
  })

  expect(port.messages.map(({ message }) => message.type)).toEqual([
    "active",
    "error",
  ])
  expect(port.messages.at(-1)?.message).toEqual({
    code: "invalid_zstd",
    message: "Failed to decompress zstd request body.",
    type: "error",
  })
  expect(
    port.messages.every(({ transfer }) => transfer.length === 0),
  ).toBeTrue()
  expect(port.closeCount).toBe(1)
})

test("worker runner never emits a result before decoder activation", async () => {
  const port = createPort()

  await runZstdWorker({
    decode: () => Promise.resolve(payloadOutput),
    environment: isolatedEnvironment,
    input: createInput(),
    port,
  })

  expect(port.messages.map(({ message }) => message.type)).toEqual(["error"])
  expect(port.messages[0]?.message).toMatchObject({
    code: "invalid_zstd",
    type: "error",
  })
  expect(port.closeCount).toBe(1)
})

test("worker runner distinguishes unavailable decoders from invalid zstd", async () => {
  const cases = [
    {
      code: "decoder_unavailable",
      error: new ZstdRuntimeUnavailableError(),
      message: "Bounded zstd decoder is unavailable.",
    },
    {
      code: "invalid_zstd",
      error: new Error("decoder rejected input"),
      message: "Failed to decompress zstd request body.",
    },
  ] as const

  for (const expected of cases) {
    const port = createPort()
    await runZstdWorker({
      decode: () => Promise.reject(expected.error),
      environment: isolatedEnvironment,
      input: createInput(),
      port,
    })

    expect(port.messages).toEqual([
      {
        message: {
          code: expected.code,
          message: expected.message,
          type: "error",
        },
        transfer: [],
      },
    ])
    expect(port.closeCount).toBe(1)
  }
})

test("worker runner permits only one decoder activation and closes once", async () => {
  const port = createPort()

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("native")
      options.onActive?.("wasm")
      return Promise.resolve(payloadOutput)
    },
    environment: isolatedEnvironment,
    input: createInput(),
    port,
  })

  expect(port.messages.map(({ message }) => message.type)).toEqual([
    "active",
    "error",
  ])
  expect(port.messages[0]?.message).toMatchObject({ decoder: "native" })
  expect(port.messages[1]?.message).toMatchObject({ code: "invalid_zstd" })
  expect(
    port.messages.every(({ transfer }) => transfer.length === 0),
  ).toBeTrue()
  expect(port.closeCount).toBe(1)
})

test("worker runner is inert when parentPort is absent", async () => {
  let decodeCount = 0

  await runZstdWorker({
    decode: () => {
      decodeCount += 1
      return Promise.reject(new Error("must not decode"))
    },
    input: createInput(),
    port: null,
  })
  expect(decodeCount).toBe(0)
})

test("worker runner contains error-reporting and close failures", async () => {
  let closeCount = 0
  let postCount = 0

  await runZstdWorker({
    decode: () => Promise.reject(new Error("invalid compressed body")),
    environment: isolatedEnvironment,
    input: createInput(),
    port: {
      close(): void {
        closeCount += 1
        throw new Error("close failed")
      },
      postMessage(): void {
        postCount += 1
        throw new Error("post failed")
      },
    },
  })

  expect(postCount).toBe(1)
  expect(closeCount).toBe(1)
})

test("worker runner reports one error when the result transfer fails", async () => {
  const attempts: PostedMessage[] = []
  let closeCount = 0

  await runZstdWorker({
    decode: (_compressed, options) => {
      options.onActive?.("native")
      return Promise.resolve(payloadOutput)
    },
    environment: isolatedEnvironment,
    input: createInput(),
    port: {
      close(): void {
        closeCount += 1
      },
      postMessage(
        message: ZstdWorkerOutput,
        transfer: readonly ArrayBuffer[] = [],
      ): void {
        attempts.push({ message, transfer })
        if (message.type === "result") {
          throw new Error("transfer failed")
        }
      },
    },
  })

  expect(attempts.map(({ message }) => message.type)).toEqual([
    "active",
    "result",
    "error",
  ])
  expect(attempts[1]?.transfer).toHaveLength(1)
  expect(attempts[2]?.message).toMatchObject({
    code: "invalid_zstd",
    type: "error",
  })
  expect(closeCount).toBe(1)
})

const isolatedEnvironment = {
  COPILOT_API_HOME: "/isolated/copilot-api",
  COPILOT_ZSTD_OUTER_ISOLATED: "1",
  HOME: "/isolated/home",
  XDG_CACHE_HOME: "/isolated/cache",
  XDG_CONFIG_HOME: "/isolated/config",
  XDG_DATA_HOME: "/isolated/data",
  XDG_STATE_HOME: "/isolated/state",
}
